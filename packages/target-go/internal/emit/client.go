package emit

import (
	"fmt"
	"strings"
)

// clientFile emits the client struct, its constructor, and its option functions.
func (e *Emitter) clientFile() (string, error) {
	file := NewFile(e.pkg,
		e.brand.GeneratedNotice,
		"",
		fmt.Sprintf("The %s client.", e.client),
	)
	file.Import(e.coreImport())
	e.types.Into(file)

	service := e.ir.Service
	baseURL := ""
	var defaultServer *Server
	for i := range service.Servers {
		server := &service.Servers[i]
		if server.Default || baseURL == "" {
			baseURL = server.URL
			defaultServer = server
		}
		if server.Default {
			break
		}
	}
	serverVars := []ServerVariable{}
	if defaultServer != nil && defaultServer.URLTemplate != "" {
		serverVars = defaultServer.Variables
	}

	hasBearer, hasBasic := false, false
	var bearer, basic, apiKey *AuthScheme
	// Every OAuth2 scheme, not just one.
	//
	// A spec can declare both client credentials and authorization code — kitchen-sink does — and
	// keeping only one meant each language silently picked a *different* winner: Go took the last and
	// got refresh, TypeScript and Python took the first and got client credentials. Both flows are
	// generated now, and a caller chooses.
	var oauthFlows []*AuthScheme
	for i := range service.Auth {
		switch service.Auth[i].Kind {
		case "bearer":
			hasBearer = true
			bearer = &service.Auth[i]
		case "basic":
			hasBasic = true
			basic = &service.Auth[i]
		case "apiKey":
			apiKey = &service.Auth[i]
		case "oauth2":
			oauthFlows = append(oauthFlows, &service.Auth[i])
		}
	}

	// The client struct.
	var b strings.Builder
	b.WriteString(DocComment("", e.client, service.Docs,
		fmt.Sprintf("Construct one with New:\n\n\tclient := %s.New()", e.pkg)))
	fmt.Fprintf(&b, "type %s struct {\n\tclient *core.Client\n", e.client)
	for i := range e.ir.Resources {
		r := &e.ir.Resources[i]
		doc := DocComment("\t", Exported(r.Name), r.Docs)
		if doc != "" {
			b.WriteString("\n")
			b.WriteString(doc)
		}
		fmt.Fprintf(&b, "\t%s *%s\n", Exported(r.Name), e.resourceType(r))
	}
	b.WriteString("}\n")
	file.Add(b.String())

	// Options. Functional options for *client construction* is the Go idiom — unlike per-call
	// parameters, where a struct is what every major Go SDK uses.
	var opt strings.Builder
	fmt.Fprintf(&opt, "// Option configures a %s.\ntype Option func(*core.ClientOptions)\n\n", e.client)
	opt.WriteString("// WithBaseURL overrides the API base URL.\n")
	opt.WriteString("func WithBaseURL(url string) Option {\n\treturn func(o *core.ClientOptions) { o.BaseURL = url }\n}\n\n")
	if hasBearer {
		opt.WriteString("// WithToken sets the bearer token.\n")
		opt.WriteString("func WithToken(token string) Option {\n")
		opt.WriteString("\treturn func(o *core.ClientOptions) {\n")
		opt.WriteString("\t\to.Auth = core.Auth{Kind: core.AuthBearer, Token: token}\n\t}\n}\n\n")
	}
	if hasBasic {
		opt.WriteString("// WithBasicAuth sets HTTP Basic credentials.\n")
		opt.WriteString("func WithBasicAuth(username, password string) Option {\n")
		opt.WriteString("\treturn func(o *core.ClientOptions) {\n")
		opt.WriteString("\t\to.Auth = core.Auth{Kind: core.AuthBasic, Username: username, Password: password}\n\t}\n}\n\n")
	}
	if apiKey != nil {
		inQuery := apiKey.Location == "query"
		opt.WriteString("// WithAPIKey sets the API key.\n")
		opt.WriteString("func WithAPIKey(key string) Option {\n")
		opt.WriteString("\treturn func(o *core.ClientOptions) {\n")
		fmt.Fprintf(&opt, "\t\to.Auth = core.Auth{Kind: core.AuthAPIKey, Token: key, WireName: %s, InQuery: %t}\n\t}\n}\n\n",
			GoString(apiKey.WireName), inQuery)
	}
	opt.WriteString("// WithHTTPClient supplies the http.Client used for every request.\n")
	opt.WriteString("//\n")
	opt.WriteString("// Without this, testing code that calls this SDK means making real network requests, so it is\n")
	opt.WriteString("// not a nicety.\n")
	opt.WriteString("func WithHTTPClient(httpClient *http.Client) Option {\n")
	opt.WriteString("\treturn func(o *core.ClientOptions) { o.HTTPClient = httpClient }\n}\n\n")
	opt.WriteString("// WithTimeout sets the per-attempt timeout. Use a context deadline to bound total time.\n")
	opt.WriteString("func WithTimeout(d time.Duration) Option {\n")
	opt.WriteString("\treturn func(o *core.ClientOptions) { o.Timeout = d }\n}\n\n")
	opt.WriteString("// WithMaxRetries sets how many additional attempts a retryable failure gets. Use -1 for none.\n")
	opt.WriteString("func WithMaxRetries(n int) Option {\n")
	opt.WriteString("\treturn func(o *core.ClientOptions) { o.MaxRetries = n }\n}\n\n")
	emittedFlows := map[string]bool{}
	for _, oauth2 := range oauthFlows {
		// One option per distinct flow. Two schemes declaring the same flow differ only in their
		// scopes, and a second identical function would not compile.
		if emittedFlows[oauth2.Flow] {
			continue
		}
		emittedFlows[oauth2.Flow] = true

		scopeLiteral := "nil"
		if len(oauth2.Scopes) > 0 {
			names := make([]string, 0, len(oauth2.Scopes))
			for _, scope := range oauth2.Scopes {
				names = append(names, GoString(scope.Name))
			}
			scopeLiteral = "[]string{" + strings.Join(names, ", ") + "}"
		}
		if oauth2.Flow == "clientCredentials" {
			opt.WriteString("// WithClientCredentials makes the SDK fetch and refresh its own tokens.\n")
			opt.WriteString("//\n")
			opt.WriteString("// One token request per refresh however many calls are in flight, refreshed before\n")
			opt.WriteString("// expiry, and retried once on a 401.\n")
			opt.WriteString("func WithClientCredentials(clientID, clientSecret string, scopes ...string) Option {\n")
			opt.WriteString("\treturn func(o *core.ClientOptions) {\n")
			opt.WriteString("\t\tif len(scopes) == 0 {\n")
			fmt.Fprintf(&opt, "\t\t\tscopes = %s\n", scopeLiteral)
			opt.WriteString("\t\t}\n")
			opt.WriteString("\t\to.Auth = core.Auth{Kind: core.AuthOAuth2, Source: core.NewTokenSource(\n")
			opt.WriteString("\t\t\tcore.OAuth2Config{\n")
			opt.WriteString("\t\t\t\tFlow:         core.FlowClientCredentials,\n")
			fmt.Fprintf(&opt, "\t\t\t\tTokenURL:     %s,\n", GoString(oauth2.TokenURL))
			opt.WriteString("\t\t\t\tClientID:     clientID,\n")
			opt.WriteString("\t\t\t\tClientSecret: clientSecret,\n")
			opt.WriteString("\t\t\t\tScopes:       scopes,\n")
			opt.WriteString("\t\t\t},\n")
			// The caller's transport, when they supplied one. A token fetched over a different client
			// would bypass a test's injected transport and make a real network call.
			opt.WriteString("\t\t\to.HTTPClient,\n")
			opt.WriteString("\t\t)}\n\t}\n}\n\n")
		} else {
			opt.WriteString("// WithRefreshToken keeps an access token current from a refresh token you already have.\n")
			opt.WriteString("//\n")
			opt.WriteString("// The authorization-code redirect needs a browser, so it stays your application's job;\n")
			opt.WriteString("// keeping the access token current does not.\n")
			opt.WriteString("func WithRefreshToken(refreshToken string, scopes ...string) Option {\n")
			opt.WriteString("\treturn func(o *core.ClientOptions) {\n")
			opt.WriteString("\t\tif len(scopes) == 0 {\n")
			fmt.Fprintf(&opt, "\t\t\tscopes = %s\n", scopeLiteral)
			opt.WriteString("\t\t}\n")
			opt.WriteString("\t\to.Auth = core.Auth{Kind: core.AuthOAuth2, Source: core.NewTokenSource(\n")
			opt.WriteString("\t\t\tcore.OAuth2Config{\n")
			opt.WriteString("\t\t\t\tFlow:         core.FlowRefreshToken,\n")
			fmt.Fprintf(&opt, "\t\t\t\tTokenURL:     %s,\n", GoString(oauth2.TokenURL))
			opt.WriteString("\t\t\t\tRefreshToken: refreshToken,\n")
			opt.WriteString("\t\t\t\tScopes:       scopes,\n")
			opt.WriteString("\t\t\t},\n")
			opt.WriteString("\t\t\to.HTTPClient,\n")
			opt.WriteString("\t\t)}\n\t}\n}\n\n")
		}
	}
	// One named string type per server variable, with constants for its declared values. This is what
	// Go does instead of a union: `Region` is a distinct type, so a caller cannot pass an arbitrary
	// string, and the constants are discoverable by name in an editor.
	for _, variable := range serverVars {
		typeName := Exported(variable.Name)
		if len(variable.Enum) > 0 {
			fmt.Fprintf(&opt, "// %s is a value for the {%s} variable in the base URL.\n", typeName, variable.WireName)
			fmt.Fprintf(&opt, "type %s string\n\n", typeName)
			opt.WriteString("const (\n")
			for _, value := range variable.Enum {
				fmt.Fprintf(&opt, "\t%s%s %s = %s\n", typeName, exportedValue(value), typeName, GoString(value))
			}
			opt.WriteString(")\n\n")
		}
		argType := "string"
		if len(variable.Enum) > 0 {
			argType = typeName
		}
		fmt.Fprintf(&opt, "// With%s sets the {%s} variable in the base URL.\n", typeName, variable.WireName)
		if variable.Description != "" {
			fmt.Fprintf(&opt, "//\n// %s\n", variable.Description)
		}
		fmt.Fprintf(&opt, "//\n// Defaults to %s.\n", GoString(variable.Default))
		fmt.Fprintf(&opt, "func With%s(v %s) Option {\n", typeName, argType)
		opt.WriteString("\treturn func(o *core.ClientOptions) {\n")
		opt.WriteString("\t\tif o.ServerVariables == nil {\n\t\t\to.ServerVariables = map[string]string{}\n\t\t}\n")
		fmt.Fprintf(&opt, "\t\to.ServerVariables[%s] = string(v)\n\t}\n}\n\n", GoString(variable.WireName))
	}
	opt.WriteString("// WithValidation sets how strictly responses are checked against the declared shape.\n")
	opt.WriteString("//\n")
	opt.WriteString("// core.ValidationStrict (the default) returns a *core.ResponseValidationError naming the\n")
	opt.WriteString("// offending field; core.ValidationWarn logs and continues; core.ValidationOff skips the check.\n")
	opt.WriteString("func WithValidation(mode core.ValidationMode) Option {\n")
	opt.WriteString("\treturn func(o *core.ClientOptions) { o.Validation = mode }\n}\n\n")
	opt.WriteString("// WithHeader sets a header on every request.\n")
	opt.WriteString("func WithHeader(name, value string) Option {\n")
	opt.WriteString("\treturn func(o *core.ClientOptions) {\n")
	opt.WriteString("\t\tif o.DefaultHeaders == nil {\n\t\t\to.DefaultHeaders = map[string]string{}\n\t\t}\n")
	opt.WriteString("\t\to.DefaultHeaders[name] = value\n\t}\n}\n")
	file.Import("net/http")
	file.Import("time")
	file.Add(opt.String())

	// The constructor.
	var ctor strings.Builder
	ctor.WriteString("// New builds a client.\n//\n")
	if bearer != nil && bearer.EnvVar != "" {
		fmt.Fprintf(&ctor, "// The %s environment variable is read when no token is supplied, so the common case is\n", bearer.EnvVar)
		ctor.WriteString("// a bare New().\n")
	} else {
		ctor.WriteString("// Options are applied in order, so a later one wins.\n")
	}
	fmt.Fprintf(&ctor, "func New(opts ...Option) *%s {\n", e.client)
	ctor.WriteString("\toptions := core.ClientOptions{\n")
	if len(serverVars) > 0 {
		// The template plus the spec's defaults, resolved by the runtime after options run. See
		// core.ClientOptions.BaseURLTemplate for why this cannot happen here.
		fmt.Fprintf(&ctor, "\t\tBaseURLTemplate: %s,\n", GoString(defaultServer.URLTemplate))
		ctor.WriteString("\t\tServerVariables: map[string]string{\n")
		for _, variable := range serverVars {
			fmt.Fprintf(&ctor, "\t\t\t%s: %s,\n", GoString(variable.WireName), GoString(variable.Default))
		}
		ctor.WriteString("\t\t},\n")
	} else {
		fmt.Fprintf(&ctor, "\t\tBaseURL: %s,\n", GoString(baseURL))
	}
	fmt.Fprintf(&ctor, "\t\tUserAgent: %s,\n", GoString(e.userAgent()))
	if e.opts.IdempotencyHeader != "" {
		fmt.Fprintf(&ctor, "\t\tIdempotencyHeader: %s,\n", GoString(e.opts.IdempotencyHeader))
	}
	if e.validation != "strict" {
		// A configured default, applied before the options run so a caller's own choice still wins.
		fmt.Fprintf(&ctor, "\t\t// Default from `validation: %s` in %s.\n", e.validation, e.brand.ConfigFile)
		// An explicit map rather than `strings.Title`, which is deprecated and would also happily
		// produce a constant name that does not exist.
		constants := map[string]string{"warn": "ValidationWarn", "off": "ValidationOff"}
		fmt.Fprintf(&ctor, "\t\tValidation: core.%s,\n", constants[e.validation])
	}
	if len(service.ConstantHeaders) > 0 {
		ctor.WriteString("\t\t// Constant on every operation in the spec, so hoisted out of method signatures.\n")
		ctor.WriteString("\t\tDefaultHeaders: map[string]string{\n")
		for _, key := range sortedKeys(service.ConstantHeaders) {
			fmt.Fprintf(&ctor, "\t\t\t%s: %s,\n", GoString(key), GoString(service.ConstantHeaders[key]))
		}
		ctor.WriteString("\t\t},\n")
	}
	ctor.WriteString("\t}\n")
	// Environment defaults, applied *before* the options loop so an explicit option always wins.
	//
	// One block per declared credential rather than for the bearer token alone: reading the
	// environment for one scheme and not the others made `New()` work for a bearer API and silently
	// produce an unauthenticated client for an API-key API, which is the same code path either way.
	env := e.authEnvDefaults(bearer, basic, apiKey, oauthFlows)
	if env != "" {
		// Imported only where it is used; an unconditional import fails `go build`, which is
		// stricter than most languages and correct to be.
		file.Import("os")
		ctor.WriteString(env)
	}
	ctor.WriteString("\tfor _, opt := range opts {\n\t\topt(&options)\n\t}\n")
	ctor.WriteString("\tclient := core.NewClient(options)\n")
	fmt.Fprintf(&ctor, "\treturn &%s{\n\t\tclient: client,\n", e.client)
	for i := range e.ir.Resources {
		r := &e.ir.Resources[i]
		fmt.Fprintf(&ctor, "\t\t%s: new%s(client),\n", Exported(r.Name), e.resourceType(r))
	}
	ctor.WriteString("\t}\n}\n")
	file.Add(ctor.String())

	// Error aliases. The brand a consumer sees should be theirs, not the generator's, so the
	// role-named base is aliased — renaming this project can never break a published SDK.
	var alias strings.Builder
	fmt.Fprintf(&alias, "// %sError is the interface every error this SDK returns satisfies.\n", e.client)
	fmt.Fprintf(&alias, "type %sError = core.SDKError\n\n", e.client)
	alias.WriteString("// Re-exported so callers need not import the vendored runtime directly.\ntype (\n")
	for _, name := range []string{
		"APIError", "ConnectionError", "DecodeError", "RequestOptions",
		"BadRequestError", "AuthenticationError", "PermissionDeniedError", "NotFoundError",
		"ConflictError", "UnprocessableEntityError", "RateLimitError", "InternalServerError",
		// Response validation. Not an APIError, so a caller needs to be able to name it to match it.
		"ResponseValidationError", "ValidationProblem", "ValidationMode",
		// OAuth2. Not an APIError, so a caller needs to be able to name it to match it.
		"OAuth2Error", "OAuth2Config", "TokenSource",
	} {
		fmt.Fprintf(&alias, "\t%s = core.%s\n", name, name)
	}
	alias.WriteString(")\n\n")
	alias.WriteString("// AsAPIError reports whether err is or wraps an *APIError, and returns it.\n")
	alias.WriteString("func AsAPIError(err error) (*APIError, bool) { return core.AsAPIError(err) }\n")
	file.Add(alias.String())

	// Pointer helpers, re-exported so a caller writes acme.String(...) rather than importing core.
	var helpers strings.Builder
	helpers.WriteString("// Pointer helpers. Go has no literal syntax for the address of a constant, so an optional\n")
	helpers.WriteString("// field is set with one of these.\n")
	helpers.WriteString("func String(v string) *string       { return core.String(v) }\n")
	helpers.WriteString("func Int(v int) *int                { return core.Int(v) }\n")
	helpers.WriteString("func Int64(v int64) *int64          { return core.Int64(v) }\n")
	helpers.WriteString("func Float64(v float64) *float64    { return core.Float64(v) }\n")
	helpers.WriteString("func Bool(v bool) *bool             { return core.Bool(v) }\n")
	helpers.WriteString("func Time(v time.Time) *time.Time   { return core.Time(v) }\n\n")
	// The generic form matters for generated types: the named helpers cover the primitives, but an
	// optional enum parameter is a `*QueryKind`, and `String(\"asset\")` gives a `*string`. Without
	// `Ptr` a caller has to declare a local just to take its address, which is the kind of friction
	// that makes an SDK feel generated.
	helpers.WriteString("// Ptr returns a pointer to any value, including a generated enum:\n")
	helpers.WriteString("//\n")
	helpers.WriteString("//\tparams := &SearchQueryParams{Kind: Ptr(QueryKindAsset)}\n")
	helpers.WriteString("func Ptr[T any](v T) *T { return core.Ptr(v) }\n\n")
	helpers.WriteString("// Deref returns the value a pointer holds, or the zero value when it is nil.\n")
	helpers.WriteString("func Deref[T any](p *T) T { return core.Deref(p) }\n")
	file.Add(helpers.String())

	return file.Render()
}

