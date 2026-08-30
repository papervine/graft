package emit

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Options are the target-specific settings from graft.yaml.
type Options struct {
	// ModulePath is the Go module path, e.g. github.com/acme/acme-go. Required for a publishable
	// module; Go has no equivalent of an unscoped package name.
	ModulePath  string `json:"modulePath"`
	PackageName string `json:"packageName"`
	ClientName  string `json:"clientName"`
	// Validation is strict (the default), warn, or off. See SPEC.md §3.4.1.1.
	Validation string `json:"validation"`
	// IdempotencyHeader is the header an idempotency key is sent in, when the API does not use the
	// default. Empty means DefaultIdempotencyHeader.
	IdempotencyHeader string `json:"idempotencyHeader"`
	// SDKVersion is the released version recorded by `graft release`. Distinct from the API's own
	// version, which is not a package version (SPEC.md §3.5.1).
	SDKVersion string `json:"sdkVersion"`
}

// Emitter turns an IR into Go files.
type Emitter struct {
	ir      *IR
	opts    Options
	types   *TypeMapper
	cycles  *valueCycle
	schemas *schemaPlan
	// validation is the generated client's default mode: strict, warn, or off.
	validation string
	brand      Brand
	pkg        string
	client     string
	module     string
	warnings   []Warning
}

// New builds an Emitter.
func New(ir *IR, rawOptions json.RawMessage, brand Brand) *Emitter {
	var opts Options
	if len(rawOptions) > 0 {
		_ = json.Unmarshal(rawOptions, &opts)
	}

	e := &Emitter{ir: ir, opts: opts, brand: brand, types: NewTypeMapper(ir)}
	e.cycles = newValueCycle(ir, e.types)

	e.validation = opts.Validation
	if e.validation != "warn" && e.validation != "off" {
		e.validation = "strict"
	}
	e.schemas = e.planSchemas()

	e.pkg = opts.PackageName
	if e.pkg == "" {
		e.pkg = strings.ToLower(strings.Join(ir.Service.Name.Tokens, ""))
	}
	e.pkg = sanitizePackage(e.pkg)

	e.client = opts.ClientName
	if e.client == "" {
		e.client = clientNameFrom(ir)
	}

	e.module = opts.ModulePath
	if e.module == "" {
		// A placeholder rather than a guess at someone's VCS host. It is reported as a warning so it
		// cannot ship unnoticed, because a wrong module path breaks `go get` for every consumer.
		e.module = "example.com/" + e.pkg
		e.warnings = append(e.warnings, Warning{
			Code:     "GO001",
			Severity: "warn",
			Message: "No modulePath configured, so go.mod says " + e.module +
				". Set targets.go.modulePath to your module path before publishing.",
		})
	}
	return e
}

func sanitizePackage(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if out == "" || (out[0] >= '0' && out[0] <= '9') {
		return "sdk" + out
	}
	return out
}

// clientNameFrom picks the client type name.
//
// Same policy as the other targets: no `Client` suffix, because `acme.New()` already says what it
// constructs; and the author's own casing from displayName is preferred so `IBMCloud` does not become
// `IbmCloud`.
func clientNameFrom(ir *IR) string {
	if display := strings.TrimSpace(ir.Service.DisplayName); display != "" {
		joined := strings.ReplaceAll(display, " ", "")
		if joined != "" && isIdentifier(joined) {
			return joined
		}
	}
	return Exported(ir.Service.Name)
}

func isIdentifier(s string) bool {
	for i, r := range s {
		isLetter := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_'
		isDigit := r >= '0' && r <= '9'
		if i == 0 && !isLetter {
			return false
		}
		if !isLetter && !isDigit {
			return false
		}
	}
	return s != ""
}

// Warnings returns diagnostics accumulated during emission.
func (e *Emitter) Warnings() []Warning { return e.warnings }

// allResources flattens the resource tree, parents before children.
func (e *Emitter) allResources() []*Resource {
	var flat []*Resource
	var walk func([]Resource)
	walk = func(resources []Resource) {
		for i := range resources {
			flat = append(flat, &resources[i])
			walk(resources[i].Subresources)
		}
	}
	walk(e.ir.Resources)
	return flat
}

// resourceType names the struct for a resource.
//
// Suffixed with `Service` on collision with a model type — `Session` yields both a Session model and
// a session resource. The struct name is nearly invisible to callers, who reach it as
// `client.Session`, so disambiguating here costs the public API nothing.
func (e *Emitter) resourceType(r *Resource) string {
	base := Exported(r.Name)
	for _, named := range e.ir.Types {
		if e.types.Declared(named.ID) == base {
			return base + "Service"
		}
	}
	return base
}

// Emit produces every file in the SDK.
func (e *Emitter) Emit(runtime map[string]string) ([]GeneratedFile, error) {
	var files []GeneratedFile

	add := func(path string, render func() (string, error)) error {
		contents, err := render()
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		files = append(files, GeneratedFile{Path: path, Contents: contents})
		return nil
	}

	if err := add("models.go", e.models); err != nil {
		return nil, err
	}
	if len(e.generatedErrors()) > 0 {
		if err := add("errors.go", e.errors); err != nil {
			return nil, err
		}
	}
	if len(e.schemas.table) > 0 || len(e.responseDescriptors()) > 0 {
		if err := add("schemas.go", e.schemasFile); err != nil {
			return nil, err
		}
	}
	for _, resource := range e.allResources() {
		r := resource
		if err := add(FileName(r.ID)+".go", func() (string, error) { return e.resource(r) }); err != nil {
			return nil, err
		}
	}
	if err := add("client.go", e.clientFile); err != nil {
		return nil, err
	}

	// The hand-written runtime, vendored: the published module depends only on the standard library.
	for name, contents := range runtime {
		files = append(files, GeneratedFile{Path: "internal/core/" + name, Contents: contents})
	}
	files = append(files, e.scaffold()...)

	// Per-operation examples and tests (SPEC.md §3.11). Emitted as `_test.go` files in the package,
	// which is Go's own convention: `go test` compiles them, `go doc` shows each example beside the
	// method it calls, and no separate module is needed.
	examples, err := e.operationExamples()
	if err != nil {
		return nil, err
	}
	files = append(files, examples...)
	tests, err := e.operationTests()
	if err != nil {
		return nil, err
	}
	files = append(files, tests...)

	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

// coreImport is the import path of the vendored runtime inside the generated module.
func (e *Emitter) coreImport() string { return e.module + "/internal/core" }

func (e *Emitter) generatedErrors() []ErrorEntry {
	runtimeStatuses := map[int]bool{400: true, 401: true, 403: true, 404: true, 409: true, 422: true, 429: true}
	runtimeNames := map[string]bool{}
	for _, name := range runtimeExports {
		runtimeNames[name] = true
	}
	seen := map[string]bool{}
	var out []ErrorEntry
	for _, entry := range e.ir.Errors.ByStatus {
		if runtimeStatuses[entry.StatusCode] {
			continue
		}
		name := Exported(entry.Name)
		// Filtered by name as well as status: a spec that declares a 503 called
		// `InternalServerError` would otherwise redeclare a type the runtime already exports.
		if seen[name] || runtimeNames[name] {
			continue
		}
		seen[name] = true
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StatusCode < out[j].StatusCode })
	return out
}
