package core

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Requests go through a real httptest server rather than a stubbed transport, so the whole path is
// exercised: URL building, header application, retries, and decoding.

func newTestClient(t *testing.T, handler http.HandlerFunc, mutate ...func(*ClientOptions)) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	opts := ClientOptions{
		BaseURL:    server.URL,
		Auth:       Auth{Kind: AuthBearer, Token: "tok_123"},
		MaxRetries: -1,
	}
	for _, m := range mutate {
		m(&opts)
	}
	return NewClient(opts)
}

func TestBearerAuthAndJSONDecode(t *testing.T) {
	var gotAuth string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"w_1","name":"Sprocket"}`))
	})

	var out struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/widgets/w_1"}, &out); err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
	if gotAuth != "Bearer tok_123" {
		t.Errorf("Authorization = %q, want Bearer tok_123", gotAuth)
	}
	if out.ID != "w_1" || out.Name != "Sprocket" {
		t.Errorf("decoded %+v", out)
	}
}

func TestAPIKeyInQuery(t *testing.T) {
	var gotQuery string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{}`))
	}, func(o *ClientOptions) {
		o.Auth = Auth{Kind: AuthAPIKey, Token: "k", WireName: "api_key", InQuery: true}
	})

	if err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/x"}, nil); err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
	if !strings.Contains(gotQuery, "api_key=k") {
		t.Errorf("query = %q, want api_key=k", gotQuery)
	}
}

func TestBasicAuth(t *testing.T) {
	var user, pass string
	var ok bool
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok = r.BasicAuth()
		_, _ = w.Write([]byte(`{}`))
	}, func(o *ClientOptions) {
		o.Auth = Auth{Kind: AuthBasic, Username: "u", Password: "p"}
	})

	if err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/x"}, nil); err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
	if !ok || user != "u" || pass != "p" {
		t.Errorf("basic auth = %q/%q ok=%v", user, pass, ok)
	}
}

func TestNoContentIsNotADecodeError(t *testing.T) {
	// "No content" is a valid answer to a DELETE, not a contract violation.
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	var out map[string]any
	if err := client.DoJSON(context.Background(), &Request{Method: "delete", Path: "/x"}, &out); err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
}

func TestErrorsAreTypedAndCarryRequestID(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Request-Id", "req_9")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Widget not found"}`))
	})

	err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/x"}, nil)
	if err == nil {
		t.Fatal("expected an error")
	}

	// The specific type...
	var notFound *NotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("errors.As(*NotFoundError) failed for %T", err)
	}
	// ...and the general one, through Unwrap.
	apiErr, ok := AsAPIError(err)
	if !ok {
		t.Fatal("AsAPIError failed")
	}
	if apiErr.StatusCode != http.StatusNotFound {
		t.Errorf("StatusCode = %d", apiErr.StatusCode)
	}
	if apiErr.Message != "Widget not found" {
		t.Errorf("Message = %q", apiErr.Message)
	}
	if apiErr.RequestID != "req_9" {
		t.Errorf("RequestID = %q", apiErr.RequestID)
	}
}

func TestNestedErrorMessage(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"bad field"}}`))
	})
	err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/x"}, nil)
	if err == nil || !strings.Contains(err.Error(), "bad field") {
		t.Fatalf("err = %v, want it to mention bad field", err)
	}
}

func TestNonJSONErrorBodyKeepsTheStatus(t *testing.T) {
	// An HTML error page from a gateway must still arrive as a 502, not a JSON decode failure.
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`<html>bad gateway</html>`))
	})
	err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/x"}, nil)
	apiErr, ok := AsAPIError(err)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != http.StatusBadGateway {
		t.Errorf("StatusCode = %d", apiErr.StatusCode)
	}
	if apiErr.Message != "Bad Gateway" {
		t.Errorf("Message = %q, want the HTTP status text", apiErr.Message)
	}
}

func TestDecodeErrorIsDistinctFromAPIError(t *testing.T) {
	// The request succeeded and the contract was violated. That is a different problem for the
	// caller than a 4xx, so it is a different type.
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`not json at all`))
	})
	var out map[string]any
	err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/x"}, &out)
	var decodeErr *DecodeError
	if !errors.As(err, &decodeErr) {
		t.Fatalf("expected *DecodeError, got %T: %v", err, err)
	}
	if _, ok := AsAPIError(err); ok {
		t.Error("a decode failure must not present as an APIError")
	}
}

func TestAuthStringNeverLeaksTheToken(t *testing.T) {
	auth := Auth{Kind: AuthBearer, Token: "tok_secret"}
	if strings.Contains(auth.String(), "tok_secret") {
		t.Errorf("Auth.String() leaked the token: %s", auth.String())
	}
}

