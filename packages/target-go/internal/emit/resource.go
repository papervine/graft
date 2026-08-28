package emit

import (
	"fmt"
	"strings"
)

// unsupported explains why a method cannot be generated, or returns "" when it can.
//
// Nothing today. Kept because the resource emitter is built around it — a target that can skip an
// operation needs the decision made before the file's imports are chosen (see `resource`), and
// rediscovering that is more expensive than keeping the seam.
func unsupported(m *Method) string {
	_ = m
	return ""
}

// resource emits one file per resource, containing its struct and its methods.
func (e *Emitter) resource(r *Resource) (string, error) {
	typeName := e.resourceType(r)

	// Which methods can be generated is settled *before* the file, because it decides the imports: a
	// resource whose only operation is skipped would otherwise import `context` and never use it, which
	// `go build` rejects. A skipped method still leaves the resource — its sub-resources and accessor are
	// unaffected — so an empty one is a valid file, not an error.
	var methods []*Method
	for i := range r.Methods {
		m := &r.Methods[i]
		if reason := unsupported(m); reason != "" {
			e.warnings = append(e.warnings, Warning{
				Code:     "GO002",
				Severity: "warn",
				Message: "The Go target does not support " + reason + " yet, so `" +
					r.ID + "." + LocalName(m.Name) + "` was not generated.",
			})
			continue
		}
		methods = append(methods, m)
	}

	file := NewFile(e.pkg,
		e.brand.GeneratedNotice,
		"",
		fmt.Sprintf("The %s resource.", strings.Join(r.Name.Tokens, " ")),
	)
	if len(methods) > 0 {
		file.Import("context")
	}
	file.Import(e.coreImport())
	e.types.Into(file)

	// The struct and its sub-resources.
	var b strings.Builder
	b.WriteString(DocComment("", typeName, r.Docs,
		fmt.Sprintf("Reached as client.%s.", Exported(r.Name))))
	fmt.Fprintf(&b, "type %s struct {\n\tclient *core.Client\n", typeName)
	for i := range r.Subresources {
		sub := &r.Subresources[i]
		fmt.Fprintf(&b, "\n%s", DocComment("\t", Exported(sub.Name), sub.Docs))
		fmt.Fprintf(&b, "\t%s *%s\n", Exported(sub.Name), e.resourceType(sub))
	}
	b.WriteString("}\n")
	file.Add(b.String())

	// The constructor. Unexported: a resource is only ever built by the client.
	var ctor strings.Builder
	fmt.Fprintf(&ctor, "func new%s(client *core.Client) *%s {\n", typeName, typeName)
	fmt.Fprintf(&ctor, "\treturn &%s{\n\t\tclient: client,\n", typeName)
	for i := range r.Subresources {
		sub := &r.Subresources[i]
		fmt.Fprintf(&ctor, "\t\t%s: new%s(client),\n", Exported(sub.Name), e.resourceType(sub))
	}
	ctor.WriteString("\t}\n}\n")
	file.Add(ctor.String())

	for _, m := range methods {
		decl, err := e.method(file, r, m, typeName)
		if err != nil {
			return "", err
		}
		file.Add(decl)
	}

	// Preservation region. A comment, which is exactly why this target is not go/ast based: printing
	// a parsed AST relocates body comments to file scope, so the markers would migrate and the merge
	// step would report an orphan — destroying whatever the user had written between them.
	file.Add(fmt.Sprintf(
		"// Custom methods added between these markers are preserved across regeneration.\n"+
			"// Set `preserve.regions: false` to opt out.\n"+
			"//\n"+
			"// region %s\n"+
			"// endregion %s",
		r.ID, r.ID))

	return file.Render()
}

// paramsTypeName names the params struct for a method, scoped by resource so two resources' List
// params cannot collide.
func (e *Emitter) paramsTypeName(r *Resource, m *Method) string {
	tokens := append(append([]string{}, r.Name.Tokens...), m.Name.Tokens...)
	tokens = append(tokens, "params")
	return Exported(Name{Tokens: tokens})
}

// method emits one method plus its params struct.
//
// Signature shape: context first, path parameters positionally, then a single params pointer, then
// options. `context.Context` first and `error` last are not stylistic in Go — an SDK without them
// cannot be used in a service that needs cancellation or deadlines.
func (e *Emitter) method(file *File, r *Resource, m *Method, recv string) (string, error) {
	pathParams, queryParams, headerParams := splitParams(m.HTTP.Params)
	scheme := e.paginationScheme(m)

	var params []string
	params = append(params, "ctx context.Context")
	for i := range pathParams {
		p := &pathParams[i]
		params = append(params, fmt.Sprintf("%s %s", LocalName(p.Name), e.types.Render(&p.Type, false)))
	}

	// A params struct is emitted when there is anything optional to carry. A pointer so `nil` means
	// "no parameters", which keeps the common call site free of an empty struct literal.
	paramsName := e.paramsTypeName(r, m)
	hasParams := len(queryParams)+len(headerParams) > 0 || m.Body != nil
	if hasParams {
		params = append(params, fmt.Sprintf("params *%s", paramsName))
	}
	params = append(params, "opts *core.RequestOptions")

	returnType, decodeCall, returnsValue := e.returnShape(m, scheme)

	var b strings.Builder
	methodName := Exported(m.Name)
	var notes []string
	if m.Deprecated {
		notes = append(notes, "Deprecated: this operation is deprecated.")
	}
	if scheme != nil {
		// One string, not one per line: DocComment separates *paragraphs* with a bare `//`, so
		// passing each line individually put a blank comment line between every line of the example.
		notes = append(notes, strings.Join([]string{
			"It returns an iterator that walks every page:",
			"",
			fmt.Sprintf("\tit := client.%s.%s(ctx, nil)", Exported(r.Name), methodName),
			"\tfor it.Next(ctx) {",
			"\t\titem := it.Current()",
			"\t}",
			"\tif err := it.Err(); err != nil {",
			"\t\treturn err",
			"\t}",
		}, "\n"))
	}
	b.WriteString(DocComment("", methodName, m.Docs, notes...))
	fmt.Fprintf(&b, "func (r *%s) %s(%s) %s {\n", recv, methodName, strings.Join(params, ", "), returnType)

	body := e.methodBody(file, r, m, scheme, pathParams, queryParams, headerParams, hasParams, decodeCall, returnsValue)
	b.WriteString(body)
	b.WriteString("}\n")

	if hasParams {
		b.WriteString("\n")
		b.WriteString(e.paramsStruct(paramsName, methodName, m, queryParams, headerParams))
	}
	return b.String(), nil
}

