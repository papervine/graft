package emit

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// Per-operation examples and tests (SPEC.md §3.11).
//
// The *values* come from `Method.Example` in the IR, so every language shows the same data for the
// same operation. Only the rendering is here, which is the whole division that section sets up: a
// target deciding what a plausible value is would be the sixth copy of one judgment.

// goLiteral renders a JSON value from the IR as Go source, given the type it must satisfy.
//
// Type-directed rather than value-directed, because Go has no literal for an interface and a struct
// literal needs its type named: `Widget{Name: core.String("x")}` cannot be produced by looking at
// `{"name": "x"}` alone. The TypeScript and Python targets needed the same thing for `Blob` and
// `UUID` respectively — the pattern is that a language-neutral value still needs a language's type
// system to render.
func (e *Emitter) goLiteral(ref *TypeRef, value any, indent int) string {
	pad := strings.Repeat("\t", indent+1)
	closePad := strings.Repeat("\t", indent)

	if ref == nil {
		return e.bareLiteral(value)
	}
	switch ref.Kind {
	case "nullable":
		if value == nil {
			return "nil"
		}
		return e.goLiteral(ref.Inner, value, indent)
	case "array":
		items, ok := value.([]any)
		if !ok || len(items) == 0 {
			return e.types.Render(ref, false) + "{}"
		}
		var b strings.Builder
		fmt.Fprintf(&b, "%s{\n", e.types.Render(ref, false))
		for _, item := range items {
			fmt.Fprintf(&b, "%s%s,\n", pad, e.goLiteral(ref.Items, item, indent+1))
		}
		fmt.Fprintf(&b, "%s}", closePad)
		return b.String()
	case "binary":
		// A `format: binary` field is `[]byte`, and the core supplies the placeholder as a string — so a
		// bare literal does not compile on exactly the field an upload example is about. The same shape
		// as TypeScript needing `new Blob([…])` and Python needing `.encode()`.
		if text, ok := value.(string); ok {
			return fmt.Sprintf("[]byte(%s)", GoString(text))
		}
		return "nil"
	case "union":
		// The first variant, matching what the core synthesized from. A union renders as `any` in Go
		// (§3.3.4), so the literal has to be a concrete value of *some* variant.
		if len(ref.Variants) == 0 {
			return e.bareLiteral(value)
		}
		return e.goLiteral(&ref.Variants[0], value, indent)
	case "named":
		named := e.namedType(ref.ID)
		if named == nil {
			return e.bareLiteral(value)
		}
		switch named.Kind {
		case "alias":
			return e.goLiteral(named.Target, value, indent)
		case "enum":
			// A generated enum is a named string type, so the wire value needs the type name to
			// satisfy the field: a bare string does not assign to `Role`.
			return fmt.Sprintf("%s(%s)", e.types.Declared(named.ID), e.bareLiteral(value))
		}
		fields, ok := value.(map[string]any)
		if !ok {
			return e.bareLiteral(value)
		}
		var b strings.Builder
		fmt.Fprintf(&b, "%s{\n", e.types.Declared(named.ID))
		// Sorted, so regenerating produces identical bytes. Map iteration order in Go is randomised,
		// and a snapshot that changes on every run is a snapshot nobody reviews.
		for _, wire := range sortedJSONKeys(fields) {
			field := fieldByWire(named, wire)
			if field == nil {
				continue
			}
			fmt.Fprintf(&b, "%s%s: %s,\n", pad, Exported(field.Name), e.fieldLiteral(field, fields[wire], indent+1))
		}
		fmt.Fprintf(&b, "%s}", closePad)
		return b.String()
	}
	return e.bareLiteral(value)
}

