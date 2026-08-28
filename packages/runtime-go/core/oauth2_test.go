package core

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// The token request is barely worth testing. These cover the three things around it that are easy to
// get wrong and expensive when wrong (SPEC.md §3.1.6): single-flight refresh, proactive expiry, and
// retrying a 401 exactly once.

func tokenServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request, call int)) (string, *int) {
	t.Helper()
	var mu sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		call := calls
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		handler(w, r, call)
	}))
	t.Cleanup(server.Close)
	return server.URL, &calls
}

func TestTokenRequestSendsClientCredentialsWithBasicAuth(t *testing.T) {
	var gotAuth, gotBody string
	tokenURL, _ := tokenServer(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		gotAuth = r.Header.Get("Authorization")
		body := make([]byte, 512)
		n, _ := r.Body.Read(body)
		gotBody = string(body[:n])
		_, _ = w.Write([]byte(`{"access_token":"tok_1","expires_in":3600}`))
	})

	source := NewTokenSource(OAuth2Config{
		Flow: FlowClientCredentials, TokenURL: tokenURL, ClientID: "id", ClientSecret: "secret",
	}, nil)

	token, err := source.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if token != "tok_1" {
		t.Errorf("token = %q", token)
	}
	if !strings.HasPrefix(gotAuth, "Basic ") {
		t.Errorf("Authorization = %q, want the header form (RFC 6749 requires servers to accept it)", gotAuth)
	}
	if !strings.Contains(gotBody, "grant_type=client_credentials") {
		t.Errorf("body = %q", gotBody)
	}
	// The credentials must not also appear in the body.
	if strings.Contains(gotBody, "client_secret") {
		t.Error("the secret was sent in both the header and the body")
	}
}

func TestTokenRequestCanSendCredentialsInTheBody(t *testing.T) {
	var gotAuth, gotBody string
	tokenURL, _ := tokenServer(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		gotAuth = r.Header.Get("Authorization")
		body := make([]byte, 512)
		n, _ := r.Body.Read(body)
		gotBody = string(body[:n])
		_, _ = w.Write([]byte(`{"access_token":"t"}`))
	})
	source := NewTokenSource(OAuth2Config{
		Flow: FlowClientCredentials, TokenURL: tokenURL, ClientID: "id", ClientSecret: "secret",
		ClientAuth: ClientAuthBody,
	}, nil)
	if _, err := source.Token(context.Background()); err != nil {
		t.Fatalf("Token: %v", err)
	}
	if gotAuth != "" {
		t.Errorf("Authorization = %q, want empty", gotAuth)
	}
	if !strings.Contains(gotBody, "client_id=id") {
		t.Errorf("body = %q", gotBody)
	}
}

func TestTokenRequestSendsScopesSpaceSeparated(t *testing.T) {
	var gotScope string
	tokenURL, _ := tokenServer(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		body := make([]byte, 512)
		n, _ := r.Body.Read(body)
		// Parsed rather than string-matched: form encoding turns a space into `+`.
		values, _ := url.ParseQuery(string(body[:n]))
		gotScope = values.Get("scope")
		_, _ = w.Write([]byte(`{"access_token":"t"}`))
	})
	source := NewTokenSource(OAuth2Config{
		Flow: FlowClientCredentials, TokenURL: tokenURL, ClientID: "id",
		Scopes: []string{"read:widgets", "write:widgets"},
	}, nil)
	if _, err := source.Token(context.Background()); err != nil {
		t.Fatalf("Token: %v", err)
	}
	if gotScope != "read:widgets write:widgets" {
		t.Errorf("scope = %q", gotScope)
	}
}

