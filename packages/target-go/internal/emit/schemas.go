package emit

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Emitting runtime validation descriptors (SPEC.md §3.4.1.1).
//
// **Embedded as compact JSON, not as Go struct literals.** This is the one place Go's version differs
// from TypeScript's, and it is a size decision: `Schema{K: SchemaObject, F: []SchemaField{{Name: …}}}`
// is several times the bytes of `{"k":"obj","f":[{"n":…}]}`, and Stripe's table is a few thousand
// descriptors. A large Go literal is also markedly slower to compile. The blob is parsed once at
// package initialisation, which costs a few milliseconds and nothing per request.
//
// Only types reachable from a *response* get a descriptor: a spec's type graph is much larger than its
// response graph, and a descriptor for a type that can never arrive is pure weight.

type descriptorField struct {
	Name     string     `json:"n"`
	Schema   descriptor `json:"s"`
	Required bool       `json:"r,omitempty"`
}

// descriptor mirrors the runtime's Schema. Duplicated rather than imported because a target must not
// depend on the runtime it vendors — the runtime is data to it, not a library.
type descriptor struct {
	K string            `json:"k"`
	I *descriptor       `json:"i,omitempty"`
	V *descriptor       `json:"v,omitempty"`
	F []descriptorField `json:"f,omitempty"`
	A *descriptor       `json:"a,omitempty"`
	O []descriptor      `json:"o,omitempty"`
	N string            `json:"n,omitempty"`
}

type schemaPlan struct {
	// table maps an emitted type name to its descriptor.
	table map[string]descriptor
	// responses maps `resourceID#method` to the descriptor for that operation's response.
	responses map[string]descriptor
	// items maps `Resource.Method.item` to the descriptor for a paginated method's element type.
	items map[string]descriptor
}

func (e *Emitter) planSchemas() *schemaPlan {
	plan := &schemaPlan{
		table:     map[string]descriptor{},
		responses: map[string]descriptor{},
		items:     map[string]descriptor{},
	}
	if e.validation == "off" {
		return plan
	}

	byID := map[string]*NamedType{}
	for i := range e.ir.Types {
		byID[e.ir.Types[i].ID] = &e.ir.Types[i]
	}
	started := map[string]bool{}

	var describe func(ref *TypeRef) descriptor
	var ensure func(typeID, name string)

	describe = func(ref *TypeRef) descriptor {
		if ref == nil {
			return descriptor{K: "any"}
		}
		switch ref.Kind {
		case "primitive":
			switch ref.Type {
			case "string":
				return descriptor{K: "str"}
			case "integer":
				return descriptor{K: "int"}
			case "number":
				return descriptor{K: "num"}
			case "boolean":
				return descriptor{K: "bool"}
			}
			return descriptor{K: "any"}
		case "array":
			inner := describe(ref.Items)
			return descriptor{K: "arr", I: &inner}
		case "map":
			inner := describe(ref.Values)
			return descriptor{K: "map", V: &inner}
		case "nullable":
			inner := describe(ref.Inner)
			return descriptor{K: "null", I: &inner}
		case "named":
			name := e.types.Declared(ref.ID)
			ensure(ref.ID, name)
			return descriptor{K: "ref", N: name}
		case "union":
			branches := make([]descriptor, 0, len(ref.Variants))
			for i := range ref.Variants {
				branches = append(branches, describe(&ref.Variants[i]))
			}
			if len(branches) == 0 {
				return descriptor{K: "any"}
			}
			return descriptor{K: "or", O: branches}
		case "binary":
			// A binary inside a JSON body is a base64 string; a binary *response* never reaches the
			// JSON validator at all.
			return descriptor{K: "str"}
		case "literal":
			// Validated as its base type, for the same reason an enum is: a server widening it must
			// not become a decode failure.
			return descriptor{K: "str"}
		}
		return descriptor{K: "any"}
	}

	ensure = func(typeID, name string) {
		if started[name] {
			return
		}
		started[name] = true
		named, ok := byID[typeID]
		if !ok {
			plan.table[name] = descriptor{K: "any"}
			return
		}
		// Reserved before recursing, so a self-reference finds the key present and emits a ref rather
		// than looping.
		plan.table[name] = descriptor{K: "any"}
		plan.table[name] = describeNamedSchema(named, describe)
	}

	for _, resource := range e.allResources() {
		for i := range resource.Methods {
			method := &resource.Methods[i]
			if method.Response.Kind != "json" {
				continue
			}
			key := resource.ID + "#" + strings.Join(method.Name.Tokens, ".")
			plan.responses[key] = describe(method.Response.Type)

			if method.PaginationID != "" {
				if scheme := e.paginationScheme(method); scheme != nil {
					if ref := e.pageItemRef(method, scheme); ref != nil {
						plan.items[e.operationKey(resource, method)+".item"] = describe(ref)
					}
				}
			}
		}
	}
	return plan
}

func describeNamedSchema(named *NamedType, describe func(*TypeRef) descriptor) descriptor {
	switch named.Kind {
	case "enum":
		// Base type only, never membership. Servers add enum values without warning, and the
		// open-enum rule exists precisely so that does not break a client.
		return descriptor{K: "str"}
	case "alias":
		return describe(named.Target)
	case "object":
		fields := make([]descriptorField, 0, len(named.Fields))
		for i := range named.Fields {
			field := &named.Fields[i]
			fields = append(fields, descriptorField{
				Name:     field.WireName,
				Schema:   describe(&field.Type),
				Required: field.Required,
			})
		}
		out := descriptor{K: "obj", F: fields}
		if named.Additional != nil {
			additional := describe(named.Additional)
			out.A = &additional
		}
		return out
	}
	return descriptor{K: "any"}
}

