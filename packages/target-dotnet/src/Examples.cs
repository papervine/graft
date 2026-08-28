using Besdk.Runtime;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace Besdk.Target.Dotnet;

/// <summary>
/// Per-operation examples and tests (SPEC.md §3.11).
/// </summary>
/// <remarks>
/// <para>
/// The <em>values</em> come from <c>Method.example</c> in the IR, so every language shows the same data for
/// the same operation. Only the rendering is here, which is the whole division that section sets up: a
/// target deciding what a plausible value is would be the sixth copy of one judgment.
/// </para>
/// <para>
/// Both land in a <em>separate test project</em>. Putting them in the library project would ship the tests
/// and the examples inside the published DLL, and a separate project is what a .NET developer expects
/// anyway — `dotnet test` finds it, and `dotnet build` in the package root does not.
/// </para>
/// </remarks>
internal sealed class Examples
{
  private readonly Emitter _emitter;
  private readonly string _rootNamespace;

  internal Examples(Emitter emitter, string rootNamespace)
  {
    _emitter = emitter;
    _rootNamespace = rootNamespace;
  }

  private sealed record Accessor(string Path, IDictionary<string, object?> Resource);

  /// <summary>
  /// Every resource with the path a caller uses to reach it.
  /// </summary>
  /// <remarks>
  /// The flat list has no paths, which is fine for emitting a class and useless for writing a call: a
  /// nested resource reached as <c>client.Invoices</c> does not exist. .NET reaches every resource by a
  /// property, top-level and nested alike.
  /// </remarks>
  private List<Accessor> Accessors()
  {
    var out_ = new List<Accessor>();
    Walk(Ir.Objects(Ir.Get(_emitter.IrRoot, "resources")), string.Empty, out_);
    return out_;
  }

  private void Walk(List<IDictionary<string, object?>> resources, string prefix, List<Accessor> into)
  {
    foreach (var resource in resources)
    {
      var name = Naming.Pascal(Ir.Tokens(Ir.Get(resource, "name")));
      var path = prefix.Length == 0 ? name : prefix + "." + name;
      into.Add(new Accessor(path, resource));
      Walk(Ir.Objects(Ir.Get(resource, "subresources")), path, into);
    }
  }

  /// <summary>
  /// Render an example value as C# source, guided by the type it must satisfy.
  /// </summary>
  /// <remarks>
  /// Type-directed because C# needs it: a model is an object initialiser with named properties, an enum is
  /// a member reference, and a <c>DateTimeOffset</c> is a parse call. None can be produced from the JSON
  /// value alone.
  /// </remarks>
  private string Literal(IDictionary<string, object?>? reference, object? value, int indent)
  {
    if (reference is null || reference.Count == 0)
    {
      return Bare(value);
    }

    var kind = Ir.Str(Ir.Get(reference, "kind"), string.Empty);
    var pad = new string(' ', (indent + 1) * 2);
    var close = new string(' ', indent * 2);

    switch (kind)
    {
      case "nullable":
        return value is null ? "null" : Literal(Ir.Obj(Ir.Get(reference, "inner")), value, indent);
      case "primitive":
        {
          // A `format` maps to a real type, not `string` — a `date-time` field is a `DateTimeOffset`. The
          // core supplies the wire value, which is a string, so a bare literal does not compile on exactly
          // the fields most likely to appear in an example.
          var format = Ir.Str(Ir.Get(reference, "format"), string.Empty);
          if (value is string text && (format == "date-time" || format == "date"))
          {
            return $"DateTimeOffset.Parse({Source.Quote(text)}, CultureInfo.InvariantCulture)";
          }

          return Bare(value);
        }
      case "array":
        {
          if (value is not IReadOnlyList<object?> items || items.Count == 0)
          {
            return "new " + _emitter.Types.Render(reference, false) + "()";
          }

          var parts = items
              .Select(item => pad + Literal(Ir.Obj(Ir.Get(reference, "items")), item, indent + 1))
              .ToList();
          return "new[]\n" + close + "{\n" + string.Join(",\n", parts) + ",\n" + close + "}";
        }
      case "union":
        {
          // The first variant, matching what the core synthesized from. A union renders as `object` in C#
          // (§3.3.11), so the literal has to be a concrete value of *some* variant.
          var variants = Ir.Objects(Ir.Get(reference, "variants"));
          return variants.Count == 0 ? Bare(value) : Literal(variants[0], value, indent);
        }
      case "named":
        {
          if (!_emitter.Types.Types.TryGetValue(Ir.Str(Ir.Get(reference, "id"), string.Empty), out var type))
          {
            return Bare(value);
          }

          var typeKind = Ir.Str(Ir.Get(type, "kind"), string.Empty);
          if (typeKind == "alias")
          {
            return Literal(Ir.Obj(Ir.Get(type, "target")), value, indent);
          }

          var className = _emitter.Types.Render(reference, false).TrimEnd('?');
          if (typeKind == "enum")
          {
            // A member reference, matched on the *wire* value: a C# enum carries no string, so the mapping
            // lives in `WireValue()` extensions and the member name cannot be derived from the value here.
            foreach (var member in Ir.Objects(Ir.Get(type, "members")))
            {
              if (Convert.ToString(Ir.Get(member, "wireValue"), CultureInfo.InvariantCulture)
                  == Convert.ToString(value, CultureInfo.InvariantCulture))
              {
                return className + "." + Naming.Pascal(Ir.Tokens(Ir.Get(member, "name")));
              }
            }

            return "default";
          }

          if (value is not IReadOnlyDictionary<string, object?> fields)
          {
            return Bare(value);
          }

          // An object initialiser with named properties, which is what `required` init properties declare —
          // and why this target has no builders anywhere.
          var assignments = new List<string>();
          foreach (var field in Ir.Objects(Ir.Get(type, "fields")))
          {
            var wire = Ir.Str(Ir.Get(field, "wireName"), string.Empty);
            if (!fields.TryGetValue(wire, out var raw) || raw is null)
            {
              continue;
            }

            assignments.Add(
                pad
                + Naming.Pascal(Ir.Tokens(Ir.Get(field, "name")))
                + " = "
                + Literal(Ir.Obj(Ir.Get(field, "type")), raw, indent + 1));
          }

          return assignments.Count == 0
              ? "new " + className + "()"
              : "new " + className + "\n" + close + "{\n" + string.Join(",\n", assignments) + ",\n" + close + "}";
        }

      default:
        return Bare(value);
    }
  }

