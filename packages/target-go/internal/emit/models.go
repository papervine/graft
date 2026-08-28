package emit

import (
	"encoding/json"
	"fmt"
	"strings"
)

// models emits every declared type into one file.
//
// One file rather than one per resource: Go has no cross-file visibility distinction inside a
// package, so splitting them would be organisational only — and a single `models.go` is what most Go
// SDKs ship, so it is where a reader looks.
func (e *Emitter) models() (string, error) {
	file := NewFile(e.pkg,
		e.brand.GeneratedNotice,
		"",
		"Data models.",
	)
	e.types.Into(file)

	for i := range e.ir.Types {
		named := &e.ir.Types[i]
		switch named.Kind {
		case "enum":
			file.Add(e.enumDecl(named))
		case "alias":
			file.Add(e.aliasDecl(named))
		default:
			file.Add(e.structDecl(named))
		}
	}
	return file.Render()
}

// enumDecl emits a named string type plus its constants.
//
// Open by construction: an unknown value is still a valid Role, so a server adding one does not turn
// into a decode failure. That is the same property the TypeScript target gets from unioning with
// `(string & {})` and Python from unioning with `str` — Go gets it for free.
func (e *Emitter) enumDecl(named *NamedType) string {
	name := e.types.Declared(named.ID)
	var b strings.Builder

	extra := []string{"The server may add values, so an unrecognised value is preserved rather than rejected."}
	if !named.Open {
		extra = nil
	}
	b.WriteString(DocComment("", name, named.Docs, extra...))
	fmt.Fprintf(&b, "type %s string\n", name)

	if len(named.Members) == 0 {
		return b.String()
	}
	b.WriteString("\nconst (\n")
	for _, member := range named.Members {
		var literal string
		if err := json.Unmarshal(member.WireValue, &literal); err != nil {
			// A non-string enum member cannot be a constant of a string type. Rendered from its raw
			// JSON so the value survives rather than being dropped.
			literal = strings.Trim(string(member.WireValue), `"`)
		}
		// Claimed against the whole package, not just this enum: constants share Go's single
		// package namespace with types.
		constName := e.types.ClaimPackageName(
			Exported(Name{Tokens: append(append([]string{}, named.Name.Tokens...), member.Name.Tokens...)}))
		fmt.Fprintf(&b, "\t%s %s = %s\n", constName, name, GoString(literal))
	}
	b.WriteString(")\n")
	return b.String()
}

func (e *Emitter) aliasDecl(named *NamedType) string {
	name := e.types.Declared(named.ID)
	var b strings.Builder
	b.WriteString(DocComment("", name, named.Docs))
	fmt.Fprintf(&b, "type %s = %s\n", name, e.types.Render(named.Target, false))
	return b.String()
}

// structDecl emits a struct for an object type.
//
// The read/write split decides pointer-ness, which is the Go form of the same distinction pydantic and
// TypedDict express in Python: a *read* model's optional field is a pointer so a caller can tell
// "absent" from "zero", and a *write* model's optional field is a pointer plus `omitempty` so an
// unset field is not serialised as `0` or `""`. Sending `{"limit": 0}` when the caller said nothing is
// a real bug, and `omitempty` on a value type causes exactly that.
func (e *Emitter) structDecl(named *NamedType) string {
	name := e.types.Declared(named.ID)
	var b strings.Builder

	var extra []string
	if named.Cyclic {
		extra = append(extra, "This type is recursive.")
	}
	b.WriteString(DocComment("", name, named.Docs, extra...))
	fmt.Fprintf(&b, "type %s struct {\n", name)

	used := map[string]bool{}
	for i := range named.Fields {
		field := &named.Fields[i]
		fieldName := UniqueField(field.Name, used)

		var notes []string
		if field.Deprecated {
			notes = append(notes, "Deprecated: this field is deprecated.")
		}
		if field.ServerOwned {
			notes = append(notes, "Assigned by the server.")
		}
		if variants := e.types.UnionVariants(&field.Type); len(variants) > 1 {
			// A union renders as `any`, so the variants have to be documented or the caller has
			// nothing to type-switch on.
			notes = append(notes, "One of: "+strings.Join(variants, ", ")+".")
		}
		doc := DocComment("\t", fieldName, field.Docs, notes...)
		b.WriteString(doc)

		// A required field is a value, except where that would make the struct infinitely sized.
		pointer := !field.Required || e.cycles.MustPointer(named.ID, field)
		goType := e.types.Render(&field.Type, pointer)
		tag := field.WireName
		if !field.Required {
			tag += ",omitempty"
		}
		fmt.Fprintf(&b, "\t%s %s `json:%s`\n", fieldName, goType, GoString(tag))
		if doc != "" && i < len(named.Fields)-1 {
			b.WriteString("\n")
		}
	}

	if named.Additional != nil {
		// Go's encoder cannot merge a map into the surrounding object, so open schemas keep their
		// extra keys in a named field rather than silently dropping them. Named `Extra` and tagged
		// `-` so it round-trips only when the caller populates it deliberately.
		b.WriteString("\n\t// Extra holds properties the API returned that are not in the contract.\n")
		b.WriteString("\t// Populated only when the caller decodes into it deliberately.\n")
		fmt.Fprintf(&b, "\tExtra map[string]%s `json:\"-\"`\n", e.types.Render(named.Additional, false))
	}

	b.WriteString("}\n")
	return b.String()
}

// errors emits a type per declared status the runtime does not cover.
func (e *Emitter) errors() (string, error) {
	entries := e.generatedErrors()
	file := NewFile(e.pkg,
		e.brand.GeneratedNotice,
		"",
		"Error types for statuses this API declares that the runtime does not special-case.",
		"Each embeds *core.APIError, so errors.As matches either the specific type or the general one.",
	)
	file.Import(e.coreImport())

	for _, entry := range entries {
		name := Exported(entry.Name)
		var b strings.Builder
		b.WriteString(DocComment("", name, entry.Docs,
			fmt.Sprintf("It is returned for HTTP %d.", entry.StatusCode)))
		fmt.Fprintf(&b, "type %s struct {\n\t*core.APIError\n}\n\n", name)
		fmt.Fprintf(&b, "// Unwrap returns the underlying *core.APIError.\n")
		fmt.Fprintf(&b, "func (e *%s) Unwrap() error { return e.APIError }\n", name)
		file.Add(b.String())
	}
	return file.Render()
}
