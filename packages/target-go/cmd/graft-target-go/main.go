// Command graft-target-go is the graft Go target.
//
//	graft-target-go --sdk-target-protocol   → handshake on stdout
//	graft-target-go                    → IR JSON on stdin, file manifest on stdout
//
// Written in Go so it can use Go's own tooling — go/format for layout, go build and go vet as gates.
// Nothing here imports anything from graft's core: the contract is the JSON, which is what makes a
// target in any language possible.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/graft/target-go/internal/emit"
)

const handshakeFlag = "--sdk-target-protocol"

// runtimeDir is the directory holding the hand-written Go runtime, and the package name inside it.
// `core` names the role, not this project, which is why the vendored copy needs no rewriting.
const runtimeDir = "core"

type gate struct {
	Name     string   `json:"name"`
	Command  []string `json:"command"`
	Kind     string   `json:"kind"`
	Optional bool     `json:"optional,omitempty"`
}

type handshake struct {
	Name         string   `json:"name"`
	DisplayName  string   `json:"displayName"`
	Version      string   `json:"version"`
	IRVersions   []string `json:"irVersions"`
	Capabilities []string `json:"capabilities"`
	LineComment  string   `json:"lineComment"`
	Gates        []gate   `json:"gates"`
}

// gates are the verification steps for generated Go.
//
// Declared by the target because only the target knows that Go means gofmt, go build, and go vet —
// the core growing that table would be the boundary violation SPEC.md §3.7 exists to prevent.
//
// `go build` rather than a separate typechecker: in Go they are the same thing, and a package that
// builds is type-correct. It is `verify` and not optional, because skipping it removes the guarantee
// the whole pipeline is premised on.
func gates() []gate {
	goBin := goBinary()
	return []gate{
		{Name: "gofmt", Command: []string{goBin, "fmt", "./..."}, Kind: "fix", Optional: true},
		// `go mod tidy` is what makes the emitted go.mod match the imports actually used. Without it
		// a generated module with an unused requirement fails `go build` in a clean environment.
		{Name: "go mod tidy", Command: []string{goBin, "mod", "tidy"}, Kind: "fix", Optional: true},
		{Name: "go build", Command: []string{goBin, "build", "./..."}, Kind: "verify"},
		{Name: "go vet", Command: []string{goBin, "vet", "./..."}, Kind: "verify", Optional: true},
		// The generated per-operation tests (SPEC.md §3.11). `-count=1` disables Go's test cache, which
		// would otherwise report a pass from a previous run against different generated code — the
		// exact failure mode a gate exists to prevent.
		//
		// Not optional, unlike the other targets' equivalents: Go's test runner *is* the toolchain, so
		// if `go build` could run then `go test` can. There is no separate dev dependency to be absent.
		{Name: "generated tests", Command: []string{goBin, "test", "-count=1", "./..."}, Kind: "verify"},
	}
}

// goBinary locates the go tool, preferring the one that built this target.
func goBinary() string {
	if found, err := exec.LookPath("go"); err == nil {
		return found
	}
	if root := os.Getenv("GOROOT"); root != "" {
		return filepath.Join(root, "bin", "go")
	}
	return "go"
}

// loadRuntime reads the hand-written runtime for vendoring into the output.
//
// Read from the checkout rather than embedded as string constants, so the runtime stays a normal Go
// package that its own test suite exercises. Tests are excluded: they belong to graft's repository,
// not to a user's SDK.
func loadRuntime() (map[string]string, error) {
	executable, err := os.Executable()
	if err != nil {
		executable = "."
	}
	candidates := []string{
		os.Getenv("SDK_GO_RUNTIME"),
		filepath.Join(filepath.Dir(executable), "..", "..", "runtime-go", runtimeDir),
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(wd, "packages", "runtime-go", runtimeDir),
			filepath.Join(wd, "..", "runtime-go", runtimeDir),
		)
	}

	for _, dir := range candidates {
		if dir == "" {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		files := map[string]string{}
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			contents, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				return nil, err
			}
			// Copied verbatim. The runtime's own package is already `core`, named for its role
			// rather than for this project — so there is nothing to rewrite, and the vendored copy
			// is byte-identical to a package that has its own tests.
			files[name] = string(contents)
		}
		if len(files) > 0 {
			return files, nil
		}
	}
	return nil, fmt.Errorf("no runtime sources found; set SDK_GO_RUNTIME to the runtime-go package directory")
}

func run() int {
	for _, arg := range os.Args[1:] {
		if arg == handshakeFlag {
			encoded, _ := json.Marshal(handshake{
				Name:        "go",
				DisplayName: "Go",
				Version:     "0.0.0",
				IRVersions:  []string{"1.x"},
				Capabilities: []string{
					"pagination", "streaming", "binary-responses",
					"multipart-requests", "read-write-split",
				},
				// `//` is what lets the core find preservation markers without knowing Go.
				LineComment: "//",
				Gates:       gates(),
			})
			fmt.Println(string(encoded))
			return 0
		}
	}

	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "graft-target-go: reading stdin: %v\n", err)
		return 2
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		fmt.Fprintln(os.Stderr, "graft-target-go: expected IR JSON on stdin")
		return 2
	}

	var input emit.TargetInput
	if err := json.Unmarshal(raw, &input); err != nil {
		fmt.Fprintf(os.Stderr, "graft-target-go: stdin was not valid JSON: %v\n", err)
		return 2
	}

	// Decoded a second time as a loose map, purely so Sanity can compare the two. Cheap next to
	// generation, and it is the only thing that catches a field this target names incorrectly.
	var loose struct {
		IR map[string]any `json:"ir"`
	}
	_ = json.Unmarshal(raw, &loose)
	if problems := emit.Sanity(&input.IR, loose.IR); len(problems) > 0 {
		fmt.Fprintln(os.Stderr, "graft-target-go: the IR did not decode as expected:")
		for _, problem := range problems {
			fmt.Fprintf(os.Stderr, "  %s\n", problem)
		}
		return 2
	}

	runtime, err := loadRuntime()
	if err != nil {
		fmt.Fprintf(os.Stderr, "graft-target-go: %v\n", err)
		return 2
	}

	emitter := emit.New(&input.IR, input.Options, input.Brand)
	files, err := emitter.Emit(runtime)
	if err != nil {
		fmt.Fprintf(os.Stderr, "graft-target-go: %v\n", err)
		return 70
	}

	// A nil slice marshals to `null` in Go, not `[]`, and the protocol schema requires an array — so
	// a run with no warnings produced a manifest the core rejected as invalid. Every other target
	// language produces an empty list from an empty collection; Go is the one that does not, which is
	// exactly the kind of thing a cross-language protocol has to be explicit about.
	warnings := emitter.Warnings()
	if warnings == nil {
		warnings = []emit.Warning{}
	}
	if files == nil {
		files = []emit.GeneratedFile{}
	}
	encoded, err := json.Marshal(emit.TargetOutput{Files: files, Warnings: warnings})
	if err != nil {
		fmt.Fprintf(os.Stderr, "graft-target-go: encoding manifest: %v\n", err)
		return 70
	}
	fmt.Println(string(encoded))
	return 0
}

func main() { os.Exit(run()) }