// fieldLiteral renders one struct field, taking a pointer where the field is optional.
//
// Go expresses "this optional field is set" as a non-nil pointer and has no literal syntax for the
// address of a constant, so the runtime ships `core.String`/`core.Int` helpers. An example assigning
// a bare value to a `*string` does not compile, which the gate reports immediately.
func (e *Emitter) fieldLiteral(field *Field, value any, indent int) string {
	rendered := e.types.Render(&field.Type, !field.Required)
	inner := e.goLiteral(&field.Type, value, indent)
	if !strings.HasPrefix(rendered, "*") || value == nil {
		return inner
	}
	switch helper := pointerHelper(strings.TrimPrefix(rendered, "*")); helper {
	case "":
		// No helper for this type — a pointer to a struct is taken with `&` on a composite literal,
		// which is legal Go where `&"x"` is not.
		return "&" + inner
	default:
		return fmt.Sprintf("core.%s(%s)", helper, inner)
	}
}

// pointerHelper names the runtime helper that takes the address of a constant of this type.
func pointerHelper(bare string) string {
	switch bare {
	case "string":
		return "String"
	case "int64":
		return "Int64"
	case "int":
		return "Int"
	case "float64":
		return "Float64"
	case "bool":
		return "Bool"
	case "time.Time":
		return "Time"
	default:
		return ""
	}
}

// bareLiteral renders a value with no type to guide it, which is correct for `any` and map values.
func (e *Emitter) bareLiteral(value any) string {
	switch typed := value.(type) {
	case nil:
		return "nil"
	case string:
		return GoString(typed)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		// `json.Unmarshal` into `any` makes every number a float64, so an integral one must be written
		// as an integer or an `int64` field will not accept it.
		if typed == float64(int64(typed)) {
			return fmt.Sprintf("%d", int64(typed))
		}
		return fmt.Sprintf("%g", typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, e.bareLiteral(item))
		}
		return "[]any{" + strings.Join(parts, ", ") + "}"
	case map[string]any:
		var b strings.Builder
		b.WriteString("map[string]any{")
		for i, key := range sortedJSONKeys(typed) {
			if i > 0 {
				b.WriteString(", ")
			}
			fmt.Fprintf(&b, "%s: %s", GoString(key), e.bareLiteral(typed[key]))
		}
		b.WriteString("}")
		return b.String()
	}
	return "nil"
}

// source is the emitted text so far, for deciding whether a declared variable was consumed.
func source(b *strings.Builder) string { return b.String() }

func sortedJSONKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func fieldByWire(named *NamedType, wire string) *Field {
	for i := range named.Fields {
		if named.Fields[i].WireName == wire {
			return &named.Fields[i]
		}
	}
	return nil
}

func (e *Emitter) namedType(id string) *NamedType {
	for i := range e.ir.Types {
		if e.ir.Types[i].ID == id {
			return &e.ir.Types[i]
		}
	}
	return nil
}

// accessorPath is a resource paired with the field path that reaches it, e.g. `Orgs.Invoices`.
type accessorPath struct {
	Path     string
	Resource *Resource
}

// accessorPaths returns every resource with the path a caller uses to reach it.
//
// `allResources` flattens without paths, which is fine for emitting a file and useless for writing a
// call: a nested resource reached as `client.Invoices` does not exist.
func (e *Emitter) accessorPaths() []accessorPath {
	var out []accessorPath
	var walk func(resources []Resource, prefix string)
	walk = func(resources []Resource, prefix string) {
		for i := range resources {
			r := &resources[i]
			path := Exported(r.Name)
			if prefix != "" {
				path = prefix + "." + path
			}
			out = append(out, accessorPath{Path: path, Resource: r})
			walk(r.Subresources, path)
		}
	}
	walk(e.ir.Resources, "")
	return out
}

func operationSlug(path string, m *Method) string {
	return strings.ToLower(strings.ReplaceAll(path, ".", "_") + "_" + strings.Join(m.Name.Tokens, "_"))
}

