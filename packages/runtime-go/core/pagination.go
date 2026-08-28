package core

import "context"

// Page is one page of results plus whatever the envelope carried.
type Page[T any] struct {
	Items      []T
	Total      *int64
	NextCursor string
	HasMore    *bool
	// Raw is the decoded envelope, for a field besdk did not model.
	Raw any
}

// HasNextPage reports whether another page exists.
//
// Prefers what the server said. Falling back to "the page was not empty" is deliberate but weaker:
// it costs one extra request at the end of a full walk, which is far better than stopping early on
// an API that returns a short-but-not-final page.
func (p *Page[T]) HasNextPage() bool {
	if p.HasMore != nil {
		return *p.HasMore
	}
	if p.NextCursor != "" {
		return true
	}
	return len(p.Items) > 0
}

// Iterator walks pages and yields items one at a time.
//
// The Next/Current/Err shape rather than range-over-func: that needs Go 1.23, and an SDK should not
// impose a toolchain floor its users have no other reason to meet. This is also the shape Google
// Cloud's and Stripe's Go SDKs use, so it needs no learning:
//
//	it := client.Widgets.List(ctx, nil)
//	for it.Next(ctx) {
//		widget := it.Current()
//	}
//	if err := it.Err(); err != nil {
//		return err
//	}
//
// Errors are deliberately *not* returned from Next. A `for` condition that returns two values cannot
// be written, and the alternative — panicking — is wrong for a library. Err() after the loop is the
// established Go convention, matching bufio.Scanner and sql.Rows.
type Iterator[T any] struct {
	fetch   func(ctx context.Context, params map[string]any) (*Page[T], error)
	advance func(page *Page[T], params map[string]any) map[string]any

	params  map[string]any
	page    *Page[T]
	index   int
	current T
	done    bool
	err     error
}

// NewIterator builds an Iterator. Nothing is requested until the first Next, so constructing one is
// free and a caller who never loops has not paid for a fetch.
func NewIterator[T any](
	fetch func(ctx context.Context, params map[string]any) (*Page[T], error),
	advance func(page *Page[T], params map[string]any) map[string]any,
	initial map[string]any,
) *Iterator[T] {
	params := map[string]any{}
	for k, v := range initial {
		params[k] = v
	}
	return &Iterator[T]{fetch: fetch, advance: advance, params: params}
}

// Next advances to the next item, fetching a page when the current one is exhausted.
func (it *Iterator[T]) Next(ctx context.Context) bool {
	if it.err != nil || it.done {
		return false
	}
	for {
		if it.page != nil && it.index < len(it.page.Items) {
			it.current = it.page.Items[it.index]
			it.index++
			return true
		}
		if it.page != nil {
			if !it.page.HasNextPage() {
				it.done = true
				return false
			}
			next := it.advance(it.page, it.params)
			if next == nil {
				// A server that claims more but supplies no cursor is broken; looping forever on
				// its behalf would turn its bug into a hung client.
				it.done = true
				return false
			}
			it.params = next
		}
		page, err := it.fetch(ctx, it.params)
		if err != nil {
			it.err = err
			return false
		}
		it.page = page
		it.index = 0
		if len(page.Items) == 0 && !page.HasNextPage() {
			it.done = true
			return false
		}
	}
}

// Current returns the item Next just advanced to. Only valid after Next returned true.
func (it *Iterator[T]) Current() T { return it.current }

// Err returns the first error that stopped iteration, if any. Always check it after the loop.
func (it *Iterator[T]) Err() error { return it.err }

// Page returns the envelope the current item came from, for callers who need Total.
func (it *Iterator[T]) Page() *Page[T] { return it.page }

// All drains the iterator into a slice.
//
// A convenience for the common small-collection case, and deliberately not the default: an API with
// a hundred thousand widgets should not be encouraged to load them all into memory.
func (it *Iterator[T]) All(ctx context.Context) ([]T, error) {
	var out []T
	for it.Next(ctx) {
		out = append(out, it.Current())
	}
	return out, it.Err()
}

// AdvanceOffset advances an offset scheme.
//
// The caller's own parameters are copied first and the computed offset written last. That ordering is
// the whole bug the TypeScript runtime once shipped: a caller who passed offset=0 explicitly
// overwrote the computed value, so every page after the first refetched page one and the iterator
// returned duplicates forever.
func AdvanceOffset[T any](limitParam, offsetParam string) func(*Page[T], map[string]any) map[string]any {
	return func(page *Page[T], params map[string]any) map[string]any {
		current := 0
		if v, ok := params[offsetParam].(int); ok {
			current = v
		}
		step := len(page.Items)
		if v, ok := params[limitParam].(int); ok && v > 0 {
			step = v
		}
		if step <= 0 {
			return nil
		}
		next := map[string]any{}
		for k, v := range params {
			next[k] = v
		}
		next[offsetParam] = current + step
		return next
	}
}

// AdvancePageNumber advances a page-number scheme.
func AdvancePageNumber[T any](pageParam string) func(*Page[T], map[string]any) map[string]any {
	return func(page *Page[T], params map[string]any) map[string]any {
		current := 1
		if v, ok := params[pageParam].(int); ok {
			current = v
		}
		next := map[string]any{}
		for k, v := range params {
			next[k] = v
		}
		next[pageParam] = current + 1
		return next
	}
}

// AdvanceCursor advances a cursor scheme.
func AdvanceCursor[T any](cursorParam string) func(*Page[T], map[string]any) map[string]any {
	return func(page *Page[T], params map[string]any) map[string]any {
		if page.NextCursor == "" {
			return nil
		}
		next := map[string]any{}
		for k, v := range params {
			next[k] = v
		}
		next[cursorParam] = page.NextCursor
		return next
	}
}
