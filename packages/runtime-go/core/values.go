package core

import (
	"fmt"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"time"
)

// Pointer helpers.
//
// Go expresses "this optional field is set" as a non-nil pointer, and there is no literal syntax for
// the address of a constant — `&"x"` does not compile. So every Go SDK ships these, and callers write
// `acme.String("x")`. Generic helpers rather than one per type, because the alternative is thirty
// near-identical functions.

// Ptr returns a pointer to v. The general form; the named helpers below read better at a call site.
func Ptr[T any](v T) *T { return &v }

// String returns a pointer to s.
func String(s string) *string { return &s }

// Int returns a pointer to i.
func Int(i int) *int { return &i }

// Int64 returns a pointer to i.
func Int64(i int64) *int64 { return &i }

// Float64 returns a pointer to f.
func Float64(f float64) *float64 { return &f }

// Bool returns a pointer to b.
func Bool(b bool) *bool { return &b }

// Time returns a pointer to t.
func Time(t time.Time) *time.Time { return &t }

// Deref returns the value a pointer holds, or the zero value when it is nil.
//
// The read half of the pointer convention: `graft.Deref(widget.Name)` rather than an `if != nil`
// at every use.
func Deref[T any](p *T) T {
	if p == nil {
		var zero T
		return zero
	}
	return *p
}

// DerefOr returns the value a pointer holds, or fallback when it is nil.
func DerefOr[T any](p *T, fallback T) T {
	if p == nil {
		return fallback
	}
	return *p
}

// QueryEncoder builds query parameters, matching the other runtimes' rules exactly.
//
// Conformance tests assert that every language puts the same bytes on the wire, so the three
// implementations of this are kept deliberately in step:
//
//   - a nil pointer is omitted, never sent as empty
//   - a bool is `true`/`false`
//   - a slice repeats the key
//   - a map becomes `key[inner]=value`, the OpenAPI deepObject form Stripe's range filters use
type QueryEncoder struct {
	values url.Values
}

// NewQueryEncoder returns an empty encoder.
func NewQueryEncoder() *QueryEncoder { return &QueryEncoder{values: url.Values{}} }

// Values returns the accumulated parameters.
func (q *QueryEncoder) Values() url.Values { return q.values }

// Add serialises one value under key, doing nothing when it is absent.
func (q *QueryEncoder) Add(key string, value any) {
	q.add(key, value)
}

func (q *QueryEncoder) add(key string, value any) {
	if value == nil {
		return
	}
	switch v := value.(type) {
	case *string:
		if v != nil {
			q.values.Add(key, *v)
		}
	case *int:
		if v != nil {
			q.values.Add(key, strconv.Itoa(*v))
		}
	case *int64:
		if v != nil {
			q.values.Add(key, strconv.FormatInt(*v, 10))
		}
	case *float64:
		if v != nil {
			q.values.Add(key, strconv.FormatFloat(*v, 'f', -1, 64))
		}
	case *bool:
		if v != nil {
			q.values.Add(key, strconv.FormatBool(*v))
		}
	case *time.Time:
		if v != nil {
			q.values.Add(key, v.Format(time.RFC3339))
		}
	case string:
		q.values.Add(key, v)
	case int:
		q.values.Add(key, strconv.Itoa(v))
	case int64:
		q.values.Add(key, strconv.FormatInt(v, 10))
	case float64:
		q.values.Add(key, strconv.FormatFloat(v, 'f', -1, 64))
	case bool:
		q.values.Add(key, strconv.FormatBool(v))
	case time.Time:
		q.values.Add(key, v.Format(time.RFC3339))
	case []string:
		for _, item := range v {
			q.values.Add(key, item)
		}
	case []int:
		for _, item := range v {
			q.values.Add(key, strconv.Itoa(item))
		}
	case map[string]any:
		for inner, item := range v {
			q.add(key+"["+inner+"]", item)
		}
	case map[string]string:
		for inner, item := range v {
			q.values.Add(key+"["+inner+"]", item)
		}
	default:
		// Reflection, not `fmt.Sprintf("%v")`.
		//
		// The type switch above can only name types this package knows about, and a generated SDK
		// passes types it declares itself: an optional enum parameter is a `*QueryKind`, where
		// `QueryKind` is a named string type. `%v` on that pointer printed its *address* —
		// `?kind=0x1400018c550` went on the wire, and the API would reject it. The cross-language
		// conformance suite caught it, because TypeScript and Python sent `kind=member`.
		//
		// No type switch can be exhaustive over types the caller declares, so the general case has to
		// be reflective.
		q.addReflected(key, value)
	}
}

