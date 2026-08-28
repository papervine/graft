package core

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Runtime response validation.
//
// A generated struct is a *claim* about what the server sends. Go makes checking it more necessary
// than elsewhere, not less: `encoding/json` **silently ignores** a field whose type does not match, so
// a server sending `"seats": "many"` for an `int64` leaves the field at zero and the caller cannot
// tell that from a legitimate zero. Nothing fails, and the wrong number propagates.
//
// That is why validation runs against the *decoded generic value*, before unmarshalling into the typed
// struct. Validating the struct afterwards could not work — by then the mismatch has already been
// discarded. It costs a second `json.Unmarshal` of the same buffer, which is the honest price of
// knowing.
//
// What is checked and what deliberately is not mirrors the other runtimes exactly (SPEC.md
// §3.4.1.1): required fields, declared types, and nullability; never unknown fields, never enum
// membership.

// SchemaKind identifies a descriptor's shape.
type SchemaKind string

const (
	SchemaString  SchemaKind = "str"
	SchemaNumber  SchemaKind = "num"
	SchemaInteger SchemaKind = "int"
	SchemaBool    SchemaKind = "bool"
	SchemaAny     SchemaKind = "any"
	SchemaArray   SchemaKind = "arr"
	SchemaObject  SchemaKind = "obj"
	SchemaMap     SchemaKind = "map"
	SchemaNull    SchemaKind = "null"
	SchemaOr      SchemaKind = "or"
	SchemaRef     SchemaKind = "ref"
)

// SchemaField is one declared property of an object descriptor.
type SchemaField struct {
	Name     string `json:"n"`
	Schema   Schema `json:"s"`
	Required bool   `json:"r,omitempty"`
}

// Schema is a response-shape descriptor.
//
// One struct with optional fields rather than an interface hierarchy: Go has no sum type, and a
// hierarchy would mean a type assertion at every step of the walk for no gain in safety. The `json`
// tags are short because the whole table is embedded as JSON in generated code.
type Schema struct {
	K SchemaKind `json:"k"`
	// I is the item schema for arr, and the inner schema for null.
	I *Schema `json:"i,omitempty"`
	// V is the value schema for map.
	V *Schema `json:"v,omitempty"`
	// F is the declared fields of obj.
	F []SchemaField `json:"f,omitempty"`
	// A is the additional-properties schema of obj, when the spec declared one.
	A *Schema `json:"a,omitempty"`
	// O is the branches of or.
	O []Schema `json:"o,omitempty"`
	// N is the table key for ref.
	N string `json:"n,omitempty"`
}

// SchemaTable maps a type name to its descriptor. Recursive types terminate through it.
type SchemaTable map[string]Schema

// ValidationMode is how strictly to enforce the declared response shape.
type ValidationMode string

const (
	// ValidationStrict returns a *ResponseValidationError. The default.
	ValidationStrict ValidationMode = "strict"
	// ValidationWarn reports to the client's Logf and returns the value.
	ValidationWarn ValidationMode = "warn"
	// ValidationOff skips the check.
	ValidationOff ValidationMode = "off"
)

// ValidationProblem is one contract violation.
type ValidationProblem struct {
	// Path is a JSON path from the response root, e.g. `data[0].email`.
	Path    string
	Message string
}

// ResponseValidationError is returned when a response does not match the declared shape.
//
// Deliberately not an *APIError: the request succeeded and the *contract* was violated. That is a
// different problem for the caller — and usually a different problem for the API owner — so
// `errors.As(err, &apiErr)` must not match it.
type ResponseValidationError struct {
	// Operation names the method, e.g. `Orgs.ListMembers`.
	Operation string
	Problems  []ValidationProblem
	// Body is the raw response, so a caller who wants to proceed anyway still has it.
	Body []byte
}

func (e *ResponseValidationError) Error() string {
	// The first few, not all: a response violating its contract fifty times over is one broken
	// contract, and a fifty-line message buries the useful part.
	limit := len(e.Problems)
	if limit > 3 {
		limit = 3
	}
	parts := make([]string, 0, limit)
	for _, problem := range e.Problems[:limit] {
		path := problem.Path
		if path == "" {
			path = "response"
		}
		parts = append(parts, path+" "+problem.Message)
	}
	tail := ""
	if rest := len(e.Problems) - limit; rest > 0 {
		tail = fmt.Sprintf(", and %d more", rest)
	}
	return fmt.Sprintf("%s: the response did not match the API's declared shape — %s%s",
		e.Operation, strings.Join(parts, "; "), tail)
}

