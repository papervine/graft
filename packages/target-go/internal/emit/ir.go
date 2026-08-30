// Package emit turns graft's semantic IR into Go source files.
//
// The IR is decoded into these structs rather than navigated as map[string]any. That does not make
// reading the wrong field impossible — JSON decoding leaves an unknown field at its zero value, so a
// mismatch is silent here exactly as it was in Python, where reading `request` instead of `body`
// dropped every request body while passing every gate. What it does buy is that each field name
// appears exactly *once* in the whole target, next to its `json` tag, and every use site is a typed
// reference the compiler checks. The failure surface shrinks from "every call site" to "one line".
//
// The remaining risk is handled by `sanity.go`, which asserts after decoding that an IR with
// operations actually produced methods, request bodies, and pagination.
package emit

import "encoding/json"

// Name is a lowercase token sequence. Casing is the target's decision, which is why the IR never
// pre-cases anything.
type Name struct {
	Tokens []string `json:"tokens"`
}

// Docs is prose from the spec.
type Docs struct {
	Summary     string `json:"summary,omitempty"`
	Description string `json:"description,omitempty"`
}

// TypeRef is a reference to a type. A tagged union, discriminated by Kind.
type TypeRef struct {
	Kind string `json:"kind"`

	// primitive
	Type   string `json:"type,omitempty"`
	Format string `json:"format,omitempty"`

	// named
	ID string `json:"id,omitempty"`

	// array
	Items *TypeRef `json:"items,omitempty"`

	// map
	Values         *TypeRef `json:"values,omitempty"`
	EmptyWireValue string   `json:"emptyWireValue,omitempty"`

	// nullable
	Inner *TypeRef `json:"inner,omitempty"`

	// literal
	Value json.RawMessage `json:"value,omitempty"`

	// union
	Variants []TypeRef `json:"variants,omitempty"`
	Coercion string    `json:"coercion,omitempty"`
}

// Field is one property of an object type.
type Field struct {
	Name        Name    `json:"name"`
	WireName    string  `json:"wireName"`
	Type        TypeRef `json:"type"`
	Required    bool    `json:"required"`
	ServerOwned bool    `json:"serverOwned"`
	ReadOnly    bool    `json:"readOnly"`
	WriteOnly   bool    `json:"writeOnly"`
	Deprecated  bool    `json:"deprecated"`
	Docs        Docs    `json:"docs"`
}

// EnumMember is one value of an enum type.
type EnumMember struct {
	Name      Name            `json:"name"`
	WireValue json.RawMessage `json:"wireValue"`
	Docs      Docs            `json:"docs"`
}

// NamedType is a declared type. Kind is one of object, enum, or alias.
type NamedType struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Name   Name   `json:"name"`
	Docs   Docs   `json:"docs"`
	Cyclic bool   `json:"cyclic"`

	// object
	// Role is read, create, update, or shared — which side of the read/write split this is.
	Role       string   `json:"role,omitempty"`
	Fields     []Field  `json:"fields,omitempty"`
	Additional *TypeRef `json:"additional,omitempty"`

	// enum
	Members []EnumMember `json:"members,omitempty"`
	Open    bool         `json:"open,omitempty"`

	// alias
	Target *TypeRef `json:"target,omitempty"`
}

// Param is one operation parameter.
type Param struct {
	Name       Name    `json:"name"`
	WireName   string  `json:"wireName"`
	Location   string  `json:"location"`
	Type       TypeRef `json:"type"`
	Required   bool    `json:"required"`
	Deprecated bool    `json:"deprecated"`
	Docs       Docs    `json:"docs"`
	Explode    *bool   `json:"explode,omitempty"`
}

// RequestBody describes an operation's request body.
type RequestBody struct {
	Type        TypeRef `json:"type"`
	ContentType string  `json:"contentType"`
	Required    bool    `json:"required"`
}

// Response describes an operation's success response. Kind is empty, json, text, binary, or stream.
type Response struct {
	Kind       string   `json:"kind"`
	StatusCode int      `json:"statusCode"`
	Type       *TypeRef `json:"type,omitempty"`
}

// HTTP carries the wire details of an operation.
type HTTP struct {
	Verb   string  `json:"verb"`
	Path   string  `json:"path"`
	Params []Param `json:"params"`
}

// Method is one operation.
type Method struct {
	Name         Name         `json:"name"`
	OperationID  string       `json:"operationId"`
	Docs         Docs         `json:"docs"`
	Deprecated   bool         `json:"deprecated"`
	HTTP         HTTP         `json:"http"`
	Body         *RequestBody `json:"body,omitempty"`
	Response     Response     `json:"response"`
	PaginationID string       `json:"paginationId,omitempty"`
	// Example data synthesized by the core, so every language shows the same values for the same
	// operation (SPEC.md §3.11). Nil for an IR predating 1.7.0, or one hand-written for a test.
	Example *MethodExample `json:"example,omitempty"`
}

// MethodExample is plausible data for one operation, as language-neutral JSON.
//
// Keys in Params are wire names, not tokens, because that is what identifies a parameter
// unambiguously; this target cases them for its own signature.
type MethodExample struct {
	Params   map[string]any `json:"params"`
	Body     any            `json:"body,omitempty"`
	Response any            `json:"response,omitempty"`
}

// Resource is a group of methods, possibly with nested sub-resources.
type Resource struct {
	ID           string     `json:"id"`
	Name         Name       `json:"name"`
	Docs         Docs       `json:"docs"`
	Methods      []Method   `json:"methods"`
	Subresources []Resource `json:"subresources"`
}

