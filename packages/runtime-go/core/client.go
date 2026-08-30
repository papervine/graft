package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"mime/multipart"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultTimeout applies per attempt, not to the whole retry sequence. A caller who wants a
	// bound on total time uses a context deadline, which is the Go answer and which this respects.
	DefaultTimeout = 60 * time.Second
	// DefaultMaxRetries is the number of *additional* attempts after the first.
	DefaultMaxRetries = 2

	maxBackoff = 8 * time.Second
	maxErrBody = 64 * 1024
)

// AuthKind identifies how a client authenticates.
type AuthKind int

const (
	AuthNone AuthKind = iota
	AuthBearer
	AuthBasic
	AuthAPIKey
	// AuthOAuth2 fetches and refreshes its own token, so the header cannot be computed once at
	// construction — it depends on a token that may not exist yet and will be replaced.
	AuthOAuth2
)

// idempotentMethods are the methods HTTP defines as idempotent, which are therefore safe to replay.
//
// DELETE belongs here: deleting twice leaves the resource deleted, and a 404 on the second attempt is
// the correct answer rather than a failure.
//
// The absence of this check was a bug, not a missing feature: a POST /charges returning 503 was sent
// three times, and whether the server processed the first one is unknowable from the client.
var idempotentMethods = map[string]bool{
	http.MethodGet:     true,
	http.MethodHead:    true,
	http.MethodPut:     true,
	http.MethodDelete:  true,
	http.MethodOptions: true,
}

// DefaultIdempotencyHeader is where an idempotency key is sent.
//
// Not standardised — Idempotency-Key, X-Idempotency-Key, and Idempotency-Token are all in real use — so
// a generated client can override it.
const DefaultIdempotencyHeader = "Idempotency-Key"

// Auth holds credentials. One struct rather than an interface hierarchy, because a client picks
// exactly one scheme and an interface would only add indirection.
type Auth struct {
	Kind     AuthKind
	Token    string
	Username string
	Password string
	// WireName and InQuery describe an API-key scheme: the header or query parameter name, and
	// where it goes.
	WireName string
	InQuery  bool
	// Source supplies tokens when Kind is AuthOAuth2.
	Source *TokenSource
}

// String deliberately omits the credential. A String() lands in logs and in error context, and an
// SDK that leaks its own token there has done real damage that is very hard to undo.
func (a Auth) String() string { return fmt.Sprintf("Auth{Kind:%d}", a.Kind) }

// ClientOptions configures a Client. Every field has a usable zero value except BaseURL.
type ClientOptions struct {
	BaseURL string
	Auth    Auth
	// Timeout applies per attempt. Zero means DefaultTimeout; use a negative value for no timeout.
	Timeout time.Duration
	// MaxRetries counts additional attempts. Zero means DefaultMaxRetries; use -1 to disable.
	MaxRetries int
	// DefaultHeaders is sent on every request. Constant headers hoisted out of method signatures
	// arrive here.
	DefaultHeaders map[string]string
	UserAgent      string
	// HTTPClient lets a caller supply their own transport. Without it, testing code that uses the
	// SDK means making real network calls — so this is not a nicety.
	HTTPClient *http.Client
	// Validation controls how strictly responses are checked against the shape the spec declared.
	//
	// The zero value means ValidationStrict, so the safe behaviour is what you get by not thinking
	// about it. See SPEC.md §3.4.1.1 for why strict is the default.
	Validation ValidationMode
	// Logf receives warnings in ValidationWarn mode. nil sends them to the standard logger.
	Logf func(format string, args ...any)
	// IdempotencyHeader overrides DefaultIdempotencyHeader.
	IdempotencyHeader string
	// BaseURLTemplate is a server URL with `{variable}` placeholders, resolved against
	// ServerVariables when BaseURL is empty.
	//
	// Resolved here rather than in generated code because Go applies functional options *after* the
	// options struct is built, so a generated constructor cannot substitute inline the way the
	// TypeScript and Python constructors do — by the time WithRegion has run, the URL would already be
	// assembled. The other two targets substitute at construction and never set this.
	BaseURLTemplate string
	// ServerVariables supplies values for BaseURLTemplate. A generated constructor seeds it with the
	// spec's defaults, so an option only has to overwrite the one it names.
	ServerVariables map[string]string
}