// responseDescriptors maps each operation to the shape of its response, keyed as a caller writes it.
//
// Extracted from schemasFile because the decision to *emit* that file depends on it. The gate used to
// read `len(schemas.table) > 0` — the table of named types — while `responseSchemas` lives in the same
// file and is referenced by any method whose response has a descriptor at all. A spec returning
// `[]string` from every operation has no named types and non-empty responses, so the file was skipped
// and the generated SDK referenced two undefined symbols. It compiled for every corpus spec because
// each of them happens to declare named types.
func (e *Emitter) responseDescriptors() map[string]descriptor {
	responses := map[string]descriptor{}
	for _, resource := range e.allResources() {
		for i := range resource.Methods {
			method := &resource.Methods[i]
			key := resource.ID + "#" + strings.Join(method.Name.Tokens, ".")
			found, ok := e.schemas.responses[key]
			if !ok || found.K == "any" {
				continue
			}
			responses[e.operationKey(resource, method)] = found
		}
	}
	for key, found := range e.schemas.items {
		if found.K != "any" {
			responses[key] = found
		}
	}
	return responses
}

// schemasFile emits the embedded descriptor table.
func (e *Emitter) schemasFile() (string, error) {
	file := NewFile(e.pkg,
		e.brand.GeneratedNotice,
		"",
		"Runtime validation descriptors.",
		"",
		"Embedded as compact JSON and parsed once at package initialisation. Go struct literals for the",
		"same data would be several times larger and slower to compile.",
	)
	file.Import(e.coreImport())

	encoded, err := json.Marshal(plainTable(e.schemas.table))
	if err != nil {
		return "", fmt.Errorf("encoding schema table: %w", err)
	}

	literal, err := goRawString(string(encoded))
	if err != nil {
		return "", err
	}

	responseLiteral, err := goRawString(string(plainTable(e.responseDescriptors())))
	if err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString("// schemaJSON is the descriptor table for every type reachable from a response.\n")
	fmt.Fprintf(&b, "const schemaJSON = %s\n\n", literal)
	b.WriteString("// responseSchemaJSON maps each operation to the shape of its response.\n")
	fmt.Fprintf(&b, "const responseSchemaJSON = %s\n\n", responseLiteral)
	b.WriteString("// Parsed once, at package initialisation. A per-call parse would be a per-request\n")
	b.WriteString("// cost for data that never changes.\n")
	b.WriteString("var (\n")
	b.WriteString("\tschemas         = core.MustParseSchemaTable(schemaJSON)\n")
	b.WriteString("\tresponseSchemas = core.MustParseSchemaTable(responseSchemaJSON)\n")
	b.WriteString(")\n")
	file.Add(b.String())
	return file.Render()
}

// plainTable sorts the table so output is byte-stable across runs. Go's map iteration order is
// deliberately random, and an unstable generated file makes every regeneration a spurious diff.
func plainTable(table map[string]descriptor) json.RawMessage {
	names := make([]string, 0, len(table))
	for name := range table {
		names = append(names, name)
	}
	sort.Strings(names)

	var b strings.Builder
	b.WriteString("{")
	for i, name := range names {
		if i > 0 {
			b.WriteString(",")
		}
		key, _ := json.Marshal(name)
		value, _ := json.Marshal(table[name])
		b.Write(key)
		b.WriteString(":")
		b.Write(value)
	}
	b.WriteString("}")
	return json.RawMessage(b.String())
}

// goRawString renders a Go string literal for embedded JSON.
//
// A backquoted raw string when possible, because the JSON is full of double quotes and escaping every
// one of them would roughly double the file. A backquote in the payload makes that impossible — a spec
// could name a field with one — so that case falls back to a quoted literal rather than emitting
// something that does not parse.
func goRawString(payload string) (string, error) {
	if !strings.ContainsAny(payload, "`\r") {
		return "`" + payload + "`", nil
	}
	return fmt.Sprintf("%q", payload), nil
}

// responseSchemaLookup returns the Go expression for an operation's response descriptor, or "" when
// there is nothing worth checking.
//
// A **map lookup**, not a parse. The first version emitted `core.MustParseSchema("{…}")` inline, which
// would have decoded JSON on every single API call — a per-request cost for data that never changes.
// Response descriptors go into their own embedded table instead, parsed once with the type table.
//
// An `any` descriptor yields "" rather than an entry: validating against "anything" costs a walk and
// can never fail, so emitting it would be overhead in every generated method.
func (e *Emitter) responseSchemaLookup(resource *Resource, method *Method) string {
	if e.validation == "off" {
		return ""
	}
	key := e.operationKey(resource, method)
	found, ok := e.schemas.responses[resource.ID+"#"+strings.Join(method.Name.Tokens, ".")]
	if !ok || found.K == "any" {
		return ""
	}
	return fmt.Sprintf("responseSchemas[%q]", key)
}

// itemSchemaLookup returns the descriptor lookup for a paginated method's *item* type.
//
// Distinct from the response descriptor, which describes the envelope: a paginator validates what it
// hands the caller, and the envelope's own fields are read by path and never handed over.
func (e *Emitter) itemSchemaLookup(resource *Resource, method *Method, scheme *PaginationScheme) string {
	if e.validation == "off" {
		return ""
	}
	ref := e.pageItemRef(method, scheme)
	if ref == nil {
		return ""
	}
	key := e.operationKey(resource, method) + ".item"
	found, ok := e.schemas.items[key]
	if !ok || found.K == "any" {
		return ""
	}
	return fmt.Sprintf("responseSchemas[%q]", key)
}

// operationKey names an operation the way a caller writes it, so a validation error reads as the code
// that produced it.
func (e *Emitter) operationKey(resource *Resource, method *Method) string {
	return Exported(resource.Name) + "." + Exported(method.Name)
}
