package emit

import (
	"fmt"
	"strings"
)

// methodBody renders the statements inside a generated method.
//
// Local names are picked against the parameter names, never hardcoded. The Python target shipped a
// bug here: an operation with a query parameter called `query` shadowed the local `query` the body
// built, so the request sent a string where a mapping belonged. The spec chooses the identifiers.
func (e *Emitter) methodBody(
	file *File,
	resource *Resource,
	m *Method,
	scheme *PaginationScheme,
	pathParams, queryParams, headerParams []Param,
	hasParams bool,
	decodeCall string,
	returnsValue bool,
) string {
	locals := newLocalNames(pathParams)
	var b strings.Builder

	pathExpr := e.pathExpression(file, m.HTTP.Path, pathParams)

	// Query and header assembly. Guarded on `params != nil` because the pointer is optional.
	buildQuery := func(indent string) {
		if len(queryParams) == 0 {
			return
		}
		fmt.Fprintf(&b, "%s%s := core.NewQueryEncoder()\n", indent, locals.query)
		fmt.Fprintf(&b, "%sif params != nil {\n", indent)
		for i := range queryParams {
			p := &queryParams[i]
			fmt.Fprintf(&b, "%s\t%s.Add(%s, params.%s)\n", indent, locals.query, GoString(p.WireName), FieldName(p.Name))
		}
		fmt.Fprintf(&b, "%s}\n", indent)
	}
	buildHeader := func(indent string) {
		if len(headerParams) == 0 {
			return
		}
		file.Import("net/http")
		fmt.Fprintf(&b, "%s%s := http.Header{}\n", indent, locals.header)
		fmt.Fprintf(&b, "%sif params != nil {\n", indent)
		for i := range headerParams {
			p := &headerParams[i]
			field := FieldName(p.Name)
			if p.Required {
				fmt.Fprintf(&b, "%s\t%s.Set(%s, core.EncodePath(params.%s))\n", indent, locals.header, GoString(p.WireName), field)
			} else {
				// core.EncodePath takes `any` and handles a nil pointer, so no deref is needed here
				// whatever the rendered type turned out to be.
				fmt.Fprintf(&b, "%s\tif params.%s != nil {\n", indent, field)
				fmt.Fprintf(&b, "%s\t\t%s.Set(%s, core.EncodePath(params.%s))\n", indent, locals.header, GoString(p.WireName), field)
				fmt.Fprintf(&b, "%s\t}\n", indent)
			}
		}
		fmt.Fprintf(&b, "%s}\n", indent)
	}

	if scheme != nil {
		return e.paginatedBody(file, resource, m, scheme, locals, pathExpr, queryParams, headerParams)
	}

	buildQuery("\t")
	buildHeader("\t")

	// The request literal.
	fmt.Fprintf(&b, "\t%s := &core.Request{\n", locals.req)
	fmt.Fprintf(&b, "\t\tMethod: %s,\n", GoString(m.HTTP.Verb))
	fmt.Fprintf(&b, "\t\tPath:   %s,\n", pathExpr)
	if len(queryParams) > 0 {
		fmt.Fprintf(&b, "\t\tQuery:  %s.Values(),\n", locals.query)
	}
	if len(headerParams) > 0 {
		fmt.Fprintf(&b, "\t\tHeader: %s,\n", locals.header)
	}
	fmt.Fprintf(&b, "\t\tOptions: opts,\n")
	// The encoding the spec declared, not a default. Sending JSON to an
	// `application/x-www-form-urlencoded` endpoint is a request the server rejects, and it was every
	// write operation of every form-based API before this line existed.
	if m.Body != nil {
		declared := strings.ToLower(m.Body.ContentType)
		switch {
		case strings.Contains(declared, "x-www-form-urlencoded"):
			b.WriteString("\t\tFormEncoded: true,\n")
		case strings.HasPrefix(declared, "multipart/"):
			// The runtime splits the body by value type — a []byte or io.Reader is a file part. Setting a
			// flag rather than assembling parts here keeps "which field is a file" a single decision.
			b.WriteString("\t\tMultipartBody: true,\n")
		}
	}
	b.WriteString("\t}\n")
	if m.Body != nil && hasParams {
		// Assigned after the literal so a nil params pointer cannot panic.
		fmt.Fprintf(&b, "\tif params != nil {\n\t\t%s.Body = params.Body\n\t}\n", locals.req)
	}

	switch decodeCall {
	case "":
		fmt.Fprintf(&b, "\treturn r.client.DoEmpty(ctx, %s)\n", locals.req)
	case "string":
		fmt.Fprintf(&b, "\treturn r.client.DoString(ctx, %s)\n", locals.req)
	case "bytes":
		fmt.Fprintf(&b, "\treturn r.client.DoBytes(ctx, %s)\n", locals.req)
	case "stream":
		file.Import("io")
		fmt.Fprintf(&b, "\treturn r.client.DoStream(ctx, %s)\n", locals.req)
	case "any":
		fmt.Fprintf(&b, "\tvar %s any\n", locals.out)
		fmt.Fprintf(&b, "\tif err := r.client.DoJSON(ctx, %s, &%s); err != nil {\n\t\treturn nil, err\n\t}\n", locals.req, locals.out)
		fmt.Fprintf(&b, "\treturn %s, nil\n", locals.out)
	default:
		// `var out T` then `&out`, never `&T{}`: a composite literal is invalid when T is an alias to
		// `any`, a slice, a map, or a string-based enum type. GitHub has all four.
		fmt.Fprintf(&b, "\tvar %s %s\n", locals.out, decodeCall)
		if lookup := e.responseSchemaLookup(resource, m); lookup != "" {
			// Validated before the bytes reach the typed struct — `encoding/json` discards a type
			// mismatch silently, so checking afterwards could never see it. See SPEC.md §3.4.1.1.
			fmt.Fprintf(&b,
				"\tif err := r.client.DoJSONValidated(ctx, %s, &%s, %s, schemas, %q); err != nil {\n\t\treturn nil, err\n\t}\n",
				locals.req, locals.out, lookup, e.operationKey(resource, m))
		} else {
			fmt.Fprintf(&b, "\tif err := r.client.DoJSON(ctx, %s, &%s); err != nil {\n\t\treturn nil, err\n\t}\n", locals.req, locals.out)
		}
		if returnsValue {
			fmt.Fprintf(&b, "\treturn %s, nil\n", locals.out)
		} else {
			fmt.Fprintf(&b, "\treturn &%s, nil\n", locals.out)
		}
	}
	return b.String()
}

