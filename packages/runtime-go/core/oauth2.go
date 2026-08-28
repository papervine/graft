package core

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// OAuth2 token acquisition.
//
// Only the flows an SDK can honestly own (SPEC.md §3.1.6): client credentials, where the SDK holds the
// credentials and is entirely responsible, and refreshing a token the caller obtained elsewhere. The
// authorization-code redirect needs a browser and a human, so it stays the application's job.
//
// The token request is the easy part. What earns this file are the three things around it:
// single-flight refresh, proactive expiry, and retrying a 401 exactly once.
//
// Go's single-flight is shaped differently from the other runtimes. There is no promise to hand a
// second caller, so waiters block on a channel that the one in-flight fetch closes — which also gives
// context cancellation somewhere to hook into, something a plain mutex would not.

// OAuth2Flow identifies which grant the SDK uses.
type OAuth2Flow string

const (
	// FlowClientCredentials is machine-to-machine: the SDK holds the id and secret.
	FlowClientCredentials OAuth2Flow = "client_credentials"
	// FlowRefreshToken keeps a token the caller obtained elsewhere current.
	FlowRefreshToken OAuth2Flow = "refresh_token"
)

// OAuth2ClientAuth is where the client credentials go.
//
// RFC 6749 requires servers to support the header form and says the body form *may* be supported, so
// the header is the default — but real servers get this wrong in both directions, which is why it is
// an option rather than a constant.
type OAuth2ClientAuth string

const (
	ClientAuthBasic OAuth2ClientAuth = "basic"
	ClientAuthBody  OAuth2ClientAuth = "body"
)

// OAuth2Config describes how the SDK obtains a token.
type OAuth2Config struct {
	Flow         OAuth2Flow
	TokenURL     string
	ClientID     string
	ClientSecret string
	RefreshToken string
	Scopes       []string
	// ClientAuth defaults to ClientAuthBasic.
	ClientAuth  OAuth2ClientAuth
	ExtraParams map[string]string
}

// expirySkew is how early a token is treated as expired.
//
// Refreshing only once a token has *already* expired guarantees at least one failed request first.
// Thirty seconds covers ordinary clock skew and the time a request spends in flight.
const expirySkew = 30 * time.Second

// OAuth2Error is returned when the authorization server refuses to issue a token.
//
// Deliberately not an *APIError: this is a different service with different failure semantics, and a
// caller handling a 4xx from the API must not catch it by accident.
type OAuth2Error struct {
	Message string
	// Status from the token endpoint. Zero when it was unreachable.
	Status int
	// Code is the RFC 6749 `error` value, e.g. `invalid_client`.
	Code string
}

func (e *OAuth2Error) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("%s (%s, status %d)", e.Message, e.Code, e.Status)
	}
	return fmt.Sprintf("%s (status %d)", e.Message, e.Status)
}

func (e *OAuth2Error) sdkError() {}

type cachedToken struct {
	accessToken string
	// usableUntil is the zero time when the server declared no expiry.
	usableUntil  time.Time
	refreshToken string
}

func (t *cachedToken) expired() bool {
	return !t.usableUntil.IsZero() && !time.Now().Before(t.usableUntil)
}

// TokenSource acquires and caches OAuth2 tokens.
//
// One instance per client, so a client shared across handlers shares one token rather than fetching
// one per call. Safe for concurrent use.
type TokenSource struct {
	config     OAuth2Config
	httpClient *http.Client

	mu     sync.Mutex
	cached *cachedToken
	// inFlight is non-nil while a fetch is running, and is closed when it finishes.
	//
	// This is the single-flight mechanism. Ten concurrent goroutines on a cold client must produce
	// **one** token request: without it, the first thing a new SDK does under load is hammer the
	// authorization server, and the symptom is unexplained 429s from a host nobody configured.
	//
	// A channel rather than sync.Once, because a fetch can *fail* and must be retriable — Once would
	// permanently cache the failure. A channel rather than holding the mutex across the request,
	// because a waiter needs to be able to abandon the wait when its context is cancelled.
	inFlight chan struct{}
	// fetchErr is the result of the in-flight fetch, readable once inFlight is closed.
	fetchErr error
}

// NewTokenSource builds a TokenSource. A nil httpClient uses http.DefaultClient.
func NewTokenSource(config OAuth2Config, httpClient *http.Client) *TokenSource {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	if config.ClientAuth == "" {
		config.ClientAuth = ClientAuthBasic
	}
	return &TokenSource{config: config, httpClient: httpClient}
}

// Token returns a usable access token, fetching or refreshing only when necessary.
func (s *TokenSource) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	if s.cached != nil && !s.cached.expired() {
		token := s.cached.accessToken
		s.mu.Unlock()
		return token, nil
	}
	s.mu.Unlock()
	return s.refresh(ctx)
}

// ForceRefresh discards the cached token and fetches a new one.
//
// Called on a 401 as well as on expiry, because expiry arithmetic is necessary but not sufficient —
// clocks disagree and servers revoke tokens early.
func (s *TokenSource) ForceRefresh(ctx context.Context) (string, error) {
	s.mu.Lock()
	s.cached = nil
	s.mu.Unlock()
	return s.refresh(ctx)
}