func (e *ResponseValidationError) sdkError() {}

const (
	maxProblems = 50
	maxDepth    = 64
)

// Validate checks a decoded value against a schema, returning the problems found.
//
// An empty result means it conformed. Collecting rather than returning early lets warn mode report
// everything, and lets one error carry every violation.
func Validate(value any, schema Schema, table SchemaTable) []ValidationProblem {
	var problems []ValidationProblem
	walkSchema(value, schema, table, "", &problems, 0)
	return problems
}

func walkSchema(value any, schema Schema, table SchemaTable, path string, problems *[]ValidationProblem, depth int) {
	if len(*problems) >= maxProblems || depth > maxDepth {
		return
	}

	switch schema.K {
	case SchemaAny:
		return

	case SchemaRef:
		target, ok := table[schema.N]
		if !ok {
			// A dangling reference is a generator bug, not a server one. Reported as such rather than
			// failing the response, because punishing the user for our mistake is the wrong trade.
			appendProblem(problems, path, "references unknown schema `"+schema.N+"`")
			return
		}
		walkSchema(value, target, table, path, problems, depth+1)

	case SchemaNull:
		if value == nil {
			return
		}
		if schema.I != nil {
			walkSchema(value, *schema.I, table, path, problems, depth+1)
		}

	case SchemaString:
		if _, ok := value.(string); !ok {
			appendProblem(problems, path, mismatchMessage("a string", value))
		}

	case SchemaNumber:
		number, ok := value.(float64)
		if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
			appendProblem(problems, path, mismatchMessage("a number", value))
		}

	case SchemaInteger:
		// JSON numbers decode to float64 through `any`, so integrality is a value check rather than a
		// type check.
		number, ok := value.(float64)
		if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) {
			appendProblem(problems, path, mismatchMessage("an integer", value))
		}

	case SchemaBool:
		if _, ok := value.(bool); !ok {
			appendProblem(problems, path, mismatchMessage("a boolean", value))
		}

	case SchemaArray:
		items, ok := value.([]any)
		if !ok {
			appendProblem(problems, path, mismatchMessage("an array", value))
			return
		}
		if schema.I == nil {
			return
		}
		for index, item := range items {
			walkSchema(item, *schema.I, table, fmt.Sprintf("%s[%d]", path, index), problems, depth+1)
			if len(*problems) >= maxProblems {
				return
			}
		}

	case SchemaMap:
		object, ok := value.(map[string]any)
		if !ok {
			appendProblem(problems, path, mismatchMessage("an object", value))
			return
		}
		if schema.V == nil {
			return
		}
		// Sorted so a failure is reproducible; Go's map iteration order is deliberately random.
		for _, key := range sortedMapKeys(object) {
			walkSchema(object[key], *schema.V, table, joinPath(path, key), problems, depth+1)
			if len(*problems) >= maxProblems {
				return
			}
		}

	case SchemaObject:
		object, ok := value.(map[string]any)
		if !ok {
			appendProblem(problems, path, mismatchMessage("an object", value))
			return
		}
		declared := make(map[string]bool, len(schema.F))
		for _, field := range schema.F {
			declared[field.Name] = true
			inner, present := object[field.Name]
			if !present {
				if field.Required {
					appendProblem(problems, joinPath(path, field.Name), "is required but was absent")
				}
				continue
			}
			// A present-but-null value is walked rather than skipped, so a `null` in a non-nullable
			// field is reported as the type mismatch it is.
			walkSchema(inner, field.Schema, table, joinPath(path, field.Name), problems, depth+1)
			if len(*problems) >= maxProblems {
				return
			}
		}
		// Unknown fields are never a problem. A server adding a field must not break a client, and
		// this is where that promise is kept.
		if schema.A != nil {
			for _, key := range sortedMapKeys(object) {
				if declared[key] {
					continue
				}
				walkSchema(object[key], *schema.A, table, joinPath(path, key), problems, depth+1)
				if len(*problems) >= maxProblems {
					return
				}
			}
		}

	case SchemaOr:
		// A union passes if any branch does. Only the *closest* failure is reported when none do:
		// listing every branch's complaints for a three-way union is noise, and the branch that got
		// furthest is almost always the one the server meant.
		var best []ValidationProblem
		for _, branch := range schema.O {
			var branchProblems []ValidationProblem
			walkSchema(value, branch, table, path, &branchProblems, depth+1)
			if len(branchProblems) == 0 {
				return
			}
			if best == nil || len(branchProblems) < len(best) {
				best = branchProblems
			}
		}
		if best == nil {
			appendProblem(problems, path, "matched no variant of the union")
			return
		}
		*problems = append(*problems, best...)
	}
}