// paramsStruct emits the parameters struct for a method.
func (e *Emitter) paramsStruct(name, methodName string, m *Method, query, header []Param) string {
	var b strings.Builder
	fmt.Fprintf(&b, "// %s are the parameters for %s.\n", name, methodName)
	fmt.Fprintf(&b, "type %s struct {\n", name)

	used := map[string]bool{}
	if m.Body != nil {
		// The body is a field rather than a separate argument, so a method never has two struct
		// pointers a caller could transpose.
		bodyType := e.types.Render(&m.Body.Type, false)
		b.WriteString("\t// Body is the request body.\n")
		fmt.Fprintf(&b, "\tBody %s `json:\"-\"`\n", bodyType)
		used["Body"] = true
	}
	for _, group := range [][]Param{query, header} {
		for i := range group {
			p := &group[i]
			fieldName := UniqueField(p.Name, used)
			doc := DocComment("\t", fieldName, p.Docs)
			if doc != "" {
				b.WriteString("\n")
				b.WriteString(doc)
			}
			fmt.Fprintf(&b, "\t%s %s `json:\"-\"`\n", fieldName, e.types.Render(&p.Type, !p.Required))
		}
	}
	b.WriteString("}\n")
	return b.String()
}

// returnShape decides the return type, how to decode into it, and whether the result is returned by
// value rather than by pointer.
func (e *Emitter) returnShape(m *Method, scheme *PaginationScheme) (returnType, decodeCall string, returnsValue bool) {
	if scheme != nil {
		item := e.pageItemType(m, scheme)
		return fmt.Sprintf("*core.Iterator[%s]", item), "", false
	}
	switch m.Response.Kind {
	case "json":
		rendered, composite := e.types.ResolveShape(m.Response.Type)
		if rendered == "any" {
			return "(any, error)", "any", true
		}
		// A pointer for a struct result, a value for a slice or map: `*[]Widget` would make every
		// caller dereference before ranging. A type that cannot take a composite literal — an alias
		// to `any`, or a string-based enum — is returned by value for the same reason.
		if !composite || strings.HasPrefix(rendered, "[]") || strings.HasPrefix(rendered, "map[") {
			return fmt.Sprintf("(%s, error)", rendered), rendered, true
		}
		return fmt.Sprintf("(*%s, error)", rendered), rendered, false
	case "text":
		return "(string, error)", "string", false
	case "binary":
		return "([]byte, error)", "bytes", false
	case "stream":
		return "(io.ReadCloser, error)", "stream", false
	}
	return "error", "", false
}

func splitParams(params []Param) (path, query, header []Param) {
	for _, p := range params {
		switch p.Location {
		case "path":
			path = append(path, p)
		case "query":
			query = append(query, p)
		case "header":
			header = append(header, p)
		}
	}
	return path, query, header
}

// paginationScheme resolves a method's pagination scheme.
//
// The IR field is `paginationId` — a reference into IR.pagination, not an inline scheme. Reading the
// wrong field is what made the Python target emit every paginated method as a single-page request, an
// SDK that passed every gate and silently truncated results.
func (e *Emitter) paginationScheme(m *Method) *PaginationScheme {
	if m.PaginationID == "" {
		return nil
	}
	for i := range e.ir.Pagination {
		if e.ir.Pagination[i].ID == m.PaginationID {
			return &e.ir.Pagination[i]
		}
	}
	return nil
}

// pageItemRef finds the IR reference for the elements a paginated method yields.
func (e *Emitter) pageItemRef(m *Method, scheme *PaginationScheme) *TypeRef {
	ref := m.Response.Type
	if ref == nil {
		return nil
	}
	if ref.Kind == "array" {
		return ref.Items
	}
	if ref.Kind == "named" && scheme.ItemsSource != nil && scheme.ItemsSource.Kind == "body" && len(scheme.ItemsSource.Path) > 0 {
		if named := e.types.Definition(ref.ID); named != nil {
			wanted := scheme.ItemsSource.Path[0]
			for i := range named.Fields {
				field := &named.Fields[i]
				if field.WireName == wanted && field.Type.Kind == "array" {
					return field.Type.Items
				}
			}
		}
	}
	return nil
}

// pageItemType renders the element type a paginated method yields.
func (e *Emitter) pageItemType(m *Method, scheme *PaginationScheme) string {
	ref := e.pageItemRef(m, scheme)
	if ref == nil {
		return "any"
	}
	return e.types.Render(ref, false)
}