func (s *TokenSource) refresh(ctx context.Context) (string, error) {
	s.mu.Lock()

	// Re-checked under the lock: a caller that arrived just after another goroutine's fetch completed
	// should use its result rather than starting another.
	if s.cached != nil && !s.cached.expired() {
		token := s.cached.accessToken
		s.mu.Unlock()
		return token, nil
	}

	if wait := s.inFlight; wait != nil {
		s.mu.Unlock()
		select {
		case <-wait:
			// The fetch finished. Read its outcome under the lock.
			s.mu.Lock()
			err := s.fetchErr
			var token string
			if s.cached != nil {
				token = s.cached.accessToken
			}
			s.mu.Unlock()
			if err != nil {
				return "", err
			}
			if token == "" {
				return "", &OAuth2Error{Message: "token refresh produced no token", Status: 0}
			}
			return token, nil
		case <-ctx.Done():
			// Abandoning the wait does not cancel the fetch: another caller may still want it, and a
			// cancelled context here is this caller's decision, not a failure of the token source.
			return "", &ConnectionError{Message: "cancelled while waiting for a token", Cause: ctx.Err()}
		}
	}

	// This goroutine owns the fetch.
	done := make(chan struct{})
	s.inFlight = done
	s.fetchErr = nil
	previous := s.cached
	s.mu.Unlock()

	token, err := s.request(ctx, previous)

	s.mu.Lock()
	if err == nil {
		s.cached = token
	}
	s.fetchErr = err
	s.inFlight = nil
	s.mu.Unlock()
	// Closed after the state is published, so a waiter that wakes sees the result rather than racing
	// with the write.
	close(done)

	if err != nil {
		return "", err
	}
	return token.accessToken, nil
}

func (s *TokenSource) request(ctx context.Context, previous *cachedToken) (*cachedToken, error) {
	form := url.Values{}
	switch s.config.Flow {
	case FlowClientCredentials:
		form.Set("grant_type", "client_credentials")
	case FlowRefreshToken:
		form.Set("grant_type", "refresh_token")
		// The rotated token when the server issued one, otherwise the caller's original. A server
		// that rotates refresh tokens invalidates the old one, so reusing it would fail on the
		// *second* refresh — a bug that only appears after a token lifetime has elapsed.
		refresh := s.config.RefreshToken
		if previous != nil && previous.refreshToken != "" {
			refresh = previous.refreshToken
		}
		if refresh == "" {
			return nil, &OAuth2Error{Message: "no refresh token available", Status: 0}
		}
		form.Set("refresh_token", refresh)
	default:
		return nil, &OAuth2Error{
			Message: fmt.Sprintf("unsupported OAuth2 flow %q", s.config.Flow),
			Status:  0,
		}
	}

	if len(s.config.Scopes) > 0 {
		form.Set("scope", strings.Join(s.config.Scopes, " "))
	}
	for key, value := range s.config.ExtraParams {
		form.Set(key, value)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.config.TokenURL,
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, &OAuth2Error{Message: "building the token request: " + err.Error(), Status: 0}
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	if s.config.ClientID != "" {
		if s.config.ClientAuth == ClientAuthBasic {
			credentials := s.config.ClientID + ":" + s.config.ClientSecret
			req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(credentials)))
		} else {
			form.Set("client_id", s.config.ClientID)
			if s.config.ClientSecret != "" {
				form.Set("client_secret", s.config.ClientSecret)
			}
			// Rebuilt because the body was already encoded above.
			req.Body = io.NopCloser(strings.NewReader(form.Encode()))
			req.ContentLength = int64(len(form.Encode()))
		}
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, &OAuth2Error{
			Message: "could not reach the token endpoint at " + s.config.TokenURL,
			Status:  0,
		}
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrBody))

	var payload struct {
		AccessToken      string  `json:"access_token"`
		RefreshToken     string  `json:"refresh_token"`
		ExpiresIn        float64 `json:"expires_in"`
		Error            string  `json:"error"`
		ErrorDescription string  `json:"error_description"`
	}
	_ = json.Unmarshal(body, &payload)

	if resp.StatusCode >= 400 {
		// Never retried. A 400 from a token endpoint means the credentials are wrong, and retrying it
		// is both pointless and indistinguishable from a brute-force attempt.
		message := payload.ErrorDescription
		if message == "" {
			message = payload.Error
		}
		if message == "" {
			message = fmt.Sprintf("the token endpoint returned %d", resp.StatusCode)
		}
		return nil, &OAuth2Error{Message: message, Status: resp.StatusCode, Code: payload.Error}
	}

	if payload.AccessToken == "" {
		return nil, &OAuth2Error{
			Message: "the token endpoint returned no access_token",
			Status:  resp.StatusCode,
		}
	}

	token := &cachedToken{accessToken: payload.AccessToken, refreshToken: payload.RefreshToken}
	if token.refreshToken == "" && previous != nil {
		// A server that does not rotate keeps the previous value usable.
		token.refreshToken = previous.refreshToken
	}
	if payload.ExpiresIn > 0 {
		lifetime := time.Duration(payload.ExpiresIn * float64(time.Second))
		if lifetime > expirySkew {
			lifetime -= expirySkew
		} else {
			lifetime = 0
		}
		token.usableUntil = time.Now().Add(lifetime)
	}
	return token, nil
}