  /// <summary>A value with no type to guide it, which is correct for <c>object</c> and map values.</summary>
  private string Bare(object? value) => value switch
  {
    null => "null",
    string text => Source.Quote(text),
    bool flag => flag ? "true" : "false",
    // A JSON number parses as a double, so an id would otherwise be `1.0` where a `long` is declared.
    double number when number == Math.Floor(number) && Math.Abs(number) < 1e15 =>
        ((long)number).ToString(CultureInfo.InvariantCulture),
    double number => number.ToString(CultureInfo.InvariantCulture),
    long number => number.ToString(CultureInfo.InvariantCulture),
    int number => number.ToString(CultureInfo.InvariantCulture),
    IReadOnlyList<object?> items =>
        "new object?[] { " + string.Join(", ", items.Select(Bare)) + " }",
    IReadOnlyDictionary<string, object?> fields =>
        "new Dictionary<string, object?> { "
        + string.Join(
            ", ",
            fields.Where(pair => pair.Value is not null)
                  .Select(pair => $"[{Source.Quote(pair.Key)}] = {Bare(pair.Value)}"))
        + " }",
    _ => "null",
  };

  /// <summary>
  /// The arguments for one call.
  /// </summary>
  /// <remarks>
  /// Path parameters positionally, then the body, then any query parameter the example carries — passed by
  /// name, which is what makes a C# call readable and what the generated signature supports.
  /// </remarks>
  private string Args(IDictionary<string, object?> method)
  {
    var example = Ir.Obj(Ir.Get(method, "example"));
    if (example.Count == 0)
    {
      return string.Empty;
    }

    var parameters = Ir.Obj(Ir.Get(example, "params"));
    var http = Ir.Obj(Ir.Get(method, "http"));
    var args = new List<string>();

    foreach (var param in Ir.Objects(Ir.Get(http, "params")))
    {
      if (Ir.Str(Ir.Get(param, "location")) != "path")
      {
        continue;
      }

      args.Add(Literal(Ir.Obj(Ir.Get(param, "type")), Ir.Get(parameters, Ir.Str(Ir.Get(param, "wireName"), string.Empty)), 2));
    }

    var body = Ir.Obj(Ir.Get(method, "body"));
    if (body.Count > 0 && example.ContainsKey("body"))
    {
      args.Add(Literal(Ir.Obj(Ir.Get(body, "type")), example["body"], 2));
    }

    foreach (var param in Ir.Objects(Ir.Get(http, "params")))
    {
      var location = Ir.Str(Ir.Get(param, "location"));
      if (location is "path" or "cookie")
      {
        continue;
      }

      var wire = Ir.Str(Ir.Get(param, "wireName"), string.Empty);
      if (!parameters.ContainsKey(wire))
      {
        continue;
      }

      args.Add(
          Naming.Camel(Ir.Tokens(Ir.Get(param, "name")))
          + ": "
          + Literal(Ir.Obj(Ir.Get(param, "type")), parameters[wire], 2));
    }

    return string.Join(", ", args);
  }

