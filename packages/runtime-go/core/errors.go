// Package besdk is the hand-written runtime vendored into every generated Go SDK.
//
// Nothing here is generated, so this is where care is affordable. Generated code is a thin,
// well-named surface over it (AGENTS.md, "Quality bar").
//
// A generated SDK copies this package in as `internal/core`, so the published module depends only on
// the standard library — no dependency on besdk, and nothing to strand a user.
package core

import (
	"errors"
	"fmt"
	"net/http"
)

// SDKError is the interface every error this SDK returns satisfies.
//
// Named for its role rather than for the generator: generated code aliases it to <ClientName>Error,
// so renaming this project can never be a breaking change for an SDK it produced.
type SDKError interface {
	error
	sdkError()
}

// APIError is returned when a request reached the API and came back unsuccessfully.
//
// Matched with errors.As, which is Go's own mechanism for narrowing — the equivalent of `except` in
// Python and `instanceof` in TypeScript:
//
//	var apiErr *besdk.APIError
//	if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusNotFound {
//		// ...
//	}
type APIError struct {
	// StatusCode is the HTTP status. Zero when the request never produced a response.
	StatusCode int
	// Message is the server's own message where it supplied one, otherwise the HTTP status text.
	Message string
	// Body is the raw response body, kept verbatim so a caller can decode a shape besdk did not
	// know about. Capped, because an error need not carry a megabyte of HTML.
	Body []byte
	// RequestID is the first request-correlation header present. Surfaced deliberately: it is the
	// first thing an API's support team asks for, and an SDK that swallows it makes its users read
	// raw responses to get it back.
	RequestID string
	// Header is the full response header set, for the cases a caller needs more than RequestID.
	Header http.Header
}

func (e *APIError) Error() string {
	if e.RequestID != "" {
		return fmt.Sprintf("%s (status %d, request_id %s)", e.Message, e.StatusCode, e.RequestID)
	}
	return fmt.Sprintf("%s (status %d)", e.Message, e.StatusCode)
}

func (e *APIError) sdkError() {}

// Retryable reports whether resending the identical request could plausibly succeed.
//
// A 4xx other than 408 and 429 is not retryable: the request was understood and rejected, so sending
// it again is pure load on someone else's service.
func (e *APIError) Retryable() bool {
	switch e.StatusCode {
	case http.StatusRequestTimeout, http.StatusConflict, http.StatusTooManyRequests:
		return true
	}
	return e.StatusCode >= 500
}

// The typed errors below wrap APIError so that errors.As matches either the specific type or the
// general one. A caller can ask "was this a 404?" without comparing integers, and can still fall
// back to *APIError for a status with no dedicated type.
type (
	// BadRequestError is HTTP 400.
	BadRequestError struct{ *APIError }
	// AuthenticationError is HTTP 401.
	AuthenticationError struct{ *APIError }
	// PermissionDeniedError is HTTP 403.
	PermissionDeniedError struct{ *APIError }
	// NotFoundError is HTTP 404.
	NotFoundError struct{ *APIError }
	// ConflictError is HTTP 409.
	ConflictError struct{ *APIError }
	// UnprocessableEntityError is HTTP 422.
	UnprocessableEntityError struct{ *APIError }
	// RateLimitError is HTTP 429. RetryAfter carries the server's own advice when it sent any.
	RateLimitError struct {
		*APIError
		RetryAfter float64
	}
	// InternalServerError is any 5xx.
	InternalServerError struct{ *APIError }
)

// Unwrap lets errors.As and errors.Is reach the embedded *APIError, so a caller who does not care
// which specific status it was can still match the general type.
func (e *BadRequestError) Unwrap() error          { return e.APIError }
func (e *AuthenticationError) Unwrap() error      { return e.APIError }
func (e *PermissionDeniedError) Unwrap() error    { return e.APIError }
func (e *NotFoundError) Unwrap() error            { return e.APIError }
func (e *ConflictError) Unwrap() error            { return e.APIError }
func (e *UnprocessableEntityError) Unwrap() error { return e.APIError }
func (e *RateLimitError) Unwrap() error           { return e.APIError }
func (e *InternalServerError) Unwrap() error      { return e.APIError }

// ConnectionError is returned when the request never produced a response — DNS, TLS, a dropped
// connection, or a context that was cancelled.
type ConnectionError struct {
	Message string
	Cause   error
}

func (e *ConnectionError) Error() string { return fmt.Sprintf("%s: %v", e.Message, e.Cause) }
func (e *ConnectionError) Unwrap() error { return e.Cause }
func (e *ConnectionError) sdkError()     {}

// DecodeError is returned when a response arrived but could not be decoded into the expected shape.
//
// Distinct from APIError on purpose: the request succeeded and the *contract* was violated, which is
// a different problem for the caller and usually a different problem for the API owner.
type DecodeError struct {
	Message string
	Body    []byte
	Cause   error
}

func (e *DecodeError) Error() string { return fmt.Sprintf("%s: %v", e.Message, e.Cause) }
func (e *DecodeError) Unwrap() error { return e.Cause }
func (e *DecodeError) sdkError()     {}

// errorForResponse builds the most specific error type for a status code.
//
// Falls back to the bare *APIError rather than failing on an unrecognised code: a 418 must still
// reach the caller as something matchable, not as a nil error or a panic.
func errorForResponse(base *APIError, retryAfter float64) error {
	switch base.StatusCode {
	case http.StatusBadRequest:
		return &BadRequestError{APIError: base}
	case http.StatusUnauthorized:
		return &AuthenticationError{APIError: base}
	case http.StatusForbidden:
		return &PermissionDeniedError{APIError: base}
	case http.StatusNotFound:
		return &NotFoundError{APIError: base}
	case http.StatusConflict:
		return &ConflictError{APIError: base}
	case http.StatusUnprocessableEntity:
		return &UnprocessableEntityError{APIError: base}
	case http.StatusTooManyRequests:
		return &RateLimitError{APIError: base, RetryAfter: retryAfter}
	}
	if base.StatusCode >= 500 {
		return &InternalServerError{APIError: base}
	}
	return base
}

// AsAPIError reports whether err is or wraps an *APIError, and returns it.
//
// A convenience over errors.As for the overwhelmingly common case, so callers who only want the
// status code do not have to declare a variable first.
func AsAPIError(err error) (*APIError, bool) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr, true
	}
	return nil, false
}