// paginatedBody renders a method that returns an iterator.
//
// The iterator is lazy, so the method itself performs no request and cannot fail — which is why it
// returns only *core.Iterator and not (iterator, error). Errors surface from Err() after the loop,
// the convention bufio.Scanner and sql.Rows both use.
func (e *Emitter) paginatedBody(
	file *File,
	resource *Resource,
	m *Method,
	scheme *PaginationScheme,
	locals *localNames,
	pathExpr string,
	queryParams, headerParams []Param,
) string {
	item := e.pageItemType(m, scheme)
	var b strings.Builder

	// Initial parameters carry the caller's own filters across every page.
	fmt.Fprintf(&b, "\t%s := map[string]any{}\n", locals.initial)
	if len(queryParams) > 0 {
		b.WriteString("\tif params != nil {\n")
		for i := range queryParams {
			p := &queryParams[i]
			field := FieldName(p.Name)
			rendered := e.types.Render(&p.Type, !p.Required)
			switch {
			case p.Required:
				fmt.Fprintf(&b, "\t\t%s[%s] = params.%s\n", locals.initial, GoString(p.WireName), field)
			case strings.HasPrefix(rendered, "*"):
				fmt.Fprintf(&b, "\t\tif params.%s != nil {\n", field)
				fmt.Fprintf(&b, "\t\t\t%s[%s] = *params.%s\n", locals.initial, GoString(p.WireName), field)
				fmt.Fprintf(&b, "\t\t}\n")
			default:
				// A slice, map, or `any` is already nilable, so Render leaves it un-pointered — and
				// dereferencing it does not compile. GitHub has a `creator_id` parameter that is a
				// slice, which made `*params.CreatorID` a build error.
				fmt.Fprintf(&b, "\t\tif params.%s != nil {\n", field)
				fmt.Fprintf(&b, "\t\t\t%s[%s] = params.%s\n", locals.initial, GoString(p.WireName), field)
				fmt.Fprintf(&b, "\t\t}\n")
			}
		}
		b.WriteString("\t}\n")
	}

	if len(headerParams) > 0 {
		file.Import("net/http")
		fmt.Fprintf(&b, "\t%s := http.Header{}\n", locals.header)
		b.WriteString("\tif params != nil {\n")
		for i := range headerParams {
			p := &headerParams[i]
			field := FieldName(p.Name)
			fmt.Fprintf(&b, "\t\tif params.%s != nil {\n", field)
			fmt.Fprintf(&b, "\t\t\t%s.Set(%s, core.EncodePath(params.%s))\n", locals.header, GoString(p.WireName), field)
			fmt.Fprintf(&b, "\t\t}\n")
		}
		b.WriteString("\t}\n")
	}

	// The fetch closure.
	fmt.Fprintf(&b, "\n\t%s := func(ctx context.Context, %s map[string]any) (*core.Page[%s], error) {\n",
		locals.fetch, locals.page, item)
	fmt.Fprintf(&b, "\t\t%s := core.NewQueryEncoder()\n", locals.query)
	fmt.Fprintf(&b, "\t\tfor k, v := range %s {\n\t\t\t%s.Add(k, v)\n\t\t}\n", locals.page, locals.query)
	fmt.Fprintf(&b, "\t\t%s := &core.Request{\n", locals.req)
	fmt.Fprintf(&b, "\t\t\tMethod: %s,\n", GoString(m.HTTP.Verb))
	fmt.Fprintf(&b, "\t\t\tPath:   %s,\n", pathExpr)
	fmt.Fprintf(&b, "\t\t\tQuery:  %s.Values(),\n", locals.query)
	if len(headerParams) > 0 {
		fmt.Fprintf(&b, "\t\t\tHeader: %s,\n", locals.header)
	}
	fmt.Fprintf(&b, "\t\t\tOptions: opts,\n\t\t}\n")

	// Decoded as `any` so the envelope's own fields can be read by path without modelling it.
	fmt.Fprintf(&b, "\t\tvar %s any\n", locals.out)
	fmt.Fprintf(&b, "\t\tif err := r.client.DoJSON(ctx, %s, &%s); err != nil {\n\t\t\treturn nil, err\n\t\t}\n", locals.req, locals.out)

	itemsExpr := e.sourceExpression(locals.out, scheme.ItemsSource)
	fmt.Fprintf(&b, "\t\tvar %s []%s\n", locals.items, item)

	// Items are validated *before* being unmarshalled into the typed slice, for the same reason a
	// single response is (SPEC.md §3.4.1.1): `encoding/json` silently discards a type mismatch, so
	// checking afterwards could never see it.
	//
	// This was missing entirely — a paginated method decoded its items directly and never reached the
	// validating path, so every list response went unchecked. A list method is the most common thing in
	// an SDK, so that was most of the surface.
	if lookup := e.itemSchemaLookup(resource, m, scheme); lookup != "" {
		fmt.Fprintf(&b, "\t\tfor i, raw := range core.AsSlice(%s) {\n", itemsExpr)
		fmt.Fprintf(&b,
			"\t\t\tif problems := core.Validate(raw, %s, schemas); len(problems) > 0 {\n", lookup)
		fmt.Fprintf(&b, "\t\t\t\tif r.client.ValidationMode() == core.ValidationStrict {\n")
		fmt.Fprintf(&b,
			"\t\t\t\t\treturn nil, &core.ResponseValidationError{Operation: %q, Problems: core.PrefixPaths(problems, i)}\n",
			e.operationKey(resource, m))
		fmt.Fprintf(&b, "\t\t\t\t}\n\t\t\t}\n\t\t}\n")
	}

	// Re-marshalled rather than reflected over: encoding/json is the only thing that knows how to
	// turn a decoded `any` into a typed struct, and hand-rolling that would reimplement the decoder.
	file.Import("encoding/json")
	fmt.Fprintf(&b, "\t\tif raw, err := json.Marshal(%s); err == nil {\n", itemsExpr)
	fmt.Fprintf(&b, "\t\t\tif err := json.Unmarshal(raw, &%s); err != nil {\n", locals.items)
	fmt.Fprintf(&b, "\t\t\t\treturn nil, &core.DecodeError{Message: \"decoding page items\", Cause: err}\n")
	fmt.Fprintf(&b, "\t\t\t}\n\t\t}\n")

	fmt.Fprintf(&b, "\t\treturn &core.Page[%s]{\n", item)
	fmt.Fprintf(&b, "\t\t\tItems: %s,\n", locals.items)
	if scheme.CursorSource != nil {
		fmt.Fprintf(&b, "\t\t\tNextCursor: %s,\n", e.readExpression(locals.out, "ReadString", scheme.CursorSource))
	}
	if scheme.TotalSource != nil {
		fmt.Fprintf(&b, "\t\t\tTotal: %s,\n", e.readExpression(locals.out, "ReadInt64", scheme.TotalSource))
	}
	if scheme.HasMoreSource != nil {
		fmt.Fprintf(&b, "\t\t\tHasMore: %s,\n", e.readExpression(locals.out, "ReadBool", scheme.HasMoreSource))
	}
	fmt.Fprintf(&b, "\t\t\tRaw: %s,\n", locals.out)
	fmt.Fprintf(&b, "\t\t}, nil\n\t}\n\n")

	advance := e.advanceExpression(scheme, item)
	fmt.Fprintf(&b, "\treturn core.NewIterator(%s, %s, %s)\n", locals.fetch, advance, locals.initial)
	return b.String()
}