// ValueSource says where a pagination value comes from.
type ValueSource struct {
	Kind string   `json:"kind"`
	Name string   `json:"name,omitempty"`
	Path []string `json:"path,omitempty"`
}

// PaginationScheme describes one way this API paginates.
type PaginationScheme struct {
	ID            string       `json:"id"`
	Style         string       `json:"style"`
	LimitParam    string       `json:"limitParam,omitempty"`
	OffsetParam   string       `json:"offsetParam,omitempty"`
	PageParam     string       `json:"pageParam,omitempty"`
	CursorParam   string       `json:"cursorParam,omitempty"`
	CursorSource  *ValueSource `json:"cursorSource,omitempty"`
	ItemsSource   *ValueSource `json:"itemsSource,omitempty"`
	TotalSource   *ValueSource `json:"totalSource,omitempty"`
	HasMoreSource *ValueSource `json:"hasMoreSource,omitempty"`
}

// ErrorEntry is one status in the error taxonomy.
type ErrorEntry struct {
	StatusCode int      `json:"statusCode"`
	Name       Name     `json:"name"`
	Type       *TypeRef `json:"type,omitempty"`
	Retryable  bool     `json:"retryable"`
	Docs       Docs     `json:"docs"`
}

// Server is one declared server.
type Server struct {
	URL     string `json:"url"`
	Default bool   `json:"default"`
	Docs    Docs   `json:"docs"`
	// URLTemplate is the server URL before its variables were substituted. Empty when the URL had
	// none.
	URLTemplate string           `json:"urlTemplate,omitempty"`
	Variables   []ServerVariable `json:"variables,omitempty"`
}

// ServerVariable is one `{placeholder}` in a templated server URL.
type ServerVariable struct {
	WireName    string   `json:"wireName"`
	Name        Name     `json:"name"`
	Default     string   `json:"default"`
	Enum        []string `json:"enum,omitempty"`
	Description string   `json:"description,omitempty"`
}

// OAuth2Scope is one declared scope. Documentation for an SDK rather than behaviour: the token request
// sends whatever the caller asks for, and a server rejecting a scope is the server's answer to give.
type OAuth2Scope struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// AuthScheme is one declared authentication scheme.
type AuthScheme struct {
	Kind     string `json:"kind"`
	WireName string `json:"wireName,omitempty"`
	Location string `json:"location,omitempty"`
	// Flow, TokenURL, and Scopes are set when Kind is `oauth2`.
	Flow       string        `json:"flow,omitempty"`
	TokenURL   string        `json:"tokenUrl,omitempty"`
	RefreshURL string        `json:"refreshUrl,omitempty"`
	Scopes     []OAuth2Scope `json:"scopes,omitempty"`
	// Environment variables each credential falls back to. Named by the core rather than derived
	// here, so every target reads the same variable for the same credential.
	EnvVar             string `json:"envVar,omitempty"`
	UsernameEnvVar     string `json:"usernameEnvVar,omitempty"`
	PasswordEnvVar     string `json:"passwordEnvVar,omitempty"`
	ClientIDEnvVar     string `json:"clientIdEnvVar,omitempty"`
	ClientSecretEnvVar string `json:"clientSecretEnvVar,omitempty"`
	RefreshTokenEnvVar string `json:"refreshTokenEnvVar,omitempty"`
	Docs               Docs   `json:"docs"`
}

// Service is the API as a whole.
type Service struct {
	Name            Name              `json:"name"`
	DisplayName     string            `json:"displayName,omitempty"`
	Version         string            `json:"version"`
	Docs            Docs              `json:"docs"`
	Servers         []Server          `json:"servers"`
	Auth            []AuthScheme      `json:"auth"`
	ConstantHeaders map[string]string `json:"constantHeaders"`
}

// IR is the whole intermediate representation.
type IR struct {
	IRVersion string      `json:"irVersion"`
	Service   Service     `json:"service"`
	Types     []NamedType `json:"types"`
	Resources []Resource  `json:"resources"`
	Errors    struct {
		ByStatus []ErrorEntry `json:"byStatus"`
	} `json:"errors"`
	Pagination []PaginationScheme `json:"pagination"`
}

// TargetInput is what arrives on stdin.
type TargetInput struct {
	IRVersion string          `json:"irVersion"`
	IR        IR              `json:"ir"`
	Options   json.RawMessage `json:"options"`
	Brand     Brand           `json:"brand"`
}

// Brand carries this project's own name and the strings derived from it.
//
// Sent over the protocol rather than written here as constants, and that is the point: generated
// files are files consumers commit, so a project rename must not break them. This target cannot
// import the TypeScript module that owns the name, so the only way it can honour that rule is to be
// told. A hardcoded fallback would defeat it, so there is none — an empty GeneratedNotice is a bug
// in the caller, and Sanity() reports it.
type Brand struct {
	Name            string `json:"name"`
	Title           string `json:"title"`
	Homepage        string `json:"homepage"`
	ConfigFile      string `json:"configFile"`
	GeneratedNotice string `json:"generatedNotice"`
	Attribution     string `json:"attribution"`
}

// GeneratedFile is one emitted file.
type GeneratedFile struct {
	Path     string `json:"path"`
	Contents string `json:"contents"`
}

// Warning is a diagnostic returned alongside the manifest.
type Warning struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

// TargetOutput is what goes to stdout.
type TargetOutput struct {
	Files    []GeneratedFile `json:"files"`
	Warnings []Warning       `json:"warnings"`
}