// addReflected serialises a value whose concrete type this package cannot name.
//
// Handles pointers (nil is omitted, otherwise dereferenced), named types whose underlying kind is a
// scalar, and slices and maps of either. Anything genuinely unrepresentable falls back to `%v`, which
// is at least honest for a type nobody anticipated.
func (q *QueryEncoder) addReflected(key string, value any) {
	rv := reflect.ValueOf(value)
	if !rv.IsValid() {
		return
	}
	switch rv.Kind() {
	case reflect.Ptr, reflect.Interface:
		if rv.IsNil() {
			return
		}
		q.addReflected(key, rv.Elem().Interface())
	case reflect.String:
		// A named string type — a generated enum — reaches here. `.String()` gives the value, not
		// the type name.
		q.values.Add(key, rv.String())
	case reflect.Bool:
		q.values.Add(key, strconv.FormatBool(rv.Bool()))
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		q.values.Add(key, strconv.FormatInt(rv.Int(), 10))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		q.values.Add(key, strconv.FormatUint(rv.Uint(), 10))
	case reflect.Float32, reflect.Float64:
		q.values.Add(key, strconv.FormatFloat(rv.Float(), 'f', -1, 64))
	case reflect.Slice, reflect.Array:
		for i := 0; i < rv.Len(); i++ {
			q.addReflected(key, rv.Index(i).Interface())
		}
	case reflect.Map:
		for _, mapKey := range rv.MapKeys() {
			q.addReflected(key+"["+fmt.Sprint(mapKey.Interface())+"]", rv.MapIndex(mapKey).Interface())
		}
	default:
		q.values.Add(key, fmt.Sprintf("%v", value))
	}
}

// EncodePath percent-encodes a value for use as a single path segment.
//
// url.PathEscape rather than QueryEscape, and applied per segment: an id containing `/` would
// otherwise address a different endpoint, which is a correctness problem and arguably a security one.
// It lives here — reviewed once — rather than being spelled out at every generated call site.
func EncodePath(value any) string {
	switch v := value.(type) {
	case string:
		return url.PathEscape(v)
	case *string:
		if v == nil {
			return ""
		}
		return url.PathEscape(*v)
	default:
		return url.PathEscape(fmt.Sprintf("%v", v))
	}
}

// ReadPath follows a path into a decoded JSON body, tolerating a shape that does not match.
//
// Returns nil rather than erroring when the path is absent: a paginated response missing its cursor
// should end the iteration, not fail inside the SDK.
func ReadPath(data any, path ...string) any {
	current := data
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = object[key]
	}
	return current
}

// ReadString reads a string at a path, or "" when it is absent or another type.
func ReadString(data any, path ...string) string {
	if v, ok := ReadPath(data, path...).(string); ok {
		return v
	}
	return ""
}

// ReadInt64 reads an integer at a path.
//
// JSON numbers decode to float64 through `any`, so an int64 has to come back through a float. The
// bool exclusion matters: without it `"has_more": true` would read as a total of 1.
func ReadInt64(data any, path ...string) *int64 {
	switch v := ReadPath(data, path...).(type) {
	case float64:
		n := int64(v)
		return &n
	case int64:
		return &v
	}
	return nil
}

// ReadBool reads a boolean at a path.
func ReadBool(data any, path ...string) *bool {
	if v, ok := ReadPath(data, path...).(bool); ok {
		return &v
	}
	return nil
}

// JoinPath builds a request path from a template and already-encoded segments.
func JoinPath(parts ...string) string {
	return strings.Join(parts, "")
}