func (e *Emitter) advanceExpression(scheme *PaginationScheme, item string) string {
	switch scheme.Style {
	case "offset":
		limit := scheme.LimitParam
		if limit == "" {
			limit = "limit"
		}
		offset := scheme.OffsetParam
		if offset == "" {
			offset = "offset"
		}
		return fmt.Sprintf("core.AdvanceOffset[%s](%s, %s)", item, GoString(limit), GoString(offset))
	case "page":
		page := scheme.PageParam
		if page == "" {
			page = "page"
		}
		return fmt.Sprintf("core.AdvancePageNumber[%s](%s)", item, GoString(page))
	default:
		cursor := scheme.CursorParam
		if cursor == "" {
			cursor = "cursor"
		}
		return fmt.Sprintf("core.AdvanceCursor[%s](%s)", item, GoString(cursor))
	}
}

// sourceExpression reads the items out of a decoded envelope.
func (e *Emitter) sourceExpression(local string, source *ValueSource) string {
	if source == nil || source.Kind == "root" {
		return local
	}
	if source.Kind == "body" && len(source.Path) > 0 {
		return fmt.Sprintf("core.ReadPath(%s, %s)", local, quotedList(source.Path))
	}
	return local
}

func (e *Emitter) readExpression(local, reader string, source *ValueSource) string {
	if source == nil || source.Kind != "body" || len(source.Path) == 0 {
		if reader == "ReadString" {
			return `""`
		}
		return "nil"
	}
	return fmt.Sprintf("core.%s(%s, %s)", reader, local, quotedList(source.Path))
}