func TestTokenIsReusedWhileValid(t *testing.T) {
	tokenURL, calls := tokenServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{"access_token":"tok","expires_in":3600}`))
	})
	source := NewTokenSource(OAuth2Config{Flow: FlowClientCredentials, TokenURL: tokenURL, ClientID: "id"}, nil)
	for i := 0; i < 3; i++ {
		if _, err := source.Token(context.Background()); err != nil {
			t.Fatalf("Token: %v", err)
		}
	}
	if *calls != 1 {
		t.Errorf("made %d token requests, want 1", *calls)
	}
}

func TestTokenRefreshesBeforeItActuallyExpires(t *testing.T) {
	// Refreshing only once a token has expired guarantees at least one failed request first. A
	// lifetime shorter than the 30s skew is already expired on arrival, which is what makes this
	// observable without manipulating the clock.
	tokenURL, calls := tokenServer(t, func(w http.ResponseWriter, _ *http.Request, call int) {
		_, _ = w.Write([]byte(`{"access_token":"tok_` + string(rune('0'+call)) + `","expires_in":10}`))
	})
	source := NewTokenSource(OAuth2Config{Flow: FlowClientCredentials, TokenURL: tokenURL, ClientID: "id"}, nil)
	first, err := source.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	second, err := source.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if first == second || *calls != 2 {
		t.Errorf("a token inside the safety margin was reused: %q then %q after %d calls", first, second, *calls)
	}
}

func TestNoExpiresInMeansLongLived(t *testing.T) {
	tokenURL, calls := tokenServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{"access_token":"tok"}`))
	})
	source := NewTokenSource(OAuth2Config{Flow: FlowClientCredentials, TokenURL: tokenURL, ClientID: "id"}, nil)
	for i := 0; i < 3; i++ {
		if _, err := source.Token(context.Background()); err != nil {
			t.Fatalf("Token: %v", err)
		}
	}
	// Nothing to expire against, so nothing to refresh.
	if *calls != 1 {
		t.Errorf("made %d token requests, want 1", *calls)
	}
}

func TestSingleFlightMakesOneRequestForManyGoroutines(t *testing.T) {
	// Without this, the first thing a new SDK does under load is hammer the authorization server, and
	// the symptom is unexplained 429s from a host the caller never configured.
	release := make(chan struct{})
	tokenURL, calls := tokenServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		<-release
		_, _ = w.Write([]byte(`{"access_token":"tok","expires_in":3600}`))
	})
	source := NewTokenSource(OAuth2Config{Flow: FlowClientCredentials, TokenURL: tokenURL, ClientID: "id"}, nil)

	var wg sync.WaitGroup
	tokens := make([]string, 10)
	errs := make([]error, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			tokens[index], errs[index] = source.Token(context.Background())
		}(i)
	}
	close(release)
	wg.Wait()

	if *calls != 1 {
		t.Errorf("made %d token requests, want 1", *calls)
	}
	for i, err := range errs {
		if err != nil {
			t.Fatalf("goroutine %d: %v", i, err)
		}
		if tokens[i] != "tok" {
			t.Errorf("goroutine %d got %q", i, tokens[i])
		}
	}
}

func TestAFailedFetchDoesNotPoisonLaterCalls(t *testing.T) {
	// A permanently cached failure — which sync.Once would give — would make every later call fail
	// with the same stale error long after the cause was fixed.
	var mu sync.Mutex
	failing := true
	tokenURL, _ := tokenServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		mu.Lock()
		shouldFail := failing
		mu.Unlock()
		if shouldFail {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":"temporarily_unavailable"}`))
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"tok"}`))
	})
	source := NewTokenSource(OAuth2Config{Flow: FlowClientCredentials, TokenURL: tokenURL, ClientID: "id"}, nil)

	if _, err := source.Token(context.Background()); err == nil {
		t.Fatal("expected the first fetch to fail")
	}
	mu.Lock()
	failing = false
	mu.Unlock()
	token, err := source.Token(context.Background())
	if err != nil {
		t.Fatalf("the second fetch inherited the first failure: %v", err)
	}
	if token != "tok" {
		t.Errorf("token = %q", token)
	}
}

func TestRefreshTokenFlowAdoptsARotatedToken(t *testing.T) {
	// A server that rotates refresh tokens invalidates the old one, so reusing it would fail on the
	// *second* refresh — a bug that only appears after a token lifetime has elapsed.
	var sent []string
	tokenURL, _ := tokenServer(t, func(w http.ResponseWriter, r *http.Request, call int) {
		body := make([]byte, 512)
		n, _ := r.Body.Read(body)
		values, _ := url.ParseQuery(string(body[:n]))
		sent = append(sent, values.Get("refresh_token"))
		n2 := string(rune('0' + call))
		_, _ = w.Write([]byte(`{"access_token":"a_` + n2 + `","refresh_token":"r_` + n2 + `","expires_in":10}`))
	})
	source := NewTokenSource(OAuth2Config{
		Flow: FlowRefreshToken, TokenURL: tokenURL, RefreshToken: "r_0",
	}, nil)

	if _, err := source.Token(context.Background()); err != nil {
		t.Fatalf("Token: %v", err)
	}
	if _, err := source.Token(context.Background()); err != nil {
		t.Fatalf("Token: %v", err)
	}
	if len(sent) != 2 || sent[0] != "r_0" || sent[1] != "r_1" {
		t.Errorf("refresh tokens sent = %v, want [r_0 r_1]", sent)
	}
}

func TestTokenFailureSurfacesTheServerCode(t *testing.T) {
	tokenURL, calls := tokenServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid_client","error_description":"bad secret"}`))
	})
	source := NewTokenSource(OAuth2Config{Flow: FlowClientCredentials, TokenURL: tokenURL, ClientID: "id"}, nil)
	_, err := source.Token(context.Background())

	var oauthErr *OAuth2Error
	if !errors.As(err, &oauthErr) {
		t.Fatalf("expected *OAuth2Error, got %T", err)
	}
	if oauthErr.Code != "invalid_client" || oauthErr.Message != "bad secret" || oauthErr.Status != 401 {
		t.Errorf("error = %+v", oauthErr)
	}
	// Never retried: a 400-class response means the credentials are wrong.
	if *calls != 1 {
		t.Errorf("made %d token requests, want 1", *calls)
	}
	// Not an APIError, so a caller handling a 4xx from the API does not catch it by accident.
	if _, ok := AsAPIError(err); ok {
		t.Error("a token failure presented as an APIError")
	}
	// Still an SDKError, so `errors.As(err, &sdkErr)` catches everything the SDK returns.
	var sdkErr SDKError
	if !errors.As(err, &sdkErr) {
		t.Error("a token failure is not an SDKError")
	}
}