// Client is the transport every generated resource calls into.
type Client struct {
	baseURL           string
	auth              Auth
	timeout           time.Duration
	maxRetries        int
	headers           map[string]string
	httpClient        *http.Client
	validation        ValidationMode
	logf              func(format string, args ...any)
	idempotencyHeader string
}

// NewClient builds a Client. Generated clients embed one and expose resources as fields.
func NewClient(opts ClientOptions) *Client {
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	retries := opts.MaxRetries
	if retries == 0 {
		retries = DefaultMaxRetries
	} else if retries < 0 {
		retries = 0
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	headers := make(map[string]string, len(opts.DefaultHeaders)+1)
	for k, v := range opts.DefaultHeaders {
		headers[k] = v
	}
	if opts.UserAgent != "" {
		if _, ok := headers["User-Agent"]; !ok {
			headers["User-Agent"] = opts.UserAgent
		}
	}
	validation := opts.Validation
	if validation == "" {
		validation = ValidationStrict
	}
	logf := opts.Logf
	if logf == nil {
		logf = log.Printf
	}
	idempotencyHeader := opts.IdempotencyHeader
	if idempotencyHeader == "" {
		idempotencyHeader = DefaultIdempotencyHeader
	}
	// An explicit BaseURL wins: WithBaseURL is how a caller points at a proxy or a private
	// deployment, and a server template must not quietly override it.
	baseURL := opts.BaseURL
	if baseURL == "" && opts.BaseURLTemplate != "" {
		baseURL = resolveServerTemplate(opts.BaseURLTemplate, opts.ServerVariables)
	}
	return &Client{
		idempotencyHeader: idempotencyHeader,
		baseURL:           strings.TrimRight(baseURL, "/"),
		auth:              opts.Auth,
		timeout:           timeout,
		maxRetries:        retries,
		headers:           headers,
		httpClient:        httpClient,
		validation:        validation,
		logf:              logf,
	}
}

// resolveServerTemplate substitutes `{name}` placeholders in a server URL.
//
// A placeholder with no value is left in place rather than removed. `https://.api.example.com` is a
// plausible-looking hostname that fails at DNS with nothing to point at; `https://{region}...` is
// obviously wrong the moment anyone reads it, and graft warns about it at generation time (S003).
func resolveServerTemplate(template string, variables map[string]string) string {
	for name, value := range variables {
		if value == "" {
			continue
		}
		template = strings.ReplaceAll(template, "{"+name+"}", value)
	}
	return template
}

// BaseURL reports the configured base URL.
func (c *Client) BaseURL() string { return c.baseURL }

// ValidationMode reports how strictly responses are checked.
//
// Read by generated pagination code, which validates items itself because it decodes them itself.
func (c *Client) ValidationMode() ValidationMode { return c.validation }

// RequestOptions carries per-call overrides. A pointer is passed so nil means "no overrides", which
// keeps the common call site free of an empty struct literal.
type RequestOptions struct {
	Timeout     time.Duration
	MaxRetries  int
	ExtraHeader http.Header
	ExtraQuery  url.Values
	// IdempotencyKey makes a POST or PATCH safe to retry.
	//
	// Without one those methods are not retried, because deduplication has to happen on the server — a
	// client cannot make a replay safe by itself. Use the same key to mean the same logical request;
	// one key per request, never one per attempt, or the server has nothing to recognise.
	IdempotencyKey string
}

// Request describes one call. Assembled by generated code, which knows the shape; interpreted here,
// which knows the wire.
type Request struct {
	Method string
	Path   string
	Query  url.Values
	// Body is marshalled as JSON when non-nil and Multipart is empty, unless FormEncoded is set.
	Body any
	// FormEncoded sends Body as application/x-www-form-urlencoded rather than JSON, which is what the
	// spec asked for on any operation declaring that content type. Sending JSON to such an endpoint is
	// a request the server rejects — it broke every write operation of every form-based API before this
	// field existed.
	FormEncoded bool
	// Multipart, when non-empty, makes this a multipart/form-data request. Files carry their own
	// field names.
	//
	// Set by a caller who has readers to stream. Generated code does not use it: an operation whose
	// spec declares `multipart/form-data` sets MultipartBody instead and lets the runtime split the
	// body by value type, so "which field is a file" is decided once here rather than per target.
	Multipart []FilePart
	// MultipartBody sends Body as multipart/form-data, splitting it by value type: a []byte or an
	// io.Reader becomes a file part, everything else a form field.
	MultipartBody bool
	Header        http.Header
	Options       *RequestOptions
}

// FilePart is one file in a multipart request.
type FilePart struct {
	FieldName string
	Filename  string
	Content   io.Reader
}

func (c *Client) resolveTimeout(o *RequestOptions) time.Duration {
	if o != nil && o.Timeout != 0 {
		return o.Timeout
	}
	return c.timeout
}

func (c *Client) resolveRetries(o *RequestOptions) int {
	if o == nil || o.MaxRetries == 0 {
		return c.maxRetries
	}
	if o.MaxRetries < 0 {
		return 0
	}
	return o.MaxRetries
}

// replayable reports whether replaying this request is safe.
//
// POST and PATCH are replayable only with an idempotency key, because deduplication happens on the
// *server*. Pretending otherwise is worse than not retrying: the belief is what stops someone thinking
// about it.
func replayable(req *Request) bool {
	if idempotentMethods[strings.ToUpper(req.Method)] {
		return true
	}
	return req.Options != nil && req.Options.IdempotencyKey != ""
}

func (c *Client) buildURL(req *Request) string {
	query := url.Values{}
	for k, vs := range req.Query {
		for _, v := range vs {
			query.Add(k, v)
		}
	}
	if c.auth.Kind == AuthAPIKey && c.auth.InQuery && c.auth.Token != "" {
		query.Set(c.auth.WireName, c.auth.Token)
	}
	if req.Options != nil {
		for k, vs := range req.Options.ExtraQuery {
			for _, v := range vs {
				query.Add(k, v)
			}
		}
	}
	full := c.baseURL + "/" + strings.TrimLeft(req.Path, "/")
	if len(query) == 0 {
		return full
	}
	return full + "?" + query.Encode()
}

func (c *Client) applyHeaders(httpReq *http.Request, req *Request, oauthToken string) {
	for k, v := range c.headers {
		httpReq.Header.Set(k, v)
	}
	for k, vs := range req.Header {
		for _, v := range vs {
			httpReq.Header.Set(k, v)
		}
	}
	if oauthToken != "" {
		// Resolved by the caller rather than fetched here: fetching needs a context and can fail, and
		// this method cannot return an error without every call site growing one.
		httpReq.Header.Set("Authorization", "Bearer "+oauthToken)
	}
	switch c.auth.Kind {
	case AuthBearer:
		if c.auth.Token != "" {
			httpReq.Header.Set("Authorization", "Bearer "+c.auth.Token)
		}
	case AuthBasic:
		if c.auth.Username != "" {
			httpReq.SetBasicAuth(c.auth.Username, c.auth.Password)
		}
	case AuthAPIKey:
		if !c.auth.InQuery && c.auth.Token != "" && c.auth.WireName != "" {
			httpReq.Header.Set(c.auth.WireName, c.auth.Token)
		}
	}
	if req.Options != nil {
		for k, vs := range req.Options.ExtraHeader {
			for _, v := range vs {
				httpReq.Header.Set(k, v)
			}
		}
		if req.Options.IdempotencyKey != "" {
			httpReq.Header.Set(c.idempotencyHeader, req.Options.IdempotencyKey)
		}
	}
}

// encodeBody returns the request body and its content type.
//
// The body is encoded once, before the retry loop, for a reason that matters: an io.Reader can only
// be read once, so a retry would send an empty body. Buffering makes every attempt identical.
func encodeBody(req *Request) ([]byte, string, error) {
	if req.MultipartBody && len(req.Multipart) == 0 && req.Body != nil {
		return encodeMultipartBody(req.Body)
	}
	if len(req.Multipart) > 0 {
		var buf bytes.Buffer
		writer := multipart.NewWriter(&buf)
		if fields, ok := req.Body.(map[string]string); ok {
			for name, value := range fields {
				if err := writer.WriteField(name, value); err != nil {
					return nil, "", err
				}
			}
		}
		for _, part := range req.Multipart {
			w, err := writer.CreateFormFile(part.FieldName, part.Filename)
			if err != nil {
				return nil, "", err
			}
			if _, err := io.Copy(w, part.Content); err != nil {
				return nil, "", err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, "", err
		}
		return buf.Bytes(), writer.FormDataContentType(), nil
	}
	if req.Body == nil {
		return nil, "", nil
	}
	if req.FormEncoded {
		return []byte(formValues(req.Body).Encode()), "application/x-www-form-urlencoded", nil
	}
	encoded, err := json.Marshal(req.Body)
	if err != nil {
		return nil, "", fmt.Errorf("encoding request body: %w", err)
	}
	return encoded, "application/json", nil
}

// encodeMultipartBody writes a body as multipart/form-data, splitting it by value type.
//
// A []byte or an io.Reader is a file; everything else is a form field. That test is the whole rule,
// and it lives here rather than in the target because "which field is a file" is one decision — the
// TypeScript runtime makes the same one against Blob, and the Python one against bytes.
//
// Reflected over rather than routed through JSON, unlike formValues: json.Marshal would turn a
// []byte into a base64 string, which is right for a JSON body and destroys a file upload. That is
// the same trap the Python runtime hit with `model_dump(mode="json")`.
func encodeMultipartBody(body any) ([]byte, string, error) {
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	value := reflect.ValueOf(body)
	for value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil, "", nil
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return nil, "", fmt.Errorf("multipart body must be a struct, got %s", value.Kind())
	}

	structType := value.Type()
	for i := 0; i < structType.NumField(); i++ {
		field := structType.Field(i)
		if field.PkgPath != "" {
			// Unexported, so not part of the wire shape.
			continue
		}
		name := wireName(field)
		if name == "" || name == "-" {
			continue
		}
		fieldValue := value.Field(i)
		// An optional field is a pointer; nil means absent, not empty.
		for fieldValue.Kind() == reflect.Pointer {
			if fieldValue.IsNil() {
				fieldValue = reflect.Value{}
				break
			}
			fieldValue = fieldValue.Elem()
		}
		if !fieldValue.IsValid() {
			continue
		}

		if err := writeMultipartField(writer, name, fieldValue); err != nil {
			return nil, "", err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), writer.FormDataContentType(), nil
}

// wireName reads the JSON tag, so a multipart part is named exactly as the JSON path would name it.
func wireName(field reflect.StructField) string {
	tag := field.Tag.Get("json")
	if tag == "" {
		return field.Name
	}
	if comma := strings.Index(tag, ","); comma >= 0 {
		tag = tag[:comma]
	}
	if tag == "" {
		return field.Name
	}
	return tag
}

// writeMultipartField writes one field, as a file when it carries bytes and a form field otherwise.
func writeMultipartField(writer *multipart.Writer, name string, value reflect.Value) error {
	// The filename is the field name, which is the best available guess — the spec carries none, and a
	// server matching on `filename=` sees nothing without one.
	if value.Kind() == reflect.Slice && value.Type().Elem().Kind() == reflect.Uint8 {
		part, err := writer.CreateFormFile(name, name)
		if err != nil {
			return err
		}
		_, err = part.Write(value.Bytes())
		return err
	}
	if reader, ok := value.Interface().(io.Reader); ok {
		part, err := writer.CreateFormFile(name, name)
		if err != nil {
			return err
		}
		_, err = io.Copy(part, reader)
		return err
	}
	if value.Kind() == reflect.Slice || value.Kind() == reflect.Array {
		// A repeated key per element, matching the form encoder — `key[]=` is a PHP convention.
		for i := 0; i < value.Len(); i++ {
			if err := writer.WriteField(name, formScalar(value.Index(i).Interface())); err != nil {
				return err
			}
		}
		return nil
	}
	if value.Kind() == reflect.Struct || value.Kind() == reflect.Map {
		// No canonical nesting in multipart either, so a structured field is JSON — the same choice
		// every other runtime here makes.
		encoded, err := json.Marshal(value.Interface())
		if err != nil {
			return err
		}
		return writer.WriteField(name, string(encoded))
	}
	return writer.WriteField(name, formScalar(value.Interface()))
}

// formValues flattens a body into application/x-www-form-urlencoded fields.
//
// Routed through the struct's *JSON* representation rather than reflected over directly, so the wire
// names, the `omitempty` rules, and the pointer-means-optional convention are all exactly the ones the
// JSON path already gets right. Reflecting separately would be a second implementation of field naming,
// and the two would disagree the first time a tag changed.
//
// A slice becomes a repeated key, which is what every form-encoded API this project has seen expects;
// `key[]=` is a PHP convention and `key=a,b` is a third. A nested object is JSON-encoded, matching the
// multipart path — form encoding has no canonical nesting, so inventing one would send something no
// server asked for.
func formValues(body any) url.Values {
	values := url.Values{}
	encoded, err := json.Marshal(body)
	if err != nil {
		return values
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return values
	}
	for key, value := range fields {
		// nil is omitted rather than sent as "null", the same rule the query encoder follows.
		if value == nil {
			continue
		}
		switch typed := value.(type) {
		case []any:
			for _, item := range typed {
				if item == nil {
					continue
				}
				values.Add(key, formScalar(item))
			}
		case map[string]any:
			nested, err := json.Marshal(typed)
			if err == nil {
				values.Set(key, string(nested))
			}
		default:
			values.Set(key, formScalar(value))
		}
	}
	return values
}

// formScalar renders one value as a form field.
//
// `json.Unmarshal` into `any` turns every number into a float64, so an integer would otherwise be sent
// as `1e+06` for a large value and `1` for a small one — inconsistent, and wrong for an id. Integral
// floats are formatted as integers for that reason.
func formScalar(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		if typed == math.Trunc(typed) && math.Abs(typed) < 1e15 {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		nested, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return string(nested)
	}
}

// retryDelay is exponential backoff with full jitter, honouring Retry-After when present.
//
// Full jitter — rand * 2^n rather than 2^n plus a wobble — because deterministic backoff
// synchronises every client that started at the same time into a herd that arrives together, fails
// together, and retries together.
func retryDelay(attempt int, resp *http.Response) time.Duration {
	if resp != nil {
		if header := resp.Header.Get("Retry-After"); header != "" {
			if seconds, err := strconv.ParseFloat(header, 64); err == nil && seconds >= 0 {
				return capDuration(time.Duration(seconds * float64(time.Second)))
			}
			if when, err := http.ParseTime(header); err == nil {
				return capDuration(time.Until(when))
			}
		}
	}
	ceiling := time.Duration(1<<uint(attempt)) * 250 * time.Millisecond
	if ceiling > maxBackoff {
		ceiling = maxBackoff
	}
	//nolint:gosec // jitter spreads retries; it is not a security primitive
	return time.Duration(rand.Int63n(int64(ceiling) + 1))
}

func capDuration(d time.Duration) time.Duration {
	if d < 0 {
		return 0
	}
	if d > 4*maxBackoff {
		return 4 * maxBackoff
	}
	return d
}

func requestID(header http.Header) string {
	for _, name := range []string{"X-Request-Id", "Request-Id", "X-Amzn-Requestid", "Cf-Ray"} {
		if v := header.Get(name); v != "" {
			return v
		}
	}
	return ""
}

// messageFromBody digs a human-readable message out of an error body.
//
// Never fails: this runs while building an error, and a decode failure here would replace a useful
// "404 Not Found" with a confusing JSON error from inside the SDK.
func messageFromBody(body []byte, fallback string) string {
	var envelope map[string]any
	if err := json.Unmarshal(body, &envelope); err != nil {
		return fallback
	}
	for _, key := range []string{"message", "error", "detail", "title"} {
		switch value := envelope[key].(type) {
		case string:
			if value != "" {
				return value
			}
		case map[string]any:
			if nested, ok := value["message"].(string); ok && nested != "" {
				return nested
			}
		}
	}
	return fallback
}

// Do sends a request, retrying failures that could plausibly succeed, and returns the response for
// the caller to decode.
//
// The response body is *not* closed here on success: the caller decides how to read it, because a
// JSON body, a byte slice, and a stream want different handling.
func (c *Client) Do(ctx context.Context, req *Request) (*http.Response, error) {
	body, contentType, err := encodeBody(req)
	if err != nil {
		return nil, err
	}

	attempts := c.resolveRetries(req.Options)
	timeout := c.resolveTimeout(req.Options)
	target := c.buildURL(req)

	var lastErr error
	// A 401 buys one forced token refresh and one retry — never more. Expiry arithmetic is necessary
	// but not sufficient (clocks disagree, servers revoke early), and retrying more than once would
	// turn a genuinely revoked credential into a loop against the authorization server.
	authRefreshed := false

	for attempt := 0; attempt <= attempts; attempt++ {
		var oauthToken string
		if c.auth.Kind == AuthOAuth2 && c.auth.Source != nil {
			token, tokenErr := c.auth.Source.Token(ctx)
			if tokenErr != nil {
				// A token failure is more informative than any API error it would have caused, and it
				// is not retryable: the credentials are wrong, not the server busy.
				return nil, tokenErr
			}
			oauthToken = token
		}

		attemptCtx := ctx
		var cancel context.CancelFunc
		if timeout > 0 {
			attemptCtx, cancel = context.WithTimeout(ctx, timeout)
		}

		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		httpReq, buildErr := http.NewRequestWithContext(attemptCtx, strings.ToUpper(req.Method), target, reader)
		if buildErr != nil {
			if cancel != nil {
				cancel()
			}
			return nil, &ConnectionError{Message: "building request", Cause: buildErr}
		}
		httpReq.Header = http.Header{}
		if contentType != "" {
			httpReq.Header.Set("Content-Type", contentType)
		}
		c.applyHeaders(httpReq, req, oauthToken)

		resp, sendErr := c.httpClient.Do(httpReq)
		if sendErr != nil {
			if cancel != nil {
				cancel()
			}
			// A cancelled parent context is the caller's decision, never something to retry.
			if ctx.Err() != nil {
				return nil, &ConnectionError{Message: "request cancelled", Cause: ctx.Err()}
			}
			lastErr = &ConnectionError{Message: "sending request to " + c.baseURL, Cause: sendErr}
			if attempt < attempts && replayable(req) {
				if err := sleep(ctx, retryDelay(attempt+1, nil)); err != nil {
					return nil, err
				}
				continue
			}
			return nil, lastErr
		}

		if resp.StatusCode < 400 {
			// The per-attempt cancel would close the body out from under the caller, so ownership
			// of the context transfers with the response.
			if cancel != nil {
				context.AfterFunc(ctx, cancel)
			}
			return resp, nil
		}

		apiErr := readError(resp)
		resp.Body.Close()
		if cancel != nil {
			cancel()
		}

		if resp.StatusCode == http.StatusUnauthorized && !authRefreshed &&
			c.auth.Kind == AuthOAuth2 && c.auth.Source != nil {
			authRefreshed = true
			if _, refreshErr := c.auth.Source.ForceRefresh(ctx); refreshErr != nil {
				// A refresh that fails says the credentials are wrong, which is more useful than the
				// 401 it was trying to fix.
				return nil, refreshErr
			}
			// Retried immediately and without consuming the retry budget: the failure was a stale
			// token, not a busy server, so backing off would only add latency.
			attempt--
			continue
		}

		if apiErr.Retryable() && attempt < attempts && replayable(req) {
			if err := sleep(ctx, retryDelay(attempt+1, resp)); err != nil {
				return nil, err
			}
			continue
		}
		var retryAfter float64
		if header := resp.Header.Get("Retry-After"); header != "" {
			retryAfter, _ = strconv.ParseFloat(header, 64)
		}
		return nil, errorForResponse(apiErr, retryAfter)
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return nil, &ConnectionError{Message: "request to " + req.Path + " failed", Cause: context.Canceled}
}

func readError(resp *http.Response) *APIError {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrBody))
	return &APIError{
		StatusCode: resp.StatusCode,
		Message:    messageFromBody(body, http.StatusText(resp.StatusCode)),
		Body:       body,
		RequestID:  requestID(resp.Header),
		Header:     resp.Header,
	}
}

// sleep waits, but abandons the wait if the context is done. A plain time.Sleep would make a
// cancelled context wait out the full backoff before noticing.
func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return &ConnectionError{Message: "request cancelled while backing off", Cause: ctx.Err()}
	}
}