func TestRetriesServerErrorsThenSucceeds(t *testing.T) {
	var calls int
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}, func(o *ClientOptions) { o.MaxRetries = 3 })

	var out map[string]any
	if err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/x"}, &out); err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
	if calls != 3 {
		t.Errorf("calls = %d, want 3", calls)
	}
}

func TestDoesNotRetryBadRequest(t *testing.T) {
	var calls int
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
	}, func(o *ClientOptions) { o.MaxRetries = 3 })

	_ = client.DoJSON(context.Background(), &Request{Method: "get", Path: "/x"}, nil)
	// The request was understood and rejected; resending it is pure load.
	if calls != 1 {
		t.Errorf("calls = %d, want 1", calls)
	}
}

func TestRetriedRequestResendsTheBody(t *testing.T) {
	// The bug this pins: an io.Reader body can only be read once, so a naive retry sends nothing.
	var bodies []string
	var calls int
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		buf := make([]byte, 256)
		n, _ := r.Body.Read(buf)
		bodies = append(bodies, string(buf[:n]))
		if calls < 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}, func(o *ClientOptions) { o.MaxRetries = 2 })

	// An idempotency key, because a POST without one is no longer retried at all — deduplication has to
	// happen on the server. The thing under test here is body *buffering*: an io.Reader can only be read
	// once, so a naive retry sends nothing.
	err := client.DoJSON(context.Background(), &Request{
		Method:  "post",
		Path:    "/x",
		Body:    map[string]string{"name": "Sprocket"},
		Options: &RequestOptions{IdempotencyKey: "req_1"},
	}, nil)
	if err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
	if len(bodies) != 2 {
		t.Fatalf("got %d attempts", len(bodies))
	}
	if bodies[0] != bodies[1] || !strings.Contains(bodies[1], "Sprocket") {
		t.Errorf("retry sent a different body: %q then %q", bodies[0], bodies[1])
	}
}

func TestCancelledContextIsNotRetried(t *testing.T) {
	var calls int
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusInternalServerError)
	}, func(o *ClientOptions) { o.MaxRetries = 5 })

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := client.DoJSON(ctx, &Request{Method: "get", Path: "/x"}, nil)
	if err == nil {
		t.Fatal("expected an error")
	}
	if calls > 1 {
		t.Errorf("a cancelled context was retried %d times", calls)
	}
}

func TestRetryAfterHeaderIsHonoured(t *testing.T) {
	// The server knows its own rate-limit window; we do not.
	resp := &http.Response{Header: http.Header{}}
	resp.Header.Set("Retry-After", "2")
	if got := retryDelay(1, resp); got != 2*time.Second {
		t.Errorf("retryDelay = %v, want 2s", got)
	}
}

func TestRateLimitErrorCarriesRetryAfter(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	})
	err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/x"}, nil)
	var rateLimit *RateLimitError
	if !errors.As(err, &rateLimit) {
		t.Fatalf("expected *RateLimitError, got %T", err)
	}
	if rateLimit.RetryAfter != 30 {
		t.Errorf("RetryAfter = %v, want 30", rateLimit.RetryAfter)
	}
}

func TestPerCallOptionsOverrideTheClient(t *testing.T) {
	var gotHeader, gotQuery string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("X-Trace")
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{}`))
	})
	opts := &RequestOptions{
		ExtraHeader: http.Header{"X-Trace": []string{"abc"}},
		ExtraQuery:  url.Values{"debug": []string{"1"}},
	}
	if err := client.DoJSON(context.Background(),
		&Request{Method: "get", Path: "/x", Options: opts}, nil); err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
	if gotHeader != "abc" {
		t.Errorf("X-Trace = %q", gotHeader)
	}
	if !strings.Contains(gotQuery, "debug=1") {
		t.Errorf("query = %q", gotQuery)
	}
}

func TestDefaultHeadersAreSent(t *testing.T) {
	var accept string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		accept = r.Header.Get("Accept")
		_, _ = w.Write([]byte(`{}`))
	}, func(o *ClientOptions) {
		o.DefaultHeaders = map[string]string{"Accept": "application/json"}
	})
	if err := client.DoJSON(context.Background(), &Request{Method: "get", Path: "/x"}, nil); err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
	if accept != "application/json" {
		t.Errorf("Accept = %q", accept)
	}
}

func TestDoStringAndDoBytes(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("a,b\n1,2\n"))
	})
	text, err := client.DoString(context.Background(), &Request{Method: "get", Path: "/export.csv"})
	if err != nil {
		t.Fatalf("DoString: %v", err)
	}
	if text != "a,b\n1,2\n" {
		t.Errorf("DoString = %q", text)
	}
}

// Retry safety by method.
//
// The absence of this check was a bug rather than a missing feature: a POST /charges returning 503 was
// sent three times, and whether the server processed the first one is unknowable from the client.

func attemptsFor(t *testing.T, method string, options *RequestOptions) int {
	t.Helper()
	calls := 0
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{}`))
	}, func(o *ClientOptions) { o.MaxRetries = 2 })

	_ = client.DoJSON(context.Background(),
		&Request{Method: method, Path: "/things", Options: options}, nil)
	return calls
}