  /// <summary>
  /// The path the SDK should produce, with the example's values interpolated.
  /// </summary>
  /// <remarks>
  /// Computed rather than asserted loosely: path interpolation is one of the four things a generated test
  /// exists to check, and a test asserting only that the path <em>contains</em> a resource name would pass
  /// while <c>/orgs/{orgId}/members</c> came out as <c>/orgs//members</c>.
  /// </remarks>
  private static string ExamplePath(IDictionary<string, object?> method)
  {
    var http = Ir.Obj(Ir.Get(method, "http"));
    var path = Ir.Str(Ir.Get(http, "path"), "/");
    var parameters = Ir.Obj(Ir.Get(Ir.Obj(Ir.Get(method, "example")), "params"));
    foreach (var param in Ir.Objects(Ir.Get(http, "params")))
    {
      if (Ir.Str(Ir.Get(param, "location")) != "path")
      {
        continue;
      }

      var wire = Ir.Str(Ir.Get(param, "wireName"), string.Empty);
      var value = Ir.Get(parameters, wire);
      var encoded = Uri.EscapeDataString(Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty);
      path = path.Replace("{" + wire + "}", encoded, StringComparison.Ordinal);
    }

    return path;
  }

  private string ClassName(Accessor accessor, IDictionary<string, object?> method) =>
      accessor.Path.Replace(".", string.Empty, StringComparison.Ordinal)
      + Naming.Pascal(Ir.Tokens(Ir.Get(method, "name")));

  /// <summary>Whether this target declines to generate the operation.</summary>
  private static bool Skips(IDictionary<string, object?> method) =>
      Ir.Str(Ir.Get(Ir.Obj(Ir.Get(method, "response")), "kind")) == "stream";

  internal List<EmittedFile> Files(string packageId)
  {
    var files = new List<EmittedFile>();
    var any = false;

    foreach (var accessor in Accessors())
    {
      foreach (var method in Ir.Objects(Ir.Get(accessor.Resource, "methods")))
      {
        if (Ir.Obj(Ir.Get(method, "example")).Count == 0 || Skips(method))
        {
          continue;
        }

        any = true;
        files.Add(ExampleFile(accessor, method));
        files.Add(TestFile(accessor, method));
      }
    }

    if (any)
    {
      files.Add(TestProjectFile(packageId));
    }

    return files;
  }

  private EmittedFile ExampleFile(Accessor accessor, IDictionary<string, object?> method)
  {
    var name = ClassName(accessor, method) + "Example";
    var http = Ir.Obj(Ir.Get(method, "http"));
    var docs = Ir.Obj(Ir.Get(method, "docs"));
    var response = Ir.Obj(Ir.Get(method, "response"));
    var kind = Ir.Str(Ir.Get(response, "kind"), "empty");
    var paginated = Ir.Str(Ir.Get(method, "paginationId"), string.Empty).Length > 0;
    var suffix = paginated ? string.Empty : "Async";
    var call =
        $"client.{accessor.Path}.{Naming.Pascal(Ir.Tokens(Ir.Get(method, "name")))}{suffix}({Args(method)})";

    var body = new StringBuilder();
    body.Append("using System;\nusing System.Collections.Generic;\nusing System.Globalization;\n");
    body.Append("using System.Threading.Tasks;\n");
    body.Append($"using {_rootNamespace};\n\n");
    body.Append($"namespace {_rootNamespace}.Tests;\n\n");
    body.Append("/// <summary>\n/// ")
        .Append(Ir.Str(Ir.Get(docs, "summary"), accessor.Path).Replace("<", "&lt;", StringComparison.Ordinal))
        .Append("\n/// </summary>\n/// <remarks>\n/// ")
        .Append(Ir.Str(Ir.Get(http, "verb"), "get").ToUpperInvariant())
        .Append(' ')
        .Append(Ir.Str(Ir.Get(http, "path"), "/"))
        .Append("\n///\n/// <para>Values are synthesized from the spec, so ids and placeholders are not real.\n");
    body.Append("/// Compiled with this package's tests, so it cannot drift out of date with the API.</para>\n");
    body.Append("/// </remarks>\n");
    body.Append($"internal static class {name}\n{{\n");
    body.Append($"  internal static async Task RunAsync({_emitter.ClientClass} client)\n  {{\n");
    if (paginated)
    {
      body.Append($"    await foreach (var item in {call})\n    {{\n      Console.WriteLine(item);\n    }}\n");
    }
    else if (kind == "empty")
    {
      body.Append($"    await {call}.ConfigureAwait(false);\n");
    }
    else
    {
      body.Append($"    var result = await {call}.ConfigureAwait(false);\n    Console.WriteLine(result);\n");
    }

    body.Append("  }\n}\n");
    return new EmittedFile($"tests/{name}.cs", body.ToString());
  }