// DoJSON sends a request and decodes a JSON response into out.
//
// A 204 or an empty body leaves out untouched rather than failing: "no content" is a valid response
// to a DELETE, not a decode error.
func (c *Client) DoJSON(ctx context.Context, req *Request, out any) error {
	resp, err := c.Do(ctx, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent || out == nil {
		return nil
	}
	body, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return &ConnectionError{Message: "reading response body", Cause: readErr}
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return &DecodeError{Message: "decoding response", Body: truncate(body), Cause: err}
	}
	return nil
}

// DoJSONValidated sends a request, checks the response against the shape the spec declared, and then
// decodes it into out.
//
// **The order is the whole point.** `encoding/json` silently ignores a field whose type does not match,
// so validating the decoded struct could never work — by then a `"seats": "many"` has already become a
// zero and there is nothing left to notice. Validation therefore runs against a generic decode of the
// same bytes, before they reach the typed struct.
//
// The cost is a second `json.Unmarshal` of one buffer, paid only when validation is on. That is the
// honest price of knowing, and `ValidationOff` declines it.
func (c *Client) DoJSONValidated(
	ctx context.Context,
	req *Request,
	out any,
	schema Schema,
	table SchemaTable,
	operation string,
) error {
	if c.validation == ValidationOff {
		return c.DoJSON(ctx, req, out)
	}

	resp, err := c.Do(ctx, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		return nil
	}
	body, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return &ConnectionError{Message: "reading response body", Cause: readErr}
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return nil
	}

	var generic any
	if err := json.Unmarshal(body, &generic); err != nil {
		return &DecodeError{Message: "decoding response", Body: truncate(body), Cause: err}
	}

	if problems := Validate(generic, schema, table); len(problems) > 0 {
		validationErr := &ResponseValidationError{
			Operation: operation,
			Problems:  problems,
			Body:      truncate(body),
		}
		if c.validation == ValidationStrict {
			return validationErr
		}
		// Warn mode reports and continues. Through the client's logger rather than a callback nobody
		// wired up, because a diagnostic nobody sees is worse than one that is briefly noisy.
		c.logf("%s", validationErr.Error())
	}

	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return &DecodeError{Message: "decoding response", Body: truncate(body), Cause: err}
	}
	return nil
}

// DoBytes sends a request and returns the raw response body.
func (c *Client) DoBytes(ctx context.Context, req *Request) ([]byte, error) {
	resp, err := c.Do(ctx, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, &ConnectionError{Message: "reading response body", Cause: readErr}
	}
	return body, nil
}

// DoString sends a request and returns the response body as text.
//
// Distinct from DoBytes because a CSV export or an SSE stream is text, and typing it as bytes forces
// callers to unwrap something that was always a string.
func (c *Client) DoString(ctx context.Context, req *Request) (string, error) {
	body, err := c.DoBytes(ctx, req)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// DoEmpty sends a request and discards the response body.
func (c *Client) DoEmpty(ctx context.Context, req *Request) error {
	resp, err := c.Do(ctx, req)
	if err != nil {
		return err
	}
	// Drained before closing so the connection can be reused rather than dropped.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxErrBody))
	return resp.Body.Close()
}

// DoStream sends a request and returns the body for incremental reading. The caller closes it.
func (c *Client) DoStream(ctx context.Context, req *Request) (io.ReadCloser, error) {
	resp, err := c.Do(ctx, req)
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

func truncate(body []byte) []byte {
	if len(body) <= 2048 {
		return body
	}
	return body[:2048]
}