func TestTokenFailureOnMissingAccessToken(t *testing.T) {
	tokenURL, _ := tokenServer(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		_, _ = w.Write([]byte(`{"token_type":"Bearer"}`))
	})
	source := NewTokenSource(OAuth2Config{Flow: FlowClientCredentials, TokenURL: tokenURL, ClientID: "id"}, nil)
	_, err := source.Token(context.Background())
	if err == nil || !strings.Contains(err.Error(), "no access_token") {
		t.Errorf("err = %v", err)
	}
}

// --- integration with the client's retry loop ---

func oauthClient(t *testing.T, apiStatuses []int) (*Client, *[]string) {
	t.Helper()
	var mu sync.Mutex
	var log []string
	tokens, apis := 0, 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "/token") {
			tokens++
			log = append(log, "token")
			_, _ = w.Write([]byte(`{"access_token":"tok"}`))
			return
		}
		status := http.StatusOK
		if apis < len(apiStatuses) {
			status = apiStatuses[apis]
		}
		apis++
		log = append(log, "api:"+http.StatusText(status))
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	source := NewTokenSource(OAuth2Config{
		Flow: FlowClientCredentials, TokenURL: server.URL + "/token", ClientID: "id",
	}, server.Client())
	client := NewClient(ClientOptions{
		BaseURL:    server.URL,
		Auth:       Auth{Kind: AuthOAuth2, Source: source},
		MaxRetries: -1,
		HTTPClient: server.Client(),
	})
	return client, &log
}

func TestA401ForcesOneRefreshAndRetriesOnce(t *testing.T) {
	// Clocks disagree and servers revoke tokens early, so expiry arithmetic is necessary but not
	// sufficient.
	client, log := oauthClient(t, []int{http.StatusUnauthorized, http.StatusOK})
	var out map[string]any
	if err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/widgets"}, &out); err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
	want := []string{"token", "api:Unauthorized", "token", "api:OK"}
	if strings.Join(*log, ",") != strings.Join(want, ",") {
		t.Errorf("log = %v, want %v", *log, want)
	}
}

func TestA401GivesUpAfterOneRefresh(t *testing.T) {
	// A genuinely revoked credential must not become a loop against the authorization server.
	client, log := oauthClient(t, []int{http.StatusUnauthorized, http.StatusUnauthorized, http.StatusUnauthorized})
	var out map[string]any
	if err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/widgets"}, &out); err == nil {
		t.Fatal("expected an error")
	}
	tokenRequests := 0
	for _, entry := range *log {
		if entry == "token" {
			tokenRequests++
		}
	}
	if tokenRequests != 2 {
		t.Errorf("made %d token requests, want 2 (one initial, one forced)", tokenRequests)
	}
}

func TestANon401DoesNotForceARefresh(t *testing.T) {
	client, log := oauthClient(t, []int{http.StatusForbidden})
	var out map[string]any
	if err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/widgets"}, &out); err == nil {
		t.Fatal("expected an error")
	}
	tokenRequests := 0
	for _, entry := range *log {
		if entry == "token" {
			tokenRequests++
		}
	}
	if tokenRequests != 1 {
		t.Errorf("made %d token requests, want 1", tokenRequests)
	}
}
