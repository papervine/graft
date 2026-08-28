package emit

import (
	"fmt"
	"strings"
)

// TypeMapper resolves IR type ids to Go type names and renders annotations.
//
// Names are assigned once, up front, so every file agrees on what a type is called and a reference
// emitted in one place matches the declaration in another.
type TypeMapper struct {
	byID map[string]string
	defs map[string]*NamedType
	// taken is every package-level name claimed so far. Go puts types, constants, functions, and
	// variables in *one* namespace, so an enum constant can collide with a struct: GitHub declares
	// both a struct `EventComment` and an `Event` enum with a `COMMENT` member, and the second
	// redeclared the first. Reserving only type names was not enough.
	taken map[string]bool
	// current is the file being rendered into. Render requests its own imports rather than setting a
	// flag for the caller to consult: a global "time was used somewhere" flag meant `models.go` got
	// the import and a resource file with a `time.Time` parameter did not, which `go build` caught as
	// an undefined reference. An import belongs to the file that needs it.
	current *File
}

// runtimeExports are identifiers a generated file imports from the vendored runtime. A spec-declared
// model named `Client` or `Page` would shadow one, exactly as a TypeScript model named
// `RequestOptions` shadowed its runtime import.
var runtimeExports = []string{
	"APIError", "Auth", "AuthKind", "Client", "ClientOptions", "ConnectionError",
	"DecodeError", "FilePart", "Iterator", "Page", "Request", "RequestOptions", "SDKError",
	"BadRequestError", "AuthenticationError", "PermissionDeniedError", "NotFoundError",
	"ConflictError", "UnprocessableEntityError", "RateLimitError", "InternalServerError",
	"QueryEncoder",
}

// NewTypeMapper assigns a Go name to every type in the IR.
func NewTypeMapper(ir *IR) *TypeMapper {
	m := &TypeMapper{byID: map[string]string{}, defs: map[string]*NamedType{}, taken: map[string]bool{}}
	taken := m.taken
	for _, name := range runtimeExports {
		taken[name] = true
	}
	for i := range ir.Types {
		named := &ir.Types[i]
		declared := TypeName(named.Name, taken)
		taken[declared] = true
		m.byID[named.ID] = declared
		m.defs[named.ID] = named
	}
	return m
}

// Declared returns the Go name for a type id.
func (m *TypeMapper) Declared(id string) string {
	if name, ok := m.byID[id]; ok {
		return name
	}
	return "any"
}

// Definition returns the IR definition for a type id.
func (m *TypeMapper) Definition(id string) *NamedType { return m.defs[id] }

// Into points the mapper at the file currently being built, so Render can request imports.
func (m *TypeMapper) Into(file *File) { m.current = file }

// ClaimPackageName reserves a package-level name, returning one that is free.
//
// Used for enum constants and for anything else emitted at package scope, so the whole file set
// agrees on what is taken.
func (m *TypeMapper) ClaimPackageName(preferred string) string {
	if !m.taken[preferred] {
		m.taken[preferred] = true
		return preferred
	}
	for i := 2; ; i++ {
		candidate := preferred + itoa(i)
		if !m.taken[candidate] {
			m.taken[candidate] = true
			return candidate
		}
	}
}

// ResolveShape follows a reference through aliases and reports how it must be handled.
//
// Returns the rendered type and whether a composite literal is valid for it. `&T{}` does not compile
// when T is an alias to `any`, a slice, or a map — GitHub has a schema whose type resolves to `any`,
// and the generated `out := &CopilotSpaceCollaborator{}` was a build error.
func (m *TypeMapper) ResolveShape(ref *TypeRef) (rendered string, composite bool) {
	rendered = m.Render(ref, false)
	if rendered == "any" || strings.HasPrefix(rendered, "[]") || strings.HasPrefix(rendered, "map[") {
		return rendered, false
	}
	if ref != nil && ref.Kind == "named" {
		// An alias is transparent: `type X = any` makes `&X{}` just as invalid as `&any{}`.
		for depth := 0; depth < 8; depth++ {
			named := m.Definition(ref.ID)
			if named == nil || named.Kind != "alias" || named.Target == nil {
				break
			}
			inner := m.Render(named.Target, false)
			if inner == "any" || strings.HasPrefix(inner, "[]") || strings.HasPrefix(inner, "map[") {
				return rendered, false
			}
			if named.Target.Kind != "named" {
				break
			}
			ref = named.Target
		}
		// An enum is a string type, so a composite literal is wrong for it too.
		if named := m.Definition(ref.ID); named != nil && named.Kind == "enum" {
			return rendered, false
		}
	}
	return rendered, true
}