func TestRetriesIdempotentMethods(t *testing.T) {
	for _, method := range []string{"get", "head", "put", "delete", "options"} {
		if got := attemptsFor(t, method, nil); got != 3 {
			t.Errorf("%s was attempted %d times, want 3", method, got)
		}
	}
}

func TestDoesNotRetryPostOrPatchWithoutAKey(t *testing.T) {
	for _, method := range []string{"post", "patch"} {
		if got := attemptsFor(t, method, nil); got != 1 {
			t.Errorf("%s was attempted %d times, want 1 — replaying it is not safe", method, got)
		}
	}
}

func TestRetriesPostWithAnIdempotencyKey(t *testing.T) {
	// Deduplication happens on the server. A key is the only thing that makes the replay safe.
	if got := attemptsFor(t, "post", &RequestOptions{IdempotencyKey: "req_1"}); got != 3 {
		t.Errorf("post with a key was attempted %d times, want 3", got)
	}
}

func TestSendsTheKeyOnEveryAttempt(t *testing.T) {
	// One key per logical request, never per attempt — the server has to recognise the replay.
	var seen []string
	calls := 0
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		seen = append(seen, r.Header.Get("Idempotency-Key"))
		if calls < 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}, func(o *ClientOptions) { o.MaxRetries = 2 })

	if err := client.DoJSON(context.Background(), &Request{
		Method:  "post",
		Path:    "/charges",
		Options: &RequestOptions{IdempotencyKey: "key_1"},
	}, nil); err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
	if len(seen) != 2 || seen[0] != "key_1" || seen[1] != "key_1" {
		t.Errorf("keys sent = %v, want [key_1 key_1]", seen)
	}
}

func TestHonoursAConfiguredIdempotencyHeader(t *testing.T) {
	// Not standardised: Idempotency-Key, X-Idempotency-Key, and Idempotency-Token are all real.
	var seen string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("X-Idempotency-Token")
		_, _ = w.Write([]byte(`{}`))
	}, func(o *ClientOptions) { o.IdempotencyHeader = "X-Idempotency-Token" })

	if err := client.DoJSON(context.Background(), &Request{
		Method:  "post",
		Path:    "/charges",
		Options: &RequestOptions{IdempotencyKey: "key_1"},
	}, nil); err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
	if seen != "key_1" {
		t.Errorf("X-Idempotency-Token = %q", seen)
	}
}

// TestServerTemplateResolution covers a templated base URL.
//
// Resolved in the runtime rather than in generated code because Go applies functional options after
// the options struct is built: by the time WithRegion has run, a constructor that substituted inline
// would already have assembled the URL. The TypeScript and Python constructors substitute at
// construction and never set BaseURLTemplate.
func TestServerTemplateResolution(t *testing.T) {
	for _, tc := range []struct {
		name     string
		options  ClientOptions
		wantBase string
	}{
		{
			name: "defaults are substituted",
			options: ClientOptions{
				BaseURLTemplate: "https://{region}.api.example.com/{version}",
				ServerVariables: map[string]string{"region": "us-east-1", "version": "v2"},
			},
			wantBase: "https://us-east-1.api.example.com/v2",
		},
		{
			name: "an explicit base URL wins over the template",
			options: ClientOptions{
				BaseURL:         "http://localhost:8080",
				BaseURLTemplate: "https://{region}.api.example.com",
				ServerVariables: map[string]string{"region": "us-east-1"},
			},
			// WithBaseURL is how a caller reaches a proxy or a private deployment. A server template
			// silently overriding it would make that option unusable.
			wantBase: "http://localhost:8080",
		},
		{
			name: "a variable appearing twice is substituted everywhere",
			options: ClientOptions{
				BaseURLTemplate: "https://{env}.api.example.com/{env}",
				ServerVariables: map[string]string{"env": "staging"},
			},
			wantBase: "https://staging.api.example.com/staging",
		},
		{
			name: "an unset variable is left visible rather than removed",
			options: ClientOptions{
				BaseURLTemplate: "https://{region}.api.example.com",
				ServerVariables: map[string]string{"region": ""},
			},
			// `https://.api.example.com` is a plausible-looking hostname that fails at DNS with nothing
			// to point at. The placeholder is obviously wrong to anyone who reads it.
			wantBase: "https://{region}.api.example.com",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := NewClient(tc.options).BaseURL(); got != tc.wantBase {
				t.Fatalf("got %q want %q", got, tc.wantBase)
			}
		})
	}
}
