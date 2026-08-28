package emit

import (
	"fmt"
	"go/format"
	"sort"
	"strings"
)

// File builds one Go source file.
//
// A structured model rather than go/ast, on measured evidence (SPEC.md §3.3.4): a synthesized
// ast.File has no valid token.Pos so the printer cannot space declarations, and — disqualifying —
// re-printing *relocates comments out of function bodies*, which would move a preservation-region
// marker to file scope and destroy the user's code on the next regeneration.
//
// What the builder keeps is what "no string templates" is actually about: imports are requested while
// the body is built and rendered once at the top, and layout is decided by go/format, which *is*
// gofmt, so output is byte-identical to what a Go developer's editor produces.
type File struct {
	pkg     string
	doc     []string
	imports map[string]string
	decls   []string
}

// NewFile starts a file in the given package.
func NewFile(pkg string, doc ...string) *File {
	return &File{pkg: pkg, doc: doc, imports: map[string]string{}}
}

// Import requests an import. Idempotent, so callers add one wherever they need it without
// coordinating.
func (f *File) Import(path string) {
	f.imports[path] = ""
}

// ImportAs requests an aliased import.
func (f *File) ImportAs(path, alias string) {
	f.imports[path] = alias
}

// Add appends a declaration verbatim.
func (f *File) Add(decl string) {
	trimmed := strings.TrimRight(decl, "\n")
	if trimmed != "" {
		f.decls = append(f.decls, trimmed)
	}
}

// Addf appends a formatted declaration.
func (f *File) Addf(format string, args ...any) {
	f.Add(fmt.Sprintf(format, args...))
}

// Render produces gofmt-formatted source.
//
// A formatting failure returns the unformatted text alongside the error, because when generation
// produces invalid Go the *text* is what a maintainer needs to see. Returning only an error would
// hide the evidence.
func (f *File) Render() (string, error) {
	var b strings.Builder
	for _, line := range f.doc {
		b.WriteString("// " + line + "\n")
	}
	b.WriteString("package " + f.pkg + "\n\n")

	if len(f.imports) > 0 {
		// Grouped standard-library-first, which is what gofmt preserves and goimports would produce.
		var stdlib, external []string
		for path := range f.imports {
			if strings.Contains(strings.SplitN(path, "/", 2)[0], ".") {
				external = append(external, path)
			} else {
				stdlib = append(stdlib, path)
			}
		}
		sort.Strings(stdlib)
		sort.Strings(external)

		b.WriteString("import (\n")
		writeGroup := func(paths []string) {
			for _, path := range paths {
				if alias := f.imports[path]; alias != "" {
					fmt.Fprintf(&b, "\t%s %q\n", alias, path)
				} else {
					fmt.Fprintf(&b, "\t%q\n", path)
				}
			}
		}
		writeGroup(stdlib)
		if len(stdlib) > 0 && len(external) > 0 {
			b.WriteString("\n")
		}
		writeGroup(external)
		b.WriteString(")\n\n")
	}

	for i, decl := range f.decls {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString(decl)
		b.WriteString("\n")
	}

	source := b.String()
	formatted, err := format.Source([]byte(source))
	if err != nil {
		return source, fmt.Errorf("generated Go did not parse: %w", err)
	}
	return string(formatted), nil
}

// DocComment renders prose as a Go doc comment, wrapped and escaped.
//
// Wrapping is done here because gofmt does not reflow comments — the same reason the Python target
// wraps its own docstrings. Go has no comment-terminating sequence to escape, unlike JSDoc, but a
// carriage return or a stray control character still corrupts the output, so those are stripped.
func DocComment(indent, subject string, docs Docs, extra ...string) string {
	var paragraphs []string
	summary := strings.TrimSpace(docs.Summary)
	description := strings.TrimSpace(docs.Description)
	if summary != "" {
		paragraphs = append(paragraphs, summary)
	}
	if description != "" && description != summary {
		paragraphs = append(paragraphs, description)
	}
	paragraphs = append(paragraphs, extra...)
	if len(paragraphs) == 0 {
		return ""
	}

	// Go convention starts a doc comment with the identifier it documents, and a generator cannot
	// conjugate an author's summary into a grammatical sentence — "ListMembers list members of an
	// organization" is not English. `Name: Summary` is the form Google's generated Go clients use for
	// exactly this reason ("// Get: Gets the specified firewall."), so it is both established and
	// unambiguous. Left alone when the prose already begins with the identifier, so an author who
	// wrote "Widget is..." keeps their sentence.
	if subject != "" && !strings.HasPrefix(paragraphs[0], subject+" ") {
		paragraphs[0] = subject + ": " + paragraphs[0]
	}

	var b strings.Builder
	for i, paragraph := range paragraphs {
		if i > 0 {
			b.WriteString(indent + "//\n")
		}
		for _, line := range wrapProse(sanitizeProse(paragraph), 100-len(indent)-3) {
			if line == "" {
				b.WriteString(indent + "//\n")
			} else {
				b.WriteString(indent + "// " + line + "\n")
			}
		}
	}
	return b.String()
}

func sanitizeProse(text string) string {
	var b strings.Builder
	for _, r := range text {
		switch {
		case r == '\r':
			continue
		case r == '\n' || r == '\t':
			b.WriteRune(r)
		case r < 0x20 || r == 0x7f:
			continue
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// wrapProse wraps text to width, leaving indented lines alone.
//
// Four spaces is the threshold, and using it matters: markdown bullet lists in real specs are
// indented one or two spaces and are prose, while an indented code block must survive verbatim —
// rewrapping a code sample is how a generator turns a working example into a broken one.
func wrapProse(text string, width int) []string {
	if width < 40 {
		width = 40
	}
	var out []string
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimRight(raw, " \t")
		if strings.TrimSpace(line) == "" {
			out = append(out, "")
			continue
		}
		leading := len(line) - len(strings.TrimLeft(line, " \t"))
		if leading >= 4 || strings.HasPrefix(line, "\t") {
			out = append(out, line)
			continue
		}
		prefix := line[:leading]
		words := strings.Fields(line[leading:])
		current := prefix
		for _, word := range words {
			candidate := current
			if strings.TrimSpace(candidate) != "" {
				candidate += " "
			}
			candidate += word
			if len(candidate) > width && strings.TrimSpace(current) != "" {
				out = append(out, current)
				current = prefix + word
				continue
			}
			current = candidate
		}
		if strings.TrimSpace(current) != "" {
			out = append(out, current)
		}
	}
	// Trailing blanks would emit a dangling `//`.
	for len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return out
}