func quotedList(parts []string) string {
	quoted := make([]string, len(parts))
	for i, p := range parts {
		quoted[i] = GoString(p)
	}
	return strings.Join(quoted, ", ")
}

// pathExpression renders the request path, escaping every parameter.
func (e *Emitter) pathExpression(file *File, path string, pathParams []Param) string {
	if len(pathParams) == 0 {
		return GoString(path)
	}
	file.Import("fmt")
	format := path
	var args []string
	for i := range pathParams {
		p := &pathParams[i]
		format = strings.ReplaceAll(format, "{"+p.WireName+"}", "%s")
		// core.EncodePath, not a bare interpolation: an id containing a slash would otherwise
		// address a different endpoint, which is a correctness problem and arguably a security one.
		args = append(args, fmt.Sprintf("core.EncodePath(%s)", LocalName(p.Name)))
	}
	return fmt.Sprintf("fmt.Sprintf(%s, %s)", GoString(format), strings.Join(args, ", "))
}

// localNames holds body-local identifiers guaranteed not to shadow a parameter.
type localNames struct {
	query, header, req, out, items, fetch, page, initial string
}

func newLocalNames(pathParams []Param) *localNames {
	claimed := map[string]bool{"ctx": true, "params": true, "opts": true, "r": true, "err": true}
	for i := range pathParams {
		claimed[LocalName(pathParams[i].Name)] = true
	}
	pick := func(preferred string) string {
		candidate := preferred
		for claimed[candidate] {
			candidate += "_"
		}
		claimed[candidate] = true
		return candidate
	}
	return &localNames{
		query:   pick("query"),
		header:  pick("header"),
		req:     pick("req"),
		out:     pick("out"),
		items:   pick("items"),
		fetch:   pick("fetch"),
		page:    pick("page"),
		initial: pick("initial"),
	}
}
