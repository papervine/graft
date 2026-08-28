package core

import (
	"context"
	"errors"
	"testing"
)

func TestOffsetWalkVisitsEachItemOnce(t *testing.T) {
	// The bug this pins: the TypeScript runtime once refetched page one forever because a caller's
	// explicit offset=0 overwrote the computed offset. Asserts the actual offset sequence, not just
	// the item count.
	data := make([]string, 25)
	for i := range data {
		data[i] = string(rune('a' + i%26))
	}
	var offsets []int

	fetch := func(_ context.Context, params map[string]any) (*Page[string], error) {
		offset, _ := params["offset"].(int)
		limit, _ := params["limit"].(int)
		offsets = append(offsets, offset)
		end := offset + limit
		if end > len(data) {
			end = len(data)
		}
		more := end < len(data)
		return &Page[string]{Items: data[offset:end], HasMore: &more}, nil
	}

	it := NewIterator(fetch, AdvanceOffset[string]("limit", "offset"),
		map[string]any{"limit": 10, "offset": 0})

	got, err := it.All(context.Background())
	if err != nil {
		t.Fatalf("All: %v", err)
	}
	if len(got) != len(data) {
		t.Fatalf("got %d items, want %d", len(got), len(data))
	}
	want := []int{0, 10, 20}
	if len(offsets) != len(want) {
		t.Fatalf("offsets = %v, want %v", offsets, want)
	}
	for i := range want {
		if offsets[i] != want[i] {
			t.Fatalf("offsets = %v, want %v", offsets, want)
		}
	}
}

func TestCursorWalkStopsWhenTheCursorRunsOut(t *testing.T) {
	pages := []*Page[string]{
		{Items: []string{"a"}, NextCursor: "c1"},
		{Items: []string{"b"}, NextCursor: "c2"},
		{Items: []string{"c"}, HasMore: Bool(false)},
	}
	var cursors []string
	calls := 0

	fetch := func(_ context.Context, params map[string]any) (*Page[string], error) {
		cursor, _ := params["cursor"].(string)
		cursors = append(cursors, cursor)
		page := pages[calls]
		calls++
		return page, nil
	}

	it := NewIterator(fetch, AdvanceCursor[string]("cursor"), nil)
	got, err := it.All(context.Background())
	if err != nil {
		t.Fatalf("All: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %v", got)
	}
	if cursors[0] != "" || cursors[1] != "c1" || cursors[2] != "c2" {
		t.Errorf("cursors = %v", cursors)
	}
}

func TestServerClaimingMoreWithoutACursorTerminates(t *testing.T) {
	// An API bug must not become a hung client.
	calls := 0
	fetch := func(_ context.Context, _ map[string]any) (*Page[string], error) {
		calls++
		return &Page[string]{Items: []string{"x"}, HasMore: Bool(true)}, nil
	}
	it := NewIterator(fetch, AdvanceCursor[string]("cursor"), nil)
	got, err := it.All(context.Background())
	if err != nil {
		t.Fatalf("All: %v", err)
	}
	if len(got) != 1 || calls != 1 {
		t.Errorf("got %d items in %d calls, want 1 and 1", len(got), calls)
	}
}

func TestNothingIsFetchedBeforeFirstNext(t *testing.T) {
	calls := 0
	fetch := func(_ context.Context, _ map[string]any) (*Page[string], error) {
		calls++
		return &Page[string]{}, nil
	}
	it := NewIterator(fetch, AdvanceCursor[string]("cursor"), nil)
	if calls != 0 {
		t.Fatalf("constructing an iterator fetched %d pages", calls)
	}
	it.Next(context.Background())
	if calls != 1 {
		t.Errorf("calls = %d after first Next", calls)
	}
}

func TestIteratorSurfacesFetchErrors(t *testing.T) {
	// Err() after the loop is the Go convention — bufio.Scanner and sql.Rows both work this way —
	// and it is why Next returns only a bool.
	sentinel := errors.New("boom")
	fetch := func(_ context.Context, _ map[string]any) (*Page[string], error) {
		return nil, sentinel
	}
	it := NewIterator(fetch, AdvanceCursor[string]("cursor"), nil)
	if it.Next(context.Background()) {
		t.Fatal("Next returned true despite a fetch error")
	}
	if !errors.Is(it.Err(), sentinel) {
		t.Errorf("Err() = %v, want the fetch error", it.Err())
	}
}

func TestPageNumberAdvance(t *testing.T) {
	var seen []int
	calls := 0
	fetch := func(_ context.Context, params map[string]any) (*Page[string], error) {
		page, _ := params["page"].(int)
		seen = append(seen, page)
		calls++
		more := calls < 3
		return &Page[string]{Items: []string{"x"}, HasMore: &more}, nil
	}
	it := NewIterator(fetch, AdvancePageNumber[string]("page"), map[string]any{"page": 1})
	if _, err := it.All(context.Background()); err != nil {
		t.Fatalf("All: %v", err)
	}
	if len(seen) != 3 || seen[0] != 1 || seen[1] != 2 || seen[2] != 3 {
		t.Errorf("pages = %v, want 1,2,3", seen)
	}
}

func TestOtherParamsSurviveAdvancing(t *testing.T) {
	// A caller's filters must be carried across every page, not dropped after the first.
	var statuses []string
	calls := 0
	fetch := func(_ context.Context, params map[string]any) (*Page[string], error) {
		status, _ := params["status"].(string)
		statuses = append(statuses, status)
		calls++
		more := calls < 2
		return &Page[string]{Items: []string{"x"}, HasMore: &more}, nil
	}
	it := NewIterator(fetch, AdvanceOffset[string]("limit", "offset"),
		map[string]any{"limit": 1, "offset": 0, "status": "active"})
	if _, err := it.All(context.Background()); err != nil {
		t.Fatalf("All: %v", err)
	}
	for i, s := range statuses {
		if s != "active" {
			t.Errorf("page %d lost the status filter: %q", i, s)
		}
	}
}