// Render renders a type reference as a Go type.
//
// `pointer` requests the optional form. Go expresses "may be absent" as a pointer and has no other
// mechanism, so this is where the presence distinction from §3.1 lands.
func (m *TypeMapper) Render(ref *TypeRef, pointer bool) string {
	base := m.render(ref)
	if !pointer {
		return base
	}
	// A slice, map, or `any` is already nilable; wrapping it in a pointer buys nothing and makes
	// every call site worse. `*[]string` is a tell-tale sign of a generator that did not think.
	switch {
	case base == "any", len(base) > 2 && base[:2] == "[]", len(base) > 4 && base[:4] == "map[":
		return base
	}
	return "*" + base
}

func (m *TypeMapper) render(ref *TypeRef) string {
	if ref == nil {
		return "any"
	}
	switch ref.Kind {
	case "primitive":
		return m.primitive(ref)
	case "named":
		return m.Declared(ref.ID)
	case "array":
		return "[]" + m.render(ref.Items)
	case "map":
		return "map[string]" + m.render(ref.Values)
	case "nullable":
		// Nullability and absence collapse into the same pointer in Go. Unavoidable: the language has
		// one mechanism. The json tag preserves the distinction on the wire.
		inner := m.render(ref.Inner)
		switch {
		case inner == "any", len(inner) > 2 && inner[:2] == "[]", len(inner) > 4 && inner[:4] == "map[":
			return inner
		}
		return "*" + inner
	case "binary":
		return "[]byte"
	case "null":
		return "any"
	case "literal":
		return "string"
	case "union":
		return m.union(ref)
	case "unknown":
		return "any"
	}
	return "any"
}

// union renders a union type.
//
// Go has no sum type, so a union becomes `any`. That is honest rather than lazy: the alternatives are
// an interface with unexported marker methods (which callers cannot type-switch usefully without
// importing every variant) or a struct with one field per variant (which permits illegal states).
// Both are worse than `any` plus documentation naming the variants, which is what Stripe's Go SDK
// settled on for the same reason.
func (m *TypeMapper) union(ref *TypeRef) string {
	if len(ref.Variants) == 0 {
		return "any"
	}
	// A nullable-shaped union of exactly one real variant plus null is just a pointer.
	var real []TypeRef
	for _, variant := range ref.Variants {
		if variant.Kind != "null" {
			real = append(real, variant)
		}
	}
	if len(real) == 1 {
		return m.render(&real[0])
	}
	return "any"
}

// UnionVariants returns the rendered variant names of a union, for a doc comment.
func (m *TypeMapper) UnionVariants(ref *TypeRef) []string {
	if ref == nil || ref.Kind != "union" {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for i := range ref.Variants {
		rendered := m.render(&ref.Variants[i])
		if rendered == "any" || seen[rendered] {
			continue
		}
		seen[rendered] = true
		out = append(out, rendered)
	}
	return out
}

func (m *TypeMapper) primitive(ref *TypeRef) string {
	switch ref.Type {
	case "string":
		switch ref.Format {
		case "date-time", "date":
			if m.current != nil {
				m.current.Import("time")
			}
			return "time.Time"
		case "binary":
			return "[]byte"
		}
		return "string"
	case "integer":
		// int64 rather than int: a JSON number can exceed 32 bits, and an SDK that silently
		// truncates an id on a 32-bit build is a bug that only appears in production.
		if ref.Format == "int32" {
			return "int32"
		}
		return "int64"
	case "number":
		return "float64"
	case "boolean":
		return "bool"
	case "null":
		return "any"
	}
	return "any"
}

// ReferencedNames collects the declared type names a reference reaches, for import resolution and
// for the sanity check.
func (m *TypeMapper) ReferencedNames(ref *TypeRef, into map[string]bool) {
	if ref == nil {
		return
	}
	switch ref.Kind {
	case "named":
		into[m.Declared(ref.ID)] = true
	case "array":
		m.ReferencedNames(ref.Items, into)
	case "map":
		m.ReferencedNames(ref.Values, into)
	case "nullable":
		m.ReferencedNames(ref.Inner, into)
	case "union":
		for i := range ref.Variants {
			m.ReferencedNames(&ref.Variants[i], into)
		}
	}
}

// GoString renders a Go string literal.
func GoString(s string) string { return fmt.Sprintf("%q", s) }
