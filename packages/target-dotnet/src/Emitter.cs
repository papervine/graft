using System.Text;

namespace Graft.Target.Dotnet;

/// <summary>One emitted file.</summary>
internal sealed record EmittedFile(string Path, string Contents);

/// <summary>
/// Turns an IR into C# source files.
/// </summary>
/// <remarks>
/// The shape of a generated package: a <c>sealed record</c> per model with <c>required</c> init properties, a
/// resource class per resource holding a <c>Client</c>, a top-level client exposing them, a <c>Schemas</c> class
/// holding the descriptor table, and the vendored runtime under <c>&lt;Namespace&gt;.Core</c>.
/// </remarks>
internal sealed class Emitter
{
  private readonly IDictionary<string, object?> _ir;
  private readonly IDictionary<string, object?> _options;
  private readonly IDictionary<string, object?> _brand;
  private readonly IDictionary<string, object?> _service;
  private readonly TypeMapper _types;
  private readonly Schemas _schemas;
  private readonly List<IDictionary<string, object?>> _warnings = new();

  public Emitter(
      IDictionary<string, object?> ir,
      IDictionary<string, object?> options,
      IDictionary<string, object?> brand)
  {
    _ir = ir;
    _options = options;
    _brand = brand;
    _service = Ir.Obj(Ir.Get(ir, "service"));
    _types = new TypeMapper(ir);
    _schemas = new Schemas(_types);

    var package = Ir.Str(Ir.Get(options, "packageName"), "Acme.Sdk");
    Namespace = Ir.Str(Ir.Get(options, "rootNamespace"), Naming.Namespace(package));
    ClientClass = ResolveClientClass(DeriveClientClass());
  }

  public string Namespace { get; }

  public string ClientClass { get; }

  /// <summary>Diagnostics travelling back in the manifest (SPEC.md §3.5).</summary>
  public IReadOnlyList<IDictionary<string, object?>> Warnings => _warnings;

  internal TypeMapper Types => _types;

  internal Schemas SchemaPlan => _schemas;

  internal IDictionary<string, object?> IrRoot => _ir;

  internal string GeneratedNotice => Ir.Str(Ir.Get(_brand, "generatedNotice"), "Code generated. DO NOT EDIT.");

  internal void Warn(string message) => _warnings.Add(new Dictionary<string, object?>
  {
    ["severity"] = "warn",
    ["code"] = "X001",
    ["message"] = message,
  });

  /// <summary>Every file the SDK consists of.</summary>
  public List<EmittedFile> Emit(IReadOnlyDictionary<string, string> runtime)
  {
    var files = new List<EmittedFile>();
    files.AddRange(ModelFiles());
    files.AddRange(ResourceFiles());
    files.Add(ClientFile());
    files.Add(ErrorAliasFile());

    // After the resources, so every descriptor a method asked for is in the table.
    var schemaFile = SchemaFile();
    if (schemaFile is not null)
    {
      files.Add(schemaFile);
    }

    // The runtime is vendored under `<Namespace>.Core`, so the generated package has no dependency on the
    // generator. A namespace rename is a text substitution here because C# does not tie a namespace to a
    // directory the way Java does.
    var core = Namespace + ".Core";
    foreach (var (name, contents) in runtime)
    {
      files.Add(new EmittedFile(
          "src/Core/" + name,
          contents.Replace("namespace Graft.Runtime;", "namespace " + core + ";", StringComparison.Ordinal)));
    }

    files.Add(ProjectFile());
    files.Add(ReadmeFile());
    // Per-operation examples and tests (SPEC.md §3.11), after the resources so a method the target
    // declined to generate is never referenced.
    files.AddRange(
        new Examples(this, Namespace).Files(Ir.Str(Ir.Get(_options, "packageName"), "Acme.Sdk")));
    return files;
  }

  internal string SourcePath(string typeName) => "src/" + typeName + ".cs";

  // -- models ---------------------------------------------------------------

  private List<EmittedFile> ModelFiles()
  {
    var files = new List<EmittedFile>();
    foreach (var (id, type) in _types.Types)
    {
      var kind = Ir.Str(Ir.Get(type, "kind"));
      // An alias contributes no file: it resolves to its target everywhere it is referenced.
      if (kind == "alias")
      {
        continue;
      }

      var name = _types.NameOf(id);
      var source = kind == "enum" ? EnumSource(name, type) : RecordSource(name, type);
      files.Add(new EmittedFile(SourcePath(name), source));
    }

    return files;
  }

