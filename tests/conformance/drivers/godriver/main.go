// Command godriver is the Go conformance driver.
//
// Runs every shared scenario against the mock server using the *generated* SDK, and prints what it
// observed as JSON on stdout. The runner compares that against the scenario expectations and against
// the other languages' drivers.
//
// Calls are written natively — `client.Orgs.ListMembers(ctx, "o1", params, nil)` — because the point
// is that idiomatic code in each language produces identical wire behaviour. A data-driven driver
// dispatching on operation names would prove nothing about idiom.
//
// Usage: godriver <baseURL>
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	ks "github.com/acme/kitchensink-go"
)

var baseURL string

// newClient returns a client pinned to one scenario, so the server knows which script to replay.
func newClient(scenario string, maxRetries int) *ks.KitchenSink {
	if maxRetries == 0 {
		maxRetries = -1
	}
	// WithAPIKey, not WithToken: this spec declares only an API key, so WithToken is not generated.
	return ks.New(
		ks.WithBaseURL(baseURL),
		ks.WithAPIKey("key_conformance"),
		ks.WithMaxRetries(maxRetries),
		ks.WithHeader("X-Scenario", scenario),
	)
}

type result map[string]string

func listCategories(ctx context.Context) (result, error) {
	categories, err := newClient("list_categories", 0).Categories.List(ctx, nil)
	if err != nil {
		return nil, err
	}
	return result{
		"count":       fmt.Sprint(len(categories)),
		"first_slug":  categories[0].Slug,
		"second_name": categories[1].Name,
	}, nil
}

func paginateMembers(ctx context.Context) (result, error) {
	it := newClient("paginate_members", 0).Orgs.ListMembers(ctx, "o1",
		&ks.OrgsListMembersParams{Limit: ks.Int64(2)}, nil)
	var emails []string
	for it.Next(ctx) {
		emails = append(emails, it.Current().Email)
	}
	if err := it.Err(); err != nil {
		return nil, err
	}
	return result{"emails": strings.Join(emails, ","), "count": fmt.Sprint(len(emails))}, nil
}

func querySerialization(ctx context.Context) (result, error) {
	// Since is deliberately omitted: an absent optional parameter must not reach the wire at all.
	// ks.Ptr, not ks.String: an optional enum parameter is a *QueryKind. That the named helpers do
	// not cover a generated enum is what made re-exporting the generic Ptr necessary.
	out, err := newClient("query_serialization", 0).Search.Query(ctx,
		&ks.SearchQueryParams{Q: "sprocket", Kind: ks.Ptr(ks.QueryKindMember)}, nil)
	if err != nil {
		return nil, err
	}
	return result{"count": fmt.Sprint(len(out))}, nil
}

func pathEscaping(ctx context.Context) (result, error) {
	pdf, err := newClient("path_escaping", 0).Orgs.Invoices.DownloadPdf(ctx, "a/b", "i1", nil)
	if err != nil {
		return nil, err
	}
	return result{"byte_length": fmt.Sprint(len(pdf))}, nil
}

func error404(ctx context.Context) (result, error) {
	// Draining is required: the iterator is lazy, so the request happens on Next.
	it := newClient("error_404", 0).Orgs.ListMembers(ctx, "missing", nil, nil)
	for it.Next(ctx) {
	}
	err := it.Err()
	if err == nil {
		return result{"error_kind": "none"}, nil
	}
	var notFound *ks.NotFoundError
	if !errors.As(err, &notFound) {
		return result{"error_kind": fmt.Sprintf("wrong:%T", err)}, nil
	}
	return result{
		"error_kind": "not_found",
		"status":     fmt.Sprint(notFound.StatusCode),
		"message":    notFound.Message,
		"request_id": notFound.RequestID,
	}, nil
}

func retryThenSuccess(ctx context.Context) (result, error) {
	// Event is a union, which Go renders as `any` — so the body is a map. That is the honest cost of
	// a language without sum types, recorded in SPEC.md §3.3.5.
	// An idempotency key, because a POST without one is no longer retried.
	receipt, err := newClient("retry_then_success", 2).Events.Publish(ctx,
		&ks.EventsPublishParams{Body: map[string]any{"type": "widget.created"}},
		&ks.RequestOptions{IdempotencyKey: "conformance_1"})
	if err != nil {
		return nil, err
	}
	return result{
		"accepted": fmt.Sprint(receipt.Accepted),
		"event_id": ks.Deref(receipt.EventID),
	}, nil
}