// exampleArgs renders the arguments for one call.
//
// Path parameters positionally in declaration order, then a params struct carrying the body and any
// required query or header parameters. Getting the order wrong puts a `limit` where an `orgID`
// belongs, which is a bug the examples gate has caught in another target already.
func (e *Emitter) exampleArgs(r *Resource, m *Method) string {
	if m.Example == nil {
		return "ctx, nil"
	}
	args := []string{"ctx"}
	for i := range m.HTTP.Params {
		p := &m.HTTP.Params[i]
		if p.Location != "path" {
			continue
		}
		args = append(args, e.goLiteral(&p.Type, m.Example.Params[p.WireName], 1))
	}

	var fields []string
	if m.Body != nil && m.Example.Body != nil {
		fields = append(fields, fmt.Sprintf("\t\tBody: %s,", e.goLiteral(&m.Body.Type, m.Example.Body, 2)))
	}
	for i := range m.HTTP.Params {
		p := &m.HTTP.Params[i]
		if p.Location == "path" || p.Location == "cookie" {
			continue
		}
		value, ok := m.Example.Params[p.WireName]
		if !ok {
			continue
		}
		// A params-struct field is a pointer when the parameter is optional, for the same reason a
		// model field is.
		synthetic := &Field{Name: p.Name, WireName: p.WireName, Type: p.Type, Required: p.Required}
		fields = append(fields, fmt.Sprintf("\t\t%s: %s,", Exported(p.Name), e.fieldLiteral(synthetic, value, 2)))
	}

	// A params pointer only where the method declares one; a method with no body and no non-path
	// parameters takes none at all, and passing `nil` for an argument that does not exist does not
	// compile.
	if e.methodTakesParams(m) {
		if len(fields) == 0 {
			args = append(args, "nil")
		} else {
			args = append(args, fmt.Sprintf("&%s{\n%s\n\t}", e.paramsTypeName(r, m), strings.Join(fields, "\n")))
		}
	}
	// Every generated method ends with `opts *core.RequestOptions`; `nil` means no per-call overrides.
	args = append(args, "nil")
	return strings.Join(args, ", ")
}

// methodTakesParams mirrors the condition `method` uses to decide whether to emit a params struct.
//
// Duplicated deliberately and narrowly rather than threaded through, because the alternative is
// returning the decision from an emitter that has already written its output. Kept adjacent in intent:
// a change to the condition in `resource.go` that is not made here produces examples that do not
// compile, which the gate reports rather than shipping.
func (e *Emitter) methodTakesParams(m *Method) bool {
	for i := range m.HTTP.Params {
		p := &m.HTTP.Params[i]
		if p.Location == "query" || p.Location == "header" {
			return true
		}
	}
	return m.Body != nil
}

// examplePath is the path the SDK should produce, with the example's values interpolated.
//
// Computed rather than asserted loosely, because path interpolation is one of the four things a
// generated test exists to check — a test asserting only that the path *contains* a resource name
// would pass while `/orgs/{orgId}/members` came out as `/orgs//members`.
func examplePath(m *Method) string {
	path := m.HTTP.Path
	if m.Example == nil {
		return path
	}
	for i := range m.HTTP.Params {
		p := &m.HTTP.Params[i]
		if p.Location != "path" {
			continue
		}
		value := ""
		if raw, ok := m.Example.Params[p.WireName]; ok {
			value = fmt.Sprintf("%v", raw)
		}
		path = strings.ReplaceAll(path, "{"+p.WireName+"}", url.PathEscape(value))
	}
	return path
}