func (e *Emitter) userAgent() string {
	version := e.opts.SDKVersion
	if version == "" {
		version = e.ir.Service.Version
	}
	if version == "" {
		version = "0.1.0"
	}
	return fmt.Sprintf("%s/%s go", e.pkg, version)
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

// scaffold emits go.mod, a README, and a doc.go.
func (e *Emitter) scaffold() []GeneratedFile {
	goMod := fmt.Sprintf("module %s\n\ngo 1.22\n", e.module)

	return []GeneratedFile{
		{Path: "go.mod", Contents: goMod},
		{Path: "README.md", Contents: e.readme()},
	}
}

// authEnvDefaults sets each declared credential from the environment, as Go statements.
//
// Emitted before the options loop, so an explicit option always wins — a caller who passed a token
// meant it. Empty values are treated as absent because `ACME_TOKEN=` is how a variable gets unset in
// a shell, and an empty bearer token produces `Authorization: Bearer ` and a 401 with no visible
// cause.
//
// Assigning `options.Auth` wholesale means the last block wins where a spec declares several schemes
// and several variables happen to be set. That is the same precedence the options loop has, and the
// order here matches the order a caller would expect: a token beats an API key beats Basic.
func (e *Emitter) authEnvDefaults(bearer, basic, apiKey *AuthScheme, oauthFlows []*AuthScheme) string {
	var b strings.Builder
	if basic != nil && basic.UsernameEnvVar != "" && basic.PasswordEnvVar != "" {
		fmt.Fprintf(&b, "\tif username, password := os.Getenv(%s), os.Getenv(%s); username != \"\" && password != \"\" {\n",
			GoString(basic.UsernameEnvVar), GoString(basic.PasswordEnvVar))
		b.WriteString("\t\toptions.Auth = core.Auth{Kind: core.AuthBasic, Username: username, Password: password}\n\t}\n")
	}
	if apiKey != nil && apiKey.EnvVar != "" {
		fmt.Fprintf(&b, "\tif key := os.Getenv(%s); key != \"\" {\n", GoString(apiKey.EnvVar))
		fmt.Fprintf(&b, "\t\toptions.Auth = core.Auth{Kind: core.AuthAPIKey, Token: key, WireName: %s, InQuery: %t}\n\t}\n",
			GoString(apiKey.WireName), apiKey.Location == "query")
	}
	// OAuth2 outranks a static credential: a spec declaring both means "fetch a token, or accept one
	// I already have", and the fetched one is the fresher of the two.
	emitted := map[string]bool{}
	for _, oauth2 := range oauthFlows {
		if emitted[oauth2.Flow] {
			continue
		}
		emitted[oauth2.Flow] = true
		if oauth2.Flow == "clientCredentials" && oauth2.ClientIDEnvVar != "" && oauth2.ClientSecretEnvVar != "" {
			fmt.Fprintf(&b, "\tif id, secret := os.Getenv(%s), os.Getenv(%s); id != \"\" && secret != \"\" {\n",
				GoString(oauth2.ClientIDEnvVar), GoString(oauth2.ClientSecretEnvVar))
			b.WriteString("\t\tWithClientCredentials(id, secret)(&options)\n\t}\n")
		} else if oauth2.Flow == "refreshToken" && oauth2.RefreshTokenEnvVar != "" {
			fmt.Fprintf(&b, "\tif refresh := os.Getenv(%s); refresh != \"\" {\n", GoString(oauth2.RefreshTokenEnvVar))
			b.WriteString("\t\tWithRefreshToken(refresh)(&options)\n\t}\n")
		}
	}
	// Last, so a bearer token wins outright. It is the credential a caller is most likely to have set
	// deliberately, and the cheapest to use — no token exchange.
	if bearer != nil && bearer.EnvVar != "" {
		fmt.Fprintf(&b, "\tif token := os.Getenv(%s); token != \"\" {\n", GoString(bearer.EnvVar))
		b.WriteString("\t\toptions.Auth = core.Auth{Kind: core.AuthBearer, Token: token}\n\t}\n")
	}
	return b.String()
}

// readmeEnvVar names the variable the README's example relies on, or "" when the API declares no
// authentication. Ordered by which credential a reader is most likely to have.
func readmeEnvVar(schemes []AuthScheme) string {
	for _, kind := range []string{"bearer", "apiKey", "basic", "oauth2"} {
		for i := range schemes {
			scheme := &schemes[i]
			if scheme.Kind != kind {
				continue
			}
			switch kind {
			case "bearer", "apiKey":
				if scheme.EnvVar != "" {
					return scheme.EnvVar
				}
			case "basic":
				if scheme.UsernameEnvVar != "" {
					return scheme.UsernameEnvVar
				}
			case "oauth2":
				if scheme.ClientIDEnvVar != "" {
					return scheme.ClientIDEnvVar
				}
				if scheme.RefreshTokenEnvVar != "" {
					return scheme.RefreshTokenEnvVar
				}
			}
		}
	}
	return ""
}

func (e *Emitter) readme() string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s Go SDK\n\n", e.client)
	fmt.Fprintf(&b, "```sh\ngo get %s\n```\n\n", e.module)
	b.WriteString("## Usage\n\n```go\n")
	fmt.Fprintf(&b, "package main\n\nimport (\n\t\"context\"\n\t\"log\"\n\n\t%q\n)\n\n", e.module)
	b.WriteString("func main() {\n\tctx := context.Background()\n")
	fmt.Fprintf(&b, "\tclient := %s.New()\n", e.pkg)
	if example := e.firstExample(); example != "" {
		b.WriteString(example)
	}
	b.WriteString("\t_ = ctx\n\t_ = log.Println\n}\n```\n\n")

	if envVar := readmeEnvVar(e.ir.Service.Auth); envVar != "" {
		fmt.Fprintf(&b, "The client reads `%s` from the environment when no credential is supplied.\n\n", envVar)
	}

	b.WriteString("## Pagination\n\nPaginated methods return an iterator. Errors surface from `Err()` after the loop,\n")
	b.WriteString("which is the convention `bufio.Scanner` and `sql.Rows` both use:\n\n```go\n")
	b.WriteString("it := client.Resource.List(ctx, nil)\nfor it.Next(ctx) {\n\titem := it.Current()\n\t_ = item\n}\n")
	b.WriteString("if err := it.Err(); err != nil {\n\treturn err\n}\n```\n\n")

	b.WriteString("## Errors\n\n```go\nvar notFound *")
	fmt.Fprintf(&b, "%s.NotFoundError\n", e.pkg)
	b.WriteString("if errors.As(err, &notFound) {\n\tlog.Println(notFound.StatusCode, notFound.RequestID)\n}\n```\n\n")
	fmt.Fprintf(&b, "Every error satisfies `%s.%sError`.\n\n", e.pkg, e.client)

	b.WriteString("## Optional fields\n\nGo has no literal syntax for the address of a constant, so optional fields take a pointer:\n\n")
	fmt.Fprintf(&b, "```go\nparams := &%s.WidgetListParams{Limit: %s.Int(50)}\n```\n\n", e.pkg, e.pkg)
	b.WriteString("Read them back with `Deref`, which returns the zero value for nil.\n\n")

	b.WriteString("## Retries and timeouts\n\nConnection failures and 429/5xx responses are retried twice by default, with jittered\n")
	b.WriteString("exponential backoff, honouring `Retry-After`. Override per client or per call:\n\n```go\n")
	fmt.Fprintf(&b, "client := %s.New(%s.WithMaxRetries(0), %s.WithTimeout(30*time.Second))\n```\n\n", e.pkg, e.pkg, e.pkg)

	fmt.Fprintf(&b, "---\n\nGenerated by %s. `internal/core/` is a vendored runtime, so this module depends only on\n", e.brand.Name)
	b.WriteString("the standard library.\n")
	return b.String()
}

// firstExample builds a snippet from a real operation, never an invented one.
func (e *Emitter) firstExample() string {
	for _, r := range e.allResources() {
		for i := range r.Methods {
			m := &r.Methods[i]
			if m.HTTP.Verb != "get" || len(m.HTTP.Params) > 0 || m.PaginationID != "" {
				continue
			}
			if m.Response.Kind != "json" {
				continue
			}
			return fmt.Sprintf("\n\tresult, err := client.%s.%s(ctx, nil)\n\tif err != nil {\n\t\tlog.Fatal(err)\n\t}\n\tlog.Printf(\"%%+v\", result)\n",
				Exported(r.Name), Exported(m.Name))
		}
	}
	return ""
}