  /// <summary>
  /// A native C# enum plus a wire-value mapping.
  /// </summary>
  /// <remarks>
  /// C# enums cannot carry string values, so the mapping lives in extension methods rather than on the members.
  /// <c>FromWire</c> returns null for an unknown member — the open-enum rule (§3.3.1) — where
  /// <c>Enum.Parse</c> would throw and turn an additive API change into a client crash.
  /// </remarks>
  private string EnumSource(string name, IDictionary<string, object?> type)
  {
    var file = new Source(Namespace, GeneratedNotice);
    var members = Ir.Objects(Ir.Get(type, "members"));
    var docs = Ir.Obj(Ir.Get(type, "docs"));

    var doc = Source.Prose(Ir.Str(Ir.Get(docs, "summary"), name + "."), Ir.StrOrNull(Ir.Get(docs, "description")));

    var body = new StringBuilder(Source.Doc(doc, 0));
    body.Append("public enum ").Append(name).Append("\n{\n");

    var seen = new HashSet<string>(StringComparer.Ordinal);
    var names = new List<(string Member, string Wire)>();
    foreach (var member in members)
    {
      var candidate = Naming.EnumMember(Ir.Tokens(Ir.Get(member, "name")));
      var unique = candidate;
      var suffix = 2;
      while (!seen.Add(unique))
      {
        unique = candidate + suffix++;
      }

      names.Add((unique, Convert.ToString(Ir.Get(member, "wireValue"), System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty));
    }

    body.Append(string.Join(",\n", names.Select(pair => "    " + pair.Member))).Append(",\n}");
    file.Add(body.ToString());

    // Extension methods rather than a static class of constants: `kind.WireValue()` reads as a property of the
    // value, which is how .NET exposes this everywhere.
    var extensions = new StringBuilder(Source.Doc(
        new List<string> { "Wire-value mapping for " + name + "." }, 0));
    extensions.Append("public static class ").Append(name).Append("Extensions\n{\n");
    extensions.Append(Source.Doc(new List<string> { "The value this member is sent as." }, 4));
    extensions.Append("    public static string WireValue(this ").Append(name).Append(" value) => value switch\n    {\n");
    foreach (var (member, wire) in names)
    {
      extensions.Append("        ").Append(name).Append('.').Append(member).Append(" => ")
          .Append(Source.Quote(wire)).Append(",\n");
    }

    // `_ =>` is required: an enum variable can hold any int, so the compiler demands a default arm.
    extensions.Append("        _ => value.ToString(),\n    };\n\n");
    extensions.Append(Source.Doc(
        new List<string>
        {
                "The member with this wire value, or null when the server sent one this SDK does not know.",
        },
        4));
    extensions.Append("    public static ").Append(name).Append("? FromWire(string? value) => value switch\n    {\n");
    foreach (var (member, wire) in names)
    {
      extensions.Append("        ").Append(Source.Quote(wire)).Append(" => ").Append(name).Append('.')
          .Append(member).Append(",\n");
    }

    extensions.Append("        _ => null,\n    };\n}");
    file.Add(extensions.ToString());
    return file.Render();
  }

  private string RecordSource(string name, IDictionary<string, object?> type)
  {
    var file = new Source(Namespace, GeneratedNotice);
    file.AddUsing(Namespace + ".Core");
    var properties = PropertiesOf(type);
    var docs = Ir.Obj(Ir.Get(type, "docs"));

    var doc = Source.Prose(Ir.Str(Ir.Get(docs, "summary"), name + "."), Ir.StrOrNull(Ir.Get(docs, "description")));

    var body = new StringBuilder(Source.Doc(doc, 0));
    body.Append("public sealed record ").Append(name).Append("\n{\n");

    var first = true;
    foreach (var property in properties)
    {
      if (!first)
      {
        body.Append('\n');
      }

      first = false;
      if (property.Summary is not null)
      {
        body.Append(Source.Doc(Source.Prose(property.Summary, null), 4));
      }

      // `required` on a mandatory field: the compiler rejects an object initialiser that omits it, which is
      // what lets this target skip builders entirely (SPEC.md §3.3.11).
      body.Append("    public ").Append(property.Required ? "required " : string.Empty)
          .Append(property.Type).Append(' ').Append(property.Name).Append(" { get; init; }\n");
    }

    body.Append('\n').Append(Decoder(name, properties));
    body.Append('\n').Append(Encoder(properties));
    body.Append('}');

    file.Add(body.ToString());
    return file.Render();
  }

  /// <summary>One property, as the emitter needs it.</summary>
  /// <summary>One property, as the emitter needs it.</summary>
  /// <remarks>
  /// <c>IsValueType</c> is true when the type cannot be null even in principle — a primitive, a timestamp, or an
  /// <b>enum</b>. The encoder must not emit an <c>is not null</c> check for one: comparing a non-nullable value
  /// type to null is CS0037, and enums were the case a hardcoded list of primitives missed. Documented in prose
  /// because C# requires that documenting one record parameter means documenting all of them.
  /// </remarks>
  internal sealed record Property(
      string WireName,
      string Name,
      string Type,
      bool Required,
      string? Summary,
      bool IsValueType);

  /// <summary>Whether a rendered type is a non-nullable value type.</summary>
  private bool IsValueTypeName(string rendered)
  {
    if (rendered.EndsWith('?'))
    {
      return false;
    }

    if (rendered is "long" or "int" or "double" or "bool" or "DateTimeOffset")
    {
      return true;
    }

    return _types.Types.Keys.Any(id => _types.NameOf(id) == rendered && _types.IsEnum(id));
  }

  internal List<Property> PropertiesOf(IDictionary<string, object?> type)
  {
    var result = new List<Property>();
    foreach (var field in Ir.Objects(Ir.Get(type, "fields")))
    {
      var required = Ir.Flag(Ir.Get(field, "required"));
      var reference = Ir.Obj(Ir.Get(field, "type"));
      if (reference.Count == 0)
      {
        reference = new Dictionary<string, object?> { ["kind"] = "unknown" };
      }

      var rendered = _types.Render(reference, required);
      result.Add(new Property(
          Ir.Str(Ir.Get(field, "wireName")),
          Naming.Pascal(Ir.Tokens(Ir.Get(field, "name"))),
          rendered,
          required,
          Ir.StrOrNull(Ir.Get(Ir.Obj(Ir.Get(field, "docs")), "summary")),
          IsValueTypeName(rendered)));
    }

    // Required first, so the mandatory properties a caller must set read together at the top.
    return result.OrderByDescending(property => property.Required).ToList();
  }

  /// <summary>
  /// A decoder from the wire shape.
  /// </summary>
  /// <remarks>
  /// Generated rather than reflective, and not via <c>JsonSerializer.Deserialize</c>: neither knows that the wire
  /// key is <c>_id</c> while the property is <c>Id</c>, and attribute-driven binding would put
  /// <c>[JsonPropertyName]</c> on every property to say what the IR already knows.
  /// </remarks>
  private string Decoder(string name, List<Property> properties)
  {
    var body = new StringBuilder(Source.Doc(new List<string> { "Build from a decoded JSON tree." }, 4));
    body.Append("    public static ").Append(name).Append(" FromJson(object? data)\n    {\n");
    body.Append("        return new ").Append(name).Append("\n        {\n");
    foreach (var property in properties)
    {
      body.Append("            ").Append(property.Name).Append(" = ")
          .Append(Decoding.Read(property, name, _types)).Append(",\n");
    }

    body.Append("        };\n    }\n");
    return body.ToString();
  }

  /// <summary>A JSON tree, for a model used as a request body.</summary>
  private string Encoder(List<Property> properties)
  {
    var body = new StringBuilder(Source.Doc(
        new List<string>
        {
                "This value as a JSON tree, for a request body.",
                string.Empty,
                "A null property is omitted rather than sent as JSON null: absent and null mean different things",
                "to most APIs, and sending null would overwrite a value the caller never touched.",
        },
        4));
    body.Append("    public Dictionary<string, object?> ToJson()\n    {\n");
    body.Append("        var result = new Dictionary<string, object?>();\n");
    foreach (var property in properties)
    {
      body.Append(Decoding.Write(property));
    }

    body.Append("        return result;\n    }\n");
    return body.ToString();
  }

  // -- resources ------------------------------------------------------------

  private List<EmittedFile> ResourceFiles()
  {
    var files = new List<EmittedFile>();
    foreach (var resource in FlatResources())
    {
      var name = ResourceClass(resource);
      files.Add(new EmittedFile(SourcePath(name), ResourceSource(resource, name)));
    }

    return files;
  }

  private List<IDictionary<string, object?>> FlatResources()
  {
    var result = new List<IDictionary<string, object?>>();
    Collect(Ir.Objects(Ir.Get(_ir, "resources")), result);
    return result;
  }

  private void Collect(
      List<IDictionary<string, object?>> resources,
      List<IDictionary<string, object?>> into)
  {
    foreach (var resource in resources)
    {
      into.Add(resource);
      Collect(Ir.Objects(Ir.Get(resource, "subresources")), into);
    }
  }

  internal string ResourceClass(IDictionary<string, object?> resource) =>
      Naming.Pascal(Ir.Tokens(Ir.Get(resource, "name")));

  private string ResourceSource(IDictionary<string, object?> resource, string className)
  {
    var file = new Source(Namespace, GeneratedNotice);
    file.AddUsing(Namespace + ".Core");

    var docs = Ir.Obj(Ir.Get(resource, "docs"));
    var label = string.Join(' ', Ir.Tokens(Ir.Get(resource, "name")));
    var doc = Source.Prose(
        Ir.Str(Ir.Get(docs, "summary"), "The " + label + " resource."),
        Ir.StrOrNull(Ir.Get(docs, "description")));

    var body = new StringBuilder(Source.Doc(doc, 0));
    body.Append("public sealed class ").Append(className).Append("\n{\n");
    // The client is held rather than inherited: a resource *is not* a client, and inheriting would put every
    // transport method on the resource's public surface.
    body.Append("    private readonly Client _client;\n\n");
    body.Append("    internal ").Append(className).Append("(Client client) => _client = client;\n");

    foreach (var method in Ir.Objects(Ir.Get(resource, "methods")))
    {
      var rendered = Methods.Render(this, resource, method, file);
      if (rendered.Length > 0)
      {
        body.Append('\n').Append(rendered);
      }
    }

    foreach (var sub in Ir.Objects(Ir.Get(resource, "subresources")))
    {
      var subClass = ResourceClass(sub);
      var accessor = Naming.Pascal(Ir.Tokens(Ir.Get(sub, "name")));
      body.Append('\n').Append("    public ").Append(subClass).Append(' ').Append(accessor)
          .Append(" => new(_client);\n");
    }

    body.Append('}');
    file.Add(body.ToString());
    return file.Render();
  }

  // -- client ---------------------------------------------------------------

  private EmittedFile ClientFile()
  {
    var file = new Source(Namespace, GeneratedNotice);
    file.AddUsing(Namespace + ".Core");

    var auth = Ir.Objects(Ir.Get(_service, "auth"));
    var hasBearer = auth.Any(scheme => Ir.Str(Ir.Get(scheme, "kind")) == "bearer");
    var hasBasic = auth.Any(scheme => Ir.Str(Ir.Get(scheme, "kind")) == "basic");
    var apiKey = auth.FirstOrDefault(scheme => Ir.Str(Ir.Get(scheme, "kind")) == "apiKey");
    var bearer = auth.FirstOrDefault(scheme => Ir.Str(Ir.Get(scheme, "kind")) == "bearer");
    var basic = auth.FirstOrDefault(scheme => Ir.Str(Ir.Get(scheme, "kind")) == "basic");
    var oauth2 = auth.FirstOrDefault(scheme => Ir.Str(Ir.Get(scheme, "kind")) == "oauth2");
    var clientCredentials =
        oauth2 is not null && Ir.Str(Ir.Get(oauth2, "flow")) == "clientCredentials";

    // Each credential paired with the environment variable it falls back to. The names come from the IR
    // rather than being recomputed here, so every target reads the same variable for the same credential —
    // a client reading ACME_TOKEN in one language and ACMEPLATFORM_TOKEN in another is a support ticket
    // diagnosable from neither side. An empty string means no fallback.
    var envVars = new Dictionary<string, string>
    {
      ["token"] = bearer is null ? string.Empty : Ir.Str(Ir.Get(bearer, "envVar"), string.Empty),
      ["username"] = basic is null ? string.Empty : Ir.Str(Ir.Get(basic, "usernameEnvVar"), string.Empty),
      ["password"] = basic is null ? string.Empty : Ir.Str(Ir.Get(basic, "passwordEnvVar"), string.Empty),
      ["apiKey"] = apiKey is null ? string.Empty : Ir.Str(Ir.Get(apiKey, "envVar"), string.Empty),
      ["clientId"] =
          oauth2 is null ? string.Empty : Ir.Str(Ir.Get(oauth2, "clientIdEnvVar"), string.Empty),
      ["clientSecret"] =
          oauth2 is null ? string.Empty : Ir.Str(Ir.Get(oauth2, "clientSecretEnvVar"), string.Empty),
      ["refreshToken"] =
          oauth2 is null ? string.Empty : Ir.Str(Ir.Get(oauth2, "refreshTokenEnvVar"), string.Empty),
    };
    var readsEnv = envVars.Values.Any(value => value.Length > 0);
    var resources = Ir.Objects(Ir.Get(_ir, "resources"));

    var doc = Source.Prose("The " + ClientClass + " client.", null);

    var body = new StringBuilder(Source.Doc(doc, 0));
    body.Append("public sealed class ").Append(ClientClass).Append("\n{\n");
    body.Append("    private readonly Client _client;\n\n");

    body.Append(Source.Doc(
        new List<string>
        {
                "Construct a client.",
                string.Empty,
                "Every parameter is optional and named, so the common case is a bare constructor call.",
        },
        4));
    body.Append("    public ").Append(ClientClass).Append("(\n");
    var parameters = new List<string>();
    if (hasBearer)
    {
      parameters.Add("        string? token = null");
    }

    if (hasBasic)
    {
      parameters.Add("        string? username = null");
      parameters.Add("        string? password = null");
    }

    if (apiKey is not null)
    {
      parameters.Add("        string? apiKey = null");
    }

    if (oauth2 is not null)
    {
      parameters.Add("        string? clientId = null");
      parameters.Add("        string? clientSecret = null");
      if (!clientCredentials)
      {
        parameters.Add("        string? refreshToken = null");
      }

      parameters.Add("        IReadOnlyList<string>? scopes = null");
    }

    parameters.Add("        string? baseUrl = null");
    parameters.Add("        TimeSpan? timeout = null");
    parameters.Add("        int maxRetries = 2");
    parameters.Add("        IReadOnlyDictionary<string, string>? defaultHeaders = null");
    parameters.Add("        ITransport? transport = null");
    parameters.Add("        ValidationMode? validation = null");
    body.Append(string.Join(",\n", parameters)).Append(")\n    {\n");

    // Credentials resolved into locals first, so the expression below names each one once. Reading the
    // environment inside the expression meant `Resolved(...)` appeared twice per credential — once in the
    // pattern and once in the value — which is two expressions for one credential.
    foreach (var credential in
        new[] { "token", "username", "password", "apiKey", "clientId", "clientSecret", "refreshToken" })
    {
      if (!DeclaresCredential(credential, hasBearer, hasBasic, apiKey, oauth2, clientCredentials))
      {
        continue;
      }

      var variable = envVars[credential];
      body.Append("        var resolved").Append(Naming.Pascal(new[] { credential })).Append(" = ");
      body.Append(variable.Length == 0
          ? credential
          : $"Resolved({credential}, {Source.Quote(variable)})");
      body.Append(";\n");
    }

    body.Append(Oauth2Prelude(oauth2, clientCredentials));
    body.Append("        IAuth auth = ")
        .Append(AuthExpression(hasBearer, hasBasic, apiKey, oauth2))
        .Append(";\n\n");
    body.Append("        _client = new Client(new ClientOptions\n        {\n");
    body.Append("            BaseUrl = baseUrl ?? ").Append(Source.Quote(DefaultBaseUrl())).Append(",\n");
    body.Append("            Auth = auth,\n");
    body.Append("            Timeout = timeout,\n");
    body.Append("            MaxRetries = maxRetries,\n");
    body.Append("            DefaultHeaders = defaultHeaders ?? new Dictionary<string, string>(),\n");
    body.Append("            Transport = transport,\n");
    body.Append("            UserAgent = ").Append(Source.Quote(UserAgent())).Append(",\n");
    body.Append("            Validation = validation ?? ValidationMode.").Append(ValidationConstant()).Append(",\n");
    var idempotency = Ir.StrOrNull(Ir.Get(_options, "idempotencyHeader"));
    if (idempotency is not null)
    {
      body.Append("            IdempotencyHeader = ").Append(Source.Quote(idempotency)).Append(",\n");
    }

    body.Append("        });\n\n");
    foreach (var resource in resources)
    {
      body.Append("        ").Append(Naming.Pascal(Ir.Tokens(Ir.Get(resource, "name"))))
          .Append(" = new ").Append(ResourceClass(resource)).Append("(_client);\n");
    }

    body.Append("    }\n");

    foreach (var resource in resources)
    {
      var accessor = Naming.Pascal(Ir.Tokens(Ir.Get(resource, "name")));
      var docs = Ir.Obj(Ir.Get(resource, "docs"));
      body.Append('\n');
      var summary = Ir.StrOrNull(Ir.Get(docs, "summary"));
      if (summary is not null)
      {
        body.Append(Source.Doc(Source.Prose(summary, null), 4));
      }

      body.Append("    public ").Append(ResourceClass(resource)).Append(' ').Append(accessor)
          .Append(" { get; }\n");
    }

    body.Append('\n').Append(Source.Doc(
        new List<string> { "The underlying transport, for a call this SDK does not cover yet." }, 4));
    body.Append("    public Client Core => _client;\n");

    if (readsEnv)
    {
      body.Append('\n').Append(Source.Doc(
          new List<string>
          {
                    "An explicitly configured value, the environment variable, or null.",
                    string.Empty,
                    "Blank is treated as absent: an unset variable read through a shell often arrives as the empty",
                    "string, and an empty bearer token is never what anyone meant.",
          },
          4));
      body.Append("    private static string? Resolved(string? configured, string environmentVariable)\n    {\n");
      body.Append("        if (!string.IsNullOrWhiteSpace(configured))\n        {\n            return configured;\n        }\n\n");
      body.Append("        var value = Environment.GetEnvironmentVariable(environmentVariable);\n");
      body.Append("        return string.IsNullOrWhiteSpace(value) ? null : value;\n    }\n");
    }

    body.Append('}');
    file.Add(body.ToString());
    return new EmittedFile(SourcePath(ClientClass), file.Render());
  }

  /// <summary>
  /// The auth expression, giving every declared scheme a branch.
  /// </summary>
  /// <remarks>
  /// Every scheme the spec declares gets one. An earlier version of the TypeScript target checked only for a
  /// bearer token, so a spec declaring both OAuth2 and an API key generated a client that silently ignored the
  /// key — it compiled, it looked right, and it could not authenticate (SPEC.md §3.1.6).
  /// </remarks>
  /// <summary>
  /// The token source, built before the auth expression so the expression stays one conditional.
  /// </summary>
  /// <remarks>
  /// A local rather than an inline construction, because the source needs the caller's transport — a token
  /// fetched over a different one would bypass a test's injected transport and make a real network call for
  /// authentication, which is the whole point of being able to inject it.
  /// </remarks>
  private static string Oauth2Prelude(IDictionary<string, object?>? oauth2, bool clientCredentials)
  {
    if (oauth2 is null)
    {
      return string.Empty;
    }

    var scopeNames = Ir.Objects(Ir.Get(oauth2, "scopes"))
        .Select(scope => Source.Quote(Ir.Str(Ir.Get(scope, "name"), string.Empty)))
        .ToList();
    var defaultScopes = scopeNames.Count == 0
        ? "scopes ?? Array.Empty<string>()"
        : "scopes ?? new[] { " + string.Join(", ", scopeNames) + " }";
    var ready = clientCredentials
        ? "resolvedClientId is not null && resolvedClientSecret is not null"
        : "resolvedRefreshToken is not null";

    var out_ = new StringBuilder();
    out_.Append("        var tokenSource = ").Append(ready).Append("\n            ? new TokenSource(\n");
    out_.Append("                new OAuth2Config\n                {\n");
    out_.Append("                    TokenUrl = ")
        .Append(Source.Quote(Ir.Str(Ir.Get(oauth2, "tokenUrl"), string.Empty)))
        .Append(",\n");
    out_.Append("                    ClientId = resolvedClientId,\n");
    out_.Append("                    ClientSecret = resolvedClientSecret,\n");
    if (!clientCredentials)
    {
      out_.Append("                    RefreshToken = resolvedRefreshToken,\n");
    }

    out_.Append("                    Scopes = ").Append(defaultScopes).Append(",\n");
    out_.Append("                },\n");
    // The caller's transport when they supplied one, or the default the Client would build.
    out_.Append("                transport ?? new HttpClientTransport())\n            : null;\n");
    return out_.ToString();
  }

  private static string AuthExpression(
      bool hasBearer,
      bool hasBasic,
      IDictionary<string, object?>? apiKey,
      IDictionary<string, object?>? oauth2 = null)
  {
    var rungs = new List<string>();
    if (oauth2 is not null)
    {
      // OAuth2 first: a spec declaring it alongside a static credential means "fetch a token, or accept one
      // I already have", and the fetched one is the fresher of the two.
      rungs.Add("tokenSource is not null\n            ? new OAuth2Auth(tokenSource)");
    }
    if (hasBearer)
    {
      rungs.Add("resolvedToken is not null\n            ? new BearerAuth(resolvedToken)");
    }

    if (hasBasic)
    {
      rungs.Add("resolvedUsername is not null && resolvedPassword is not null\n            ? new BasicAuth(resolvedUsername, resolvedPassword)");
    }

    if (apiKey is not null)
    {
      var name = Source.Quote(Ir.Str(Ir.Get(apiKey, "wireName"), "X-Api-Key"));
      var inQuery = Ir.Str(Ir.Get(apiKey, "location"), "header") == "query" ? "true" : "false";
      rungs.Add($"resolvedApiKey is not null\n            ? new ApiKeyAuth(resolvedApiKey, {name}, {inQuery})");
    }

    if (rungs.Count == 0)
    {
      return "NoAuth.Instance";
    }

    return string.Join("\n            : ", rungs) + "\n            : NoAuth.Instance";
  }

  /// <summary>Whether the spec declares the named credential at all.</summary>
  private static bool DeclaresCredential(
      string credential,
      bool hasBearer,
      bool hasBasic,
      IDictionary<string, object?>? apiKey,
      IDictionary<string, object?>? oauth2,
      bool clientCredentials) => credential switch
      {
        "token" => hasBearer,
        "username" or "password" => hasBasic,
        "apiKey" => apiKey is not null,
        // Both flows accept client credentials: the refresh flow needs them when the token endpoint is
        // confidential, which plenty are.
        "clientId" or "clientSecret" => oauth2 is not null,
        "refreshToken" => oauth2 is not null && !clientCredentials,
        _ => false,
      };

  private string ValidationConstant() => Ir.Str(Ir.Get(_options, "validation"), "strict") switch
  {
    "warn" => "Warn",
    "off" => "Off",
    _ => "Strict",
  };

  private string DefaultBaseUrl()
  {
    IDictionary<string, object?>? chosen = null;
    foreach (var server in Ir.Objects(Ir.Get(_service, "servers")))
    {
      if (chosen is null || Ir.Flag(Ir.Get(server, "default")))
      {
        chosen = server;
      }
    }

    return chosen is null ? string.Empty : Ir.Str(Ir.Get(chosen, "url"));
  }

  private string UserAgent() =>
      ClientClass.ToLowerInvariant() + "/" + Ir.Str(Ir.Get(_service, "version"), "0.0.0") + " dotnet";

  /// <summary>
  /// The client class name, adjusted when it collides with a namespace segment.
  /// </summary>
  /// <remarks>
  /// <para>
  /// C#-specific, and a real bug rather than a style concern. A spec titled "Widget Co" packaged as
  /// <c>WidgetCo.Sdk</c> yields a client class <c>WidgetCo</c> inside namespace <c>WidgetCo.Sdk</c> — and from
  /// outside, <c>WidgetCo</c> resolves to the <i>namespace</i>. The consumer's code does not compile:
  /// "'WidgetCo' is a namespace but is used like a type".
  /// </para>
  /// <para>
  /// Resolved by suffixing <c>Client</c>, which is also .NET's own convention (<c>HttpClient</c>,
  /// <c>BlobServiceClient</c>) — so the fallback reads native rather than apologetic. The plain name is kept when
  /// there is no collision, matching every other target, where <c>new Acme()</c> already says "construct a
  /// client".
  /// </para>
  /// </remarks>
  private string ResolveClientClass(string candidate)
  {
    var segments = Namespace.Split('.');
    if (!segments.Contains(candidate, StringComparer.Ordinal))
    {
      return candidate;
    }

    var renamed = candidate + "Client";
    Warn(
        $"`{candidate}` is also a segment of the namespace `{Namespace}`, which C# cannot disambiguate, so the "
        + $"client class is `{renamed}`. Set `clientName` or `rootNamespace` to choose something else.");
    return renamed;
  }

  private string DeriveClientClass()
  {
    var configured = Ir.StrOrNull(Ir.Get(_options, "clientName"));
    if (configured is not null)
    {
      return Naming.Pascal(new[] { configured });
    }

    var display = Ir.StrOrNull(Ir.Get(_service, "displayName"));
    if (display is not null)
    {
      var cleaned = new string(display.Where(char.IsLetterOrDigit).ToArray());
      if (cleaned.Length > 0)
      {
        return Naming.Pascal(new[] { cleaned });
      }
    }

    return Naming.Pascal(Ir.Tokens(Ir.Get(_service, "name")));
  }

  private string ServiceLabel() =>
      Ir.StrOrNull(Ir.Get(_service, "displayName")) ?? string.Join(' ', Ir.Tokens(Ir.Get(_service, "name")));

  // -- errors, schemas, package ---------------------------------------------

  /// <summary>
  /// Aliases the runtime's error base under the consumer's own name.
  /// </summary>
  /// <remarks>
  /// The runtime's base is <c>SdkException</c>, named for its role. Generated code aliases it so a <c>catch</c>
  /// reads in the user's terms — and so a rename of this project is not a breaking change for every SDK it ever
  /// produced (SPEC.md §1.2).
  /// </remarks>
  private EmittedFile ErrorAliasFile()
  {
    var alias = ClientClass + "Exception";
    var file = new Source(Namespace, GeneratedNotice);
    file.AddUsing(Namespace + ".Core");
    var body = new StringBuilder(Source.Doc(
        new List<string>
        {
                "Every error this SDK raises satisfies this type.",
                string.Empty,
                "An abstract subclass rather than a using alias, so it survives across files and works in a",
                "catch clause the way a real type does.",
        },
        0));
    body.Append("public abstract class ").Append(alias).Append(" : SdkException\n{\n");
    body.Append("    protected ").Append(alias).Append("(string message)\n        : base(message)\n    {\n    }\n}");
    file.Add(body.ToString());
    return new EmittedFile(SourcePath(alias), file.Render());
  }

  private EmittedFile? SchemaFile()
  {
    if (_schemas.Table.Count == 0)
    {
      return null;
    }

    var file = new Source(Namespace, GeneratedNotice);
    file.AddUsing(Namespace + ".Core");
    var body = new StringBuilder(Source.Doc(
        new List<string>
        {
                "Runtime validation descriptors.",
                string.Empty,
                "Data rather than generated checks: one hand-written walker in the runtime interprets this, which",
                "is more trustworthy than a validator generated per type and a fraction of the size. Only types",
                "reachable from a response are here.",
                string.Empty,
                "Parsed once, at static initialisation. A per-call parse would be a per-request cost for data",
                "that never changes.",
        },
        0));
    body.Append("internal static class Schemas\n{\n");
    body.Append("    internal static readonly IReadOnlyDictionary<string, Schema> Table = Schema.Table(\n");

    // Concatenated string literals, joined by the compiler, so no single literal grows unmanageable and the
    // table stays readable in a diff.
    var entries = _schemas.Table.Select(pair => Source.Quote("\"" + pair.Key + "\":" + pair.Value));
    body.Append("        \"{\"\n        + ").Append(string.Join("\n        + \",\"\n        + ", entries));
    body.Append("\n        + \"}\");\n}");
    file.Add(body.ToString());
    return new EmittedFile(SourcePath("Schemas"), file.Render());
  }

  private EmittedFile ProjectFile()
  {
    var package = Ir.Str(Ir.Get(_options, "packageName"), "Acme.Sdk");
    var version = Ir.Str(Ir.Get(_options, "sdkVersion"), "0.1.0");
    var contents = $"""
            <Project Sdk="Microsoft.NET.Sdk">

              <PropertyGroup>
                <TargetFramework>net8.0</TargetFramework>
                <LangVersion>12</LangVersion>
                <Nullable>enable</Nullable>
                <ImplicitUsings>enable</ImplicitUsings>
                <PackageId>{package}</PackageId>
                <Version>{version}</Version>
                <Description>.NET SDK for {ServiceLabel()}.</Description>
                <RootNamespace>{Namespace}</RootNamespace>
                <GenerateDocumentationFile>true</GenerateDocumentationFile>
                <!--
                  CS1591 is "missing XML comment for publicly visible member". Suppressed because the vendored
                  runtime documents what matters rather than everything: a comment on every constructor
                  overload is noise a reader has to scroll past, and requiring one would reward it. The types a
                  consumer actually reads are documented from the spec.
                -->
                <NoWarn>$(NoWarn);CS1591</NoWarn>
              </PropertyGroup>

              <!--
                The test project is a sibling directory, and `Microsoft.NET.Sdk` globs every `.cs` beneath
                the project by default — so without this the library compiled the tests too and failed on
                the xUnit import. Excluded rather than moved, because `tests/` beside the project is the
                layout a .NET developer expects.
              -->
              <ItemGroup>
                <Compile Remove="tests/**" />
                <None Remove="tests/**" />
              </ItemGroup>

              <!--
                No package references. System.Text.Json and System.Net.Http are both in the BCL, so this SDK
                cannot conflict with what your application already depends on.
              -->

            </Project>

            """;
    return new EmittedFile(package + ".csproj", contents);
  }

  private EmittedFile ReadmeFile()
  {
    var package = Ir.Str(Ir.Get(_options, "packageName"), "Acme.Sdk");
    var lines = new List<string>
        {
            "# " + package,
            string.Empty,
            ".NET SDK for " + ServiceLabel() + " v" + Ir.Str(Ir.Get(_service, "version")) + ".",
            string.Empty,
            "Requires **.NET 8**. No package references: `System.Text.Json` and `System.Net.Http` are both in the",
            "BCL, so this SDK cannot conflict with what your application already uses.",
            string.Empty,
            "## Install",
            string.Empty,
            "```sh",
            "dotnet add package " + package,
            "```",
            string.Empty,
            "## Quick start",
            string.Empty,
            "```csharp",
            "using " + Namespace + ";",
            string.Empty,
            "var client = new " + ClientClass + "();",
            "```",
            string.Empty,
            "Every method is async, because `HttpClient` has no synchronous API worth using.",
            string.Empty,
            "## Errors",
            string.Empty,
            "Every error extends `" + ClientClass + "Exception`:",
            string.Empty,
            "```csharp",
            "using " + Namespace + ".Core;",
            string.Empty,
            "try",
            "{",
            "    // ...",
            "}",
            "catch (NotFoundException e)",
            "{",
            "    Console.WriteLine(e.StatusCode); // 404",
            "}",
            "```",
            string.Empty,
            "---",
            string.Empty,
            Ir.Str(Ir.Get(_brand, "attribution")),
        };
    return new EmittedFile("README.md", string.Join("\n", lines) + "\n");
  }
}