  private EmittedFile TestFile(Accessor accessor, IDictionary<string, object?> method)
  {
    var name = ClassName(accessor, method) + "Test";
    var http = Ir.Obj(Ir.Get(method, "http"));
    var verb = Ir.Str(Ir.Get(http, "verb"), "get").ToUpperInvariant();
    var response = Ir.Obj(Ir.Get(method, "response"));
    var kind = Ir.Str(Ir.Get(response, "kind"), "empty");
    var status = Ir.Get(response, "statusCode") is double code ? (int)code : 200;
    var example = Ir.Obj(Ir.Get(method, "example"));
    var paginated = Ir.Str(Ir.Get(method, "paginationId"), string.Empty).Length > 0;
    var suffix = paginated ? string.Empty : "Async";

    var payload = "\"\"";
    var contentType = "application/json";
    if (example.ContainsKey("response"))
    {
      if (kind == "text")
      {
        contentType = "text/plain";
        payload = Source.Quote(Convert.ToString(example["response"], CultureInfo.InvariantCulture) ?? string.Empty);
      }
      else
      {
        payload = Source.Quote(Json.Write(example["response"]));
      }
    }

    var call =
        $"client.{accessor.Path}.{Naming.Pascal(Ir.Tokens(Ir.Get(method, "name")))}{suffix}({Args(method)})";

    var body = new StringBuilder();
    body.Append("using System;\nusing System.Collections.Generic;\nusing System.Globalization;\n");
    body.Append("using System.Threading;\nusing System.Threading.Tasks;\n");
    body.Append($"using {_rootNamespace};\nusing {_rootNamespace}.Core;\nusing Xunit;\n\n");
    body.Append($"namespace {_rootNamespace}.Tests;\n\n");
    body.Append("/// <summary>\n/// ")
        .Append(accessor.Path)
        .Append('.')
        .Append(Naming.Pascal(Ir.Tokens(Ir.Get(method, "name"))))
        .Append(" — ")
        .Append(verb)
        .Append(' ')
        .Append(Ir.Str(Ir.Get(http, "path"), "/"))
        .Append("\n/// </summary>\n/// <remarks>\n");
    body.Append("/// Generated from the spec. Asserts the request this SDK builds and that the declared\n");
    body.Append("/// response decodes; it asserts nothing about the API being up, because it never calls it.\n");
    body.Append("///\n/// <para>Regenerated on every run and not preserved — edit the spec, not this file.</para>\n");
    body.Append("/// </remarks>\n");
    body.Append($"public sealed class {name}\n{{\n");
    body.Append("  private sealed class Recording : ITransport\n  {\n");
    body.Append("    internal HttpRequestSpec? Seen { get; private set; }\n\n");
    body.Append("    public Task<HttpResponseSpec> SendAsync(\n");
    body.Append("        HttpRequestSpec request, TimeSpan timeout, CancellationToken cancellationToken = default)\n");
    body.Append("    {\n      Seen = request;\n      return Task.FromResult(new HttpResponseSpec(\n          ");
    body.Append(status.ToString(CultureInfo.InvariantCulture))
        .Append(", ")
        .Append(payload)
        .Append(", new Dictionary<string, string> { [\"content-type\"] = ")
        .Append(Source.Quote(contentType))
        .Append(" }));\n    }\n  }\n\n");
    body.Append("  [Fact]\n  public async Task BuildsTheDocumentedRequestAsync()\n  {\n");
    body.Append("    var transport = new Recording();\n");
    body.Append($"    var client = new {_emitter.ClientClass}(baseUrl: \"https://api.test\", transport: transport);\n\n");
    // No `ConfigureAwait(false)` here, deliberately — and *unlike* the SDK itself and the examples.
    // xUnit's own analyser (xUnit1030) reports it as a defect in a test, because it bypasses the runner's
    // parallelisation limits. A generated test that trips the test framework's linter is a generated test
    // someone will delete.
    if (paginated)
    {
      body.Append($"    await foreach (var item in {call})\n    {{\n      break;\n    }}\n\n");
    }
    else
    {
      body.Append($"    await {call};\n\n");
    }

    body.Append("    Assert.NotNull(transport.Seen);\n");
    body.Append($"    Assert.Equal({Source.Quote(verb)}, transport.Seen!.Method);\n");
    body.Append($"    Assert.Equal({Source.Quote(ExamplePath(method))}, new Uri(transport.Seen.Url).AbsolutePath);\n");

    var requestBody = Ir.Obj(Ir.Get(method, "body"));
    if (requestBody.Count > 0 && example.ContainsKey("body"))
    {
      var declared = Ir.Str(Ir.Get(requestBody, "contentType"), string.Empty).ToLowerInvariant();
      body.Append("\n    // Declared as ")
          .Append(Ir.Str(Ir.Get(requestBody, "contentType"), string.Empty))
          .Append(" in the spec.\n");
      body.Append("    var sentType = transport.Seen.Headers.TryGetValue(\"Content-Type\", out var found) ? found : \"\";\n");
      if (declared.Contains("x-www-form-urlencoded", StringComparison.Ordinal))
      {
        body.Append("    Assert.Contains(\"x-www-form-urlencoded\", sentType, StringComparison.Ordinal);\n");
      }
      else if (declared.StartsWith("multipart/", StringComparison.Ordinal))
      {
        body.Append("    Assert.StartsWith(\"multipart/form-data\", sentType, StringComparison.Ordinal);\n");
        body.Append("    // A boundary is what makes a multipart body parseable at all.\n");
        body.Append("    Assert.Contains(\"boundary=\", sentType, StringComparison.Ordinal);\n");
      }
      else
      {
        body.Append("    Assert.Contains(")
            .Append(Source.Quote(Ir.Str(Ir.Get(requestBody, "contentType"), string.Empty)))
            .Append(", sentType, StringComparison.Ordinal);\n");
      }
    }

    var hasOptionalQuery = Ir.Objects(Ir.Get(http, "params"))
        .Any(param => Ir.Str(Ir.Get(param, "location")) == "query" && !Ir.Flag(Ir.Get(param, "required")));
    if (hasOptionalQuery)
    {
      body.Append("\n    // An omitted optional query parameter must not reach the wire at all. A generator\n");
      body.Append("    // serializing null would send `?since=null`, which a server reads as a value.\n");
      body.Append("    var query = new Uri(transport.Seen.Url).Query;\n");
      body.Append("    Assert.DoesNotContain(\"=null\", query, StringComparison.Ordinal);\n");
    }

    body.Append("  }\n}\n");
    return new EmittedFile($"tests/{name}.cs", body.ToString());
  }

