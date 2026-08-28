package core

import (
	"net/url"
	"testing"
)

func TestQueryOmitsNilPointers(t *testing.T) {
	q := NewQueryEncoder()
	q.Add("limit", Int(10))
	q.Add("cursor", (*string)(nil))
	q.Add("name", String(""))
	got := q.Values()
	if got.Get("limit") != "10" {
		t.Errorf("limit = %q", got.Get("limit"))
	}
	if _, present := got["cursor"]; present {
		t.Error("a nil pointer must be omitted, not sent empty")
	}
	// An empty string is a value, not an absence.
	if _, present := got["name"]; !present {
		t.Error("an explicit empty string must be sent")
	}
}

func TestQueryBooleansAreWireShaped(t *testing.T) {
	q := NewQueryEncoder()
	q.Add("active", Bool(true))
	q.Add("archived", Bool(false))
	if q.Values().Get("active") != "true" || q.Values().Get("archived") != "false" {
		t.Errorf("values = %v", q.Values())
	}
}

func TestQueryZeroIsSent(t *testing.T) {
	// A falsy check instead of a nil check would drop this, and ?limit=0 is meaningful.
	q := NewQueryEncoder()
	q.Add("limit", Int(0))
	if q.Values().Get("limit") != "0" {
		t.Errorf("limit = %q, want 0", q.Values().Get("limit"))
	}
}

func TestQuerySlicesRepeatTheKey(t *testing.T) {
	q := NewQueryEncoder()
	q.Add("id", []string{"a", "b"})
	if got := q.Values()["id"]; len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("id = %v", got)
	}
}

func TestQueryDeepObjects(t *testing.T) {
	// Stripe's range filters: created[gte]=1.
	q := NewQueryEncoder()
	q.Add("created", map[string]any{"gte": 1})
	if q.Values().Get("created[gte]") != "1" {
		t.Errorf("values = %v", q.Values())
	}
}

func TestEncodePathEscapesSlashes(t *testing.T) {
	// An id containing a slash would otherwise address a different endpoint.
	if got := EncodePath("a/b"); got != "a%2Fb" {
		t.Errorf("EncodePath(a/b) = %q, want a%%2Fb", got)
	}
}

func TestDerefHelpers(t *testing.T) {
	if Deref((*string)(nil)) != "" {
		t.Error("Deref of nil must be the zero value")
	}
	if Deref(String("x")) != "x" {
		t.Error("Deref lost the value")
	}
	if DerefOr((*int)(nil), 7) != 7 {
		t.Error("DerefOr ignored the fallback")
	}
}

func TestReadHelpersTolerateAMismatchedShape(t *testing.T) {
	body := map[string]any{"meta": map[string]any{"total": float64(42), "next": "c1"}}
	if got := ReadInt64(body, "meta", "total"); got == nil || *got != 42 {
		t.Errorf("ReadInt64 = %v", got)
	}
	if got := ReadString(body, "meta", "next"); got != "c1" {
		t.Errorf("ReadString = %q", got)
	}
	// A path that is not there ends iteration rather than failing inside the SDK.
	if got := ReadPath(body, "nope", "deeper"); got != nil {
		t.Errorf("ReadPath on a missing path = %v, want nil", got)
	}
	if got := ReadInt64(body, "meta", "next"); got != nil {
		t.Errorf("ReadInt64 on a string = %v, want nil", got)
	}
}

func TestReadInt64RejectsBooleans(t *testing.T) {
	// Without an explicit exclusion, "has_more": true would read as a total of 1.
	body := map[string]any{"has_more": true}
	if got := ReadInt64(body, "has_more"); got != nil {
		t.Errorf("ReadInt64 on a bool = %v, want nil", got)
	}
}

func TestQueryEncoderProducesStableEncoding(t *testing.T) {
	q := NewQueryEncoder()
	q.Add("b", String("2"))
	q.Add("a", String("1"))
	// url.Values.Encode sorts keys, so regeneration and replay are byte-stable.
	if got := q.Values().Encode(); got != "a=1&b=2" {
		t.Errorf("Encode = %q", got)
	}
	var _ url.Values = q.Values()
}

// A named string type, as a generated enum is.
type testKind string

const testKindMember testKind = "member"

func TestQueryHandlesNamedTypesAndPointersToThem(t *testing.T) {
	// The bug this pins: `%v` on a *QueryKind printed the pointer address, so `?kind=0x1400018c550`
	// went on the wire. Found by the cross-language conformance suite, because TypeScript and Python
	// both sent `kind=member`. No type switch can be exhaustive over types the caller declares.
	q := NewQueryEncoder()
	q.Add("kind", Ptr(testKindMember))
	q.Add("bare", testKindMember)
	if got := q.Values().Get("kind"); got != "member" {
		t.Errorf("kind = %q, want member", got)
	}
	if got := q.Values().Get("bare"); got != "member" {
		t.Errorf("bare = %q, want member", got)
	}
}

func TestQueryOmitsNilPointerToANamedType(t *testing.T) {
	q := NewQueryEncoder()
	q.Add("kind", (*testKind)(nil))
	if _, present := q.Values()["kind"]; present {
		t.Error("a nil pointer to a named type must be omitted")
	}
}

func TestQueryHandlesSliceOfNamedType(t *testing.T) {
	q := NewQueryEncoder()
	q.Add("kinds", []testKind{"member", "invoice"})
	if got := q.Values()["kinds"]; len(got) != 2 || got[0] != "member" || got[1] != "invoice" {
		t.Errorf("kinds = %v", got)
	}
}

func TestQueryHandlesNamedIntegerType(t *testing.T) {
	type page int
	q := NewQueryEncoder()
	q.Add("page", Ptr(page(3)))
	if got := q.Values().Get("page"); got != "3" {
		t.Errorf("page = %q, want 3", got)
	}
}