func noRetryWithoutIdempotencyKey(ctx context.Context) (result, error) {
	_, err := newClient("no_retry_without_idempotency_key", 2).Events.Publish(ctx,
		&ks.EventsPublishParams{Body: map[string]any{"type": "widget.created"}}, nil)
	if err == nil {
		return result{"error_kind": "none"}, nil
	}
	if apiErr, ok := ks.AsAPIError(err); ok && apiErr.StatusCode >= 500 {
		return result{"error_kind": "server_error"}, nil
	}
	return result{"error_kind": fmt.Sprintf("wrong:%T", err)}, nil
}

func noRetryOn400(ctx context.Context) (result, error) {
	_, err := newClient("no_retry_on_400", 2).Events.Publish(ctx,
		&ks.EventsPublishParams{Body: map[string]any{"type": "widget.created"}}, nil)
	if err == nil {
		return result{"error_kind": "none"}, nil
	}
	var badRequest *ks.BadRequestError
	if !errors.As(err, &badRequest) {
		return result{"error_kind": fmt.Sprintf("wrong:%T", err)}, nil
	}
	return result{"error_kind": "bad_request"}, nil
}

func validationCatchesABrokenContract(ctx context.Context) (result, error) {
	_, err := newClient("validation_catches_a_broken_contract", 0).Categories.List(ctx, nil)
	if err == nil {
		return result{"error_kind": "none"}, nil
	}
	var validation *ks.ResponseValidationError
	if !errors.As(err, &validation) {
		return result{"error_kind": fmt.Sprintf("wrong:%T", err)}, nil
	}
	return result{"error_kind": "validation", "path": validation.Problems[0].Path}, nil
}

func validationOnAPaginatedResponse(ctx context.Context) (result, error) {
	it := newClient("validation_on_a_paginated_response", 0).Orgs.ListMembers(ctx, "o1", nil, nil)
	for it.Next(ctx) {
	}
	err := it.Err()
	if err == nil {
		return result{"error_kind": "none"}, nil
	}
	var validation *ks.ResponseValidationError
	if !errors.As(err, &validation) {
		return result{"error_kind": fmt.Sprintf("wrong:%T", err)}, nil
	}
	path := validation.Problems[0].Path
	// Trim the array index so the comparison is about the field, not each language's path syntax.
	if idx := strings.LastIndex(path, "."); idx >= 0 {
		path = path[idx+1:]
	}
	return result{"error_kind": "validation", "path": path}, nil
}

func validationAllowsAnAdditiveField(ctx context.Context) (result, error) {
	categories, err := newClient("validation_allows_an_additive_field", 0).Categories.List(ctx, nil)
	if err != nil {
		return nil, err
	}
	return result{"count": fmt.Sprint(len(categories)), "first_slug": categories[0].Slug}, nil
}

func textResponse(ctx context.Context) (result, error) {
	csv, err := newClient("text_response", 0).Reports.ExportUsage(ctx, nil)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimRight(csv, "\n"), "\n")
	return result{"text_starts_with": lines[0], "line_count": fmt.Sprint(len(lines))}, nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: godriver <baseURL>")
		os.Exit(2)
	}
	baseURL = os.Args[1]
	ctx := context.Background()

	// Ordered so the emitted JSON is comparable line by line across languages.
	scenarios := []struct {
		name string
		run  func(context.Context) (result, error)
	}{
		{"list_categories", listCategories},
		{"paginate_members", paginateMembers},
		{"query_serialization", querySerialization},
		{"path_escaping", pathEscaping},
		{"error_404", error404},
		{"retry_then_success", retryThenSuccess},
		{"no_retry_without_idempotency_key", noRetryWithoutIdempotencyKey},
		{"no_retry_on_400", noRetryOn400},
		{"validation_catches_a_broken_contract", validationCatchesABrokenContract},
		{"validation_on_a_paginated_response", validationOnAPaginatedResponse},
		{"validation_allows_an_additive_field", validationAllowsAnAdditiveField},
		{"text_response", textResponse},
	}

	observed := map[string]result{}
	for _, scenario := range scenarios {
		// A driver reports failures rather than crashing, so one broken scenario still yields a
		// comparable trace for the other seven.
		out, err := scenario.run(ctx)
		if err != nil {
			observed[scenario.name] = result{"_error": fmt.Sprintf("%T: %v", err, err)}
			continue
		}
		observed[scenario.name] = out
	}

	encoded, err := json.MarshalIndent(map[string]any{
		"language": "go",
		"observed": observed,
	}, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "encoding: %v\n", err)
		os.Exit(70)
	}
	fmt.Print(string(encoded))
}