  /// <summary>
  /// The test project: a sibling of the library, referencing it.
  /// </summary>
  /// <remarks>
  /// Separate rather than folded into the library, because a single project would ship the tests and the
  /// xUnit reference inside the published package. `dotnet build` in the package root still finds only the
  /// library, which is what the existing gate runs.
  /// </remarks>
  private EmittedFile TestProjectFile(string packageId)
  {
    var contents = $"""
        <Project Sdk="Microsoft.NET.Sdk">

          <!--
            The generated per-operation tests. A separate project so neither the tests nor xUnit reach the
            published package.
          -->
          <PropertyGroup>
            <TargetFramework>net8.0</TargetFramework>
            <LangVersion>12</LangVersion>
            <Nullable>enable</Nullable>
            <ImplicitUsings>enable</ImplicitUsings>
            <IsPackable>false</IsPackable>
            <!--
              CS1591 is "missing XML comment". These are tests: the class name and the summary say what
              each one does, and a comment per assertion would be noise.
            -->
            <NoWarn>$(NoWarn);CS1591</NoWarn>
          </PropertyGroup>

          <ItemGroup>
            <PackageReference Include="xunit" Version="2.9.2" />
            <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
            <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
          </ItemGroup>

          <ItemGroup>
            <ProjectReference Include="../{packageId}.csproj" />
          </ItemGroup>

        </Project>

        """;
    return new EmittedFile($"tests/{packageId}.Tests.csproj", contents);
  }
}