func appendProblem(problems *[]ValidationProblem, path, message string) {
	if len(*problems) >= maxProblems {
		return
	}
	*problems = append(*problems, ValidationProblem{Path: path, Message: message})
}

func mismatchMessage(expected string, actual any) string {
	return "should be " + expected + " but was " + describeValue(actual)
}

// describeValue names a value's shape and never its content: the value may be a secret — a token
// echoed back, a key in an error body — and an error message ends up in logs.
func describeValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case string:
		return "a string"
	case bool:
		return "a boolean"
	case float64:
		if typed == math.Trunc(typed) && !math.IsInf(typed, 0) {
			return "an integer"
		}
		return "a number"
	case []any:
		return "an array"
	case map[string]any:
		return "an object"
	default:
		return fmt.Sprintf("%T", value)
	}
}

func joinPath(path, key string) string {
	safe := key != ""
	for index, r := range key {
		isLetter := r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		isDigit := r >= '0' && r <= '9'
		if !isLetter && !(isDigit && index > 0) {
			safe = false
			break
		}
	}
	if path == "" {
		if safe {
			return key
		}
		return "[" + strconv.Quote(key) + "]"
	}
	if safe {
		return path + "." + key
	}
	return path + "[" + strconv.Quote(key) + "]"
}

func sortedMapKeys(object map[string]any) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// MustParseSchemaTable decodes an embedded descriptor table.
//
// Generated code embeds the table as compact JSON and parses it once at package initialisation.
// Go struct literals for the same data would be several times larger — Stripe's table is a few
// thousand descriptors — and slower to compile, so the JSON blob is both smaller in the repository and
// cheaper in the build. Parsing costs a few milliseconds once.
//
// Panics on malformed input, deliberately: the input is generated by besdk and embedded in the same
// binary, so a failure here is a generator bug that should surface at start-up rather than on the
// first request.
func MustParseSchemaTable(encoded string) SchemaTable {
	var table SchemaTable
	if err := json.Unmarshal([]byte(encoded), &table); err != nil {
		panic(fmt.Sprintf("sdk: embedded schema table is malformed: %v", err))
	}
	return table
}

// AsSlice reads a decoded value as a slice, returning nil when it is not one.
//
// Used by generated pagination code to validate items before they are unmarshalled into a typed slice.
// Tolerant rather than strict: a malformed envelope is already the decoder's problem to report, and
// panicking inside a validation helper would turn a server's bad response into a crash.
func AsSlice(value any) []any {
	if items, ok := value.([]any); ok {
		return items
	}
	return nil
}

// PrefixPaths rewrites problem paths to include the index of the item they came from.
//
// A paginator has already unwrapped the envelope, so a problem reported as `email` needs to become
// `[0].email` for the caller to know which item it was.
func PrefixPaths(problems []ValidationProblem, index int) []ValidationProblem {
	out := make([]ValidationProblem, len(problems))
	for i, problem := range problems {
		path := problem.Path
		if path == "" {
			path = fmt.Sprintf("[%d]", index)
		} else if strings.HasPrefix(path, "[") {
			path = fmt.Sprintf("[%d]%s", index, path)
		} else {
			path = fmt.Sprintf("[%d].%s", index, path)
		}
		out[i] = ValidationProblem{Path: path, Message: problem.Message}
	}
	return out
}