// operationExamples emits one runnable example per operation, as a compiled test.
//
// `Example…` functions in a `_test.go` file rather than `main` programs in an `examples/` directory,
// because that is Go's own convention: `go doc` shows them beside the method, `go vet` checks their
// naming, and `go test` compiles them. A directory of `package main` files would need one module per
// file to build at all.
func (e *Emitter) operationExamples() ([]GeneratedFile, error) {
	var body strings.Builder
	uses := map[string]bool{}
	count := 0

	for _, entry := range e.accessorPaths() {
		r := entry.Resource
		for i := range r.Methods {
			m := &r.Methods[i]
			if m.Example == nil || unsupported(m) != "" {
				continue
			}
			count++
			// `ExampleType_Method`, which is Go's own convention *and* what `go vet` enforces: it
			// checks that the part before the underscore names a real identifier and the part after
			// names a method on it. `ExampleOrgsListMembers` looked reasonable and failed vet, because
			// no identifier `OrgsListMembers` exists.
			name := fmt.Sprintf("Example%s_%s", e.resourceType(r), Exported(m.Name))
			summary := m.Docs.Summary
			if summary == "" {
				summary = entry.Path + "." + Exported(m.Name)
			}
			fmt.Fprintf(&body, "\n// %s\n//\n// %s %s\n//\n", summary, strings.ToUpper(m.HTTP.Verb), m.HTTP.Path)
			body.WriteString("// Values are synthesized from the spec, so ids and placeholders are not real.\n")
			fmt.Fprintf(&body, "func %s() {\n", name)
			body.WriteString("\tctx := context.Background()\n")
			body.WriteString("\tclient := New()\n\n")
			call := fmt.Sprintf("client.%s.%s(%s)", entry.Path, Exported(m.Name), e.exampleArgs(r, m))
			switch {
			case m.PaginationID != "":
				fmt.Fprintf(&body, "\tit := %s\n", call)
				body.WriteString("\tfor it.Next(ctx) {\n\t\tfmt.Println(it.Current())\n\t}\n")
				body.WriteString("\tif err := it.Err(); err != nil {\n\t\tlog.Fatal(err)\n\t}\n")
				uses["fmt"], uses["log"] = true, true
			case m.Response.Kind == "empty":
				fmt.Fprintf(&body, "\tif err := %s; err != nil {\n\t\tlog.Fatal(err)\n\t}\n", call)
				uses["log"] = true
			default:
				fmt.Fprintf(&body, "\tresult, err := %s\n", call)
				body.WriteString("\tif err != nil {\n\t\tlog.Fatal(err)\n\t}\n\tfmt.Println(result)\n")
				uses["fmt"], uses["log"] = true, true
			}
			body.WriteString("}\n")
		}
	}
	if count == 0 {
		return nil, nil
	}

	// The package's *own* test package, not an external `_test` one.
	//
	// Go convention favours the external package for examples, so a snippet reads like consumer code —
	// but every generated type would then need qualifying (`kitchensink.EventsPublishParams`), and
	// threading a qualifier through the literal renderer is where a bug would live. The internal package
	// costs one thing: the example says `New()` where a consumer writes `kitchensink.New()`. `go doc`
	// shows it either way, and `go test` compiles it either way.
	file := NewFile(e.pkg,
		e.brand.GeneratedNotice,
		"",
		"Runnable examples, one per operation.",
		"",
		"Compiled by `go test`, so they cannot drift out of date with the API. `go doc` shows each",
		"one beside the method it calls.",
	)
	file.Import("context")
	for _, name := range []string{"fmt", "log"} {
		if uses[name] {
			file.Import(name)
		}
	}
	if e.usesCoreHelpers(body.String()) {
		file.Import(e.coreImport())
	}
	file.Add(strings.TrimPrefix(body.String(), "\n"))
	rendered, err := file.Render()
	if err != nil {
		return nil, err
	}
	return []GeneratedFile{{Path: "example_test.go", Contents: rendered}}, nil
}

// usesCoreHelpers reports whether emitted source calls a `core.` helper, so the import is only added
// when it is used — `go build` rejects an unused import, which is stricter than most languages and
// correct to be.
func (e *Emitter) usesCoreHelpers(source string) bool {
	return strings.Contains(source, "core.")
}

// operationTests emits one test per operation, run against an injected transport.
//
// Asserts the four things generated code is responsible for: the interpolated path, the request body
// and its content type, that an omitted optional parameter does not reach the wire, and that a
// declared response decodes. Never a network call — a generated test hitting a real API would fail in
// CI for reasons unrelated to the SDK, and the first thing anyone would do is delete it.
func (e *Emitter) operationTests() ([]GeneratedFile, error) {
	var files []GeneratedFile

	for _, entry := range e.accessorPaths() {
		r := entry.Resource
		for i := range r.Methods {
			m := &r.Methods[i]
			if m.Example == nil || unsupported(m) != "" {
				continue
			}

			var body strings.Builder
			payload := ""
			if m.Example.Response != nil {
				encoded, err := json.Marshal(m.Example.Response)
				if err != nil {
					return nil, err
				}
				payload = string(encoded)
			}
			contentType := "application/json"
			if m.Response.Kind == "text" {
				contentType = "text/plain"
				if text, ok := m.Example.Response.(string); ok {
					payload = text
				}
			}

			testName := "Test" + strings.ReplaceAll(entry.Path, ".", "") + Exported(m.Name)
			fmt.Fprintf(&body, "func %s(t *testing.T) {\n", testName)
			body.WriteString("\tvar seen *http.Request\n\tvar sentBody []byte\n\n")
			body.WriteString("\tserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n")
			body.WriteString("\t\tseen = r\n\t\tsentBody, _ = io.ReadAll(r.Body)\n")
			fmt.Fprintf(&body, "\t\tw.Header().Set(\"Content-Type\", %s)\n", GoString(contentType))
			fmt.Fprintf(&body, "\t\tw.WriteHeader(%d)\n", m.Response.StatusCode)
			if payload != "" {
				fmt.Fprintf(&body, "\t\t_, _ = w.Write([]byte(%s))\n", GoString(payload))
			}
			body.WriteString("\t}))\n\tdefer server.Close()\n\n")
			body.WriteString("\tctx := context.Background()\n")
			body.WriteString("\tclient := New(WithBaseURL(server.URL))\n\n")

			call := fmt.Sprintf("client.%s.%s(%s)", entry.Path, Exported(m.Name), e.exampleArgs(r, m))
			switch {
			case m.PaginationID != "":
				fmt.Fprintf(&body, "\tit := %s\n\tit.Next(ctx)\n", call)
				body.WriteString("\tif err := it.Err(); err != nil {\n\t\tt.Fatalf(\"unexpected error: %v\", err)\n\t}\n\n")
			case m.Response.Kind == "empty":
				fmt.Fprintf(&body, "\tif err := %s; err != nil {\n\t\tt.Fatalf(\"unexpected error: %%v\", err)\n\t}\n\n", call)
			default:
				fmt.Fprintf(&body, "\tif _, err := %s; err != nil {\n\t\tt.Fatalf(\"unexpected error: %%v\", err)\n\t}\n\n", call)
			}

			body.WriteString("\tif seen == nil {\n\t\tt.Fatal(\"no request reached the server\")\n\t}\n")
			fmt.Fprintf(&body, "\tif seen.Method != %s {\n\t\tt.Errorf(\"method = %%s, want %s\", seen.Method)\n\t}\n",
				GoString(strings.ToUpper(m.HTTP.Verb)), strings.ToUpper(m.HTTP.Verb))
			fmt.Fprintf(&body, "\tif seen.URL.Path != %s {\n\t\tt.Errorf(\"path = %%s, want %%s\", seen.URL.Path, %s)\n\t}\n",
				GoString(examplePath(m)), GoString(examplePath(m)))

			if m.Body != nil && m.Example.Body != nil {
				declared := strings.ToLower(m.Body.ContentType)
				body.WriteString("\n\t// Declared as ")
				body.WriteString(m.Body.ContentType)
				body.WriteString(" in the spec.\n")
				switch {
				case strings.Contains(declared, "x-www-form-urlencoded"):
					body.WriteString("\tif got := seen.Header.Get(\"Content-Type\"); !strings.Contains(got, \"x-www-form-urlencoded\") {\n")
					body.WriteString("\t\tt.Errorf(\"content type = %s, want form encoding\", got)\n\t}\n")
				case strings.HasPrefix(declared, "multipart/"):
					body.WriteString("\tif got := seen.Header.Get(\"Content-Type\"); !strings.HasPrefix(got, \"multipart/\") {\n")
					body.WriteString("\t\tt.Errorf(\"content type = %s, want multipart\", got)\n\t}\n")
				default:
					fmt.Fprintf(&body, "\tif got := seen.Header.Get(\"Content-Type\"); !strings.Contains(got, %s) {\n",
						GoString(m.Body.ContentType))
					fmt.Fprintf(&body, "\t\tt.Errorf(\"content type = %%s, want %s\", got)\n\t}\n", m.Body.ContentType)
					body.WriteString("\tvar decoded any\n")
					body.WriteString("\tif err := json.Unmarshal(sentBody, &decoded); err != nil {\n")
					body.WriteString("\t\tt.Errorf(\"request body was not JSON: %v\", err)\n\t}\n")
				}
			}
			// Declared unconditionally by the handler, so it must be consumed unconditionally: a form or
			// multipart body is asserted by its *content type* and never by its bytes, which left
			// `sentBody` unused and `go vet` rejecting the file. Only the JSON branch reads it.
			if m.Body == nil || m.Example.Body == nil || !strings.Contains(source(&body), "json.Unmarshal") {
				body.WriteString("\t_ = sentBody\n")
			}

			hasOptionalQuery := false
			for j := range m.HTTP.Params {
				p := &m.HTTP.Params[j]
				if p.Location == "query" && !p.Required {
					hasOptionalQuery = true
				}
			}
			if hasOptionalQuery {
				body.WriteString("\n\t// An omitted optional query parameter must not reach the wire at all. A generator\n")
				body.WriteString("\t// serializing a nil pointer would send `?since=%21BADPOINTER`, which a server reads as\n")
				body.WriteString("\t// a value — a bug this SDK has actually shipped.\n")
				body.WriteString("\tfor key, values := range seen.URL.Query() {\n")
				body.WriteString("\t\tfor _, value := range values {\n")
				body.WriteString("\t\t\tif strings.Contains(value, \"0x\") || value == \"<nil>\" {\n")
				body.WriteString("\t\t\t\tt.Errorf(\"query %s carried a pointer: %s\", key, value)\n\t\t\t}\n")
				body.WriteString("\t\t}\n\t}\n")
			}
			body.WriteString("}\n")

			file := NewFile(e.pkg,
				e.brand.GeneratedNotice,
				"",
				fmt.Sprintf("%s.%s — %s %s", entry.Path, Exported(m.Name), strings.ToUpper(m.HTTP.Verb), m.HTTP.Path),
				"",
				"Generated from the spec. Asserts the request this SDK builds and that the declared",
				"response decodes; it asserts nothing about the API being up, because it never calls it.",
				"",
				"Regenerated on every run and not preserved — edit the spec, not this file.",
			)
			source := body.String()
			for _, name := range []string{"context", "io", "net/http", "net/http/httptest", "testing"} {
				file.Import(name)
			}
			if strings.Contains(source, "strings.") {
				file.Import("strings")
			}
			if strings.Contains(source, "json.") {
				file.Import("encoding/json")
			}
			if e.usesCoreHelpers(source) {
				file.Import(e.coreImport())
			}
			file.Add(source)
			rendered, err := file.Render()
			if err != nil {
				return nil, err
			}
			files = append(files, GeneratedFile{
				Path:     "operation_" + operationSlug(entry.Path, m) + "_test.go",
				Contents: rendered,
			})
		}
	}
	return files, nil
}
