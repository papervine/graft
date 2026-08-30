using System.Text;

namespace Graft.Target.Dotnet;

/// <summary>Emitting one method on a resource class.</summary>
internal static class Methods
{
  private sealed record Param(string Name, string Type, bool Required, string WireName, string Location);

  public static string Render(
      Emitter emitter,
      IDictionary<string, object?> resource,
      IDictionary<string, object?> method,
      Source file)
  {
    var http = Ir.Obj(Ir.Get(method, "http"));
    // `http.verb`, not `http.method`. The PHP target read the latter — which the IR does not have — and
    // emitted every operation as a GET, silently. Checked against the schema, not remembered.
    var verb = Ir.Str(Ir.Get(http, "verb"), "get").ToUpperInvariant();
    var path = Ir.Str(Ir.Get(http, "path"), "/");
    var response = Ir.Obj(Ir.Get(method, "response"));
    var responseKind = Ir.Str(Ir.Get(response, "kind"), "empty");
    var pagination = Ir.StrOrNull(Ir.Get(method, "paginationId"));

    // Async methods are suffixed `Async`, which is .NET's own convention and is enforced by every analyser a
    // consumer is likely to run. A paginated method returns `Paginator<T>` and is *not* itself awaited, so it
    // keeps the plain name.
    var baseName = Naming.Pascal(Ir.Tokens(Ir.Get(method, "name")));
    var name = pagination is null ? baseName + "Async" : baseName;

    // Streaming is not implemented, and the handshake does not claim it. Skipping is the honest outcome: a
    // method that JSON-decoded an SSE stream cannot work and looks like it should.
    if (responseKind == "stream")
    {
      emitter.Warn(
          $"The .NET target does not support streaming responses, so `{OperationKey(resource, method)}` was not generated.");
      return string.Empty;
    }

    var parameters = new List<Param>();
    foreach (var param in Ir.Objects(Ir.Get(http, "params")))
    {
      var location = Ir.Str(Ir.Get(param, "location"));
      if (location is not ("path" or "query"))
      {
        continue;
      }

      var required = location == "path" || Ir.Flag(Ir.Get(param, "required"));
      var reference = Ir.Obj(Ir.Get(param, "type"));
      if (reference.Count == 0)
      {
        reference = new Dictionary<string, object?> { ["kind"] = "primitive", ["type"] = "string" };
      }

      parameters.Add(new Param(
          Naming.Camel(Ir.Tokens(Ir.Get(param, "name"))),
          emitter.Types.Render(reference, required),
          required,
          Ir.Str(Ir.Get(param, "wireName")),
          location));
    }

    var bodyRef = Ir.Obj(Ir.Get(method, "body"));
    string? bodyType = null;
    var bodyIsModel = false;
    if (bodyRef.Count > 0)
    {
      var reference = Ir.Obj(Ir.Get(bodyRef, "type"));
      bodyType = emitter.Types.Render(reference, true);
      bodyIsModel = Ir.Str(Ir.Get(reference, "kind")) == "named"
          && emitter.Types.IsObject(Ir.Str(Ir.Get(reference, "id")));
    }

    var returnType = ReturnType(emitter, response, pagination, file);

    // Required parameters first, then optional with defaults — C# requires optional parameters last, so this
    // is a language constraint rather than a style choice.
    parameters = parameters.OrderByDescending(param => param.Required).ToList();

    var signature = new List<string>();
    foreach (var param in parameters)
    {
      signature.Add(param.Required
          ? $"{param.Type} {param.Name}"
          : $"{param.Type} {param.Name} = default");
    }

    if (bodyType is not null)
    {
      // The body is required when the spec says so, and it goes before the optional trailing parameters.
      signature.Insert(
          parameters.Count(param => param.Required),
          Ir.Flag(Ir.Get(bodyRef, "required")) ? $"{bodyType} body" : $"{bodyType}? body = default");
    }

    signature.Add("RequestOptions? options = null");
    if (pagination is null)
    {
      // Every async method takes a token. Omitting it is the single most common complaint about
      // hand-written .NET SDKs, and adding it later is a breaking change to every signature.
      signature.Add("CancellationToken cancellationToken = default");
    }

    var docs = Ir.Obj(Ir.Get(method, "docs"));
    var doc = Source.Prose(Ir.StrOrNull(Ir.Get(docs, "summary")), Ir.StrOrNull(Ir.Get(docs, "description")));

    var body = new StringBuilder();
    if (doc.Count > 0)
    {
      body.Append(Source.Doc(doc, 4));
    }

    if (Ir.Flag(Ir.Get(method, "deprecated")))
    {
      var reason = Ir.Str(Ir.Get(docs, "deprecationReason"), "This operation is deprecated.");
      body.Append("    [Obsolete(").Append(Source.Quote(reason)).Append(")]\n");
    }

    var asyncKeyword = pagination is null ? "async " : string.Empty;
    body.Append("    public ").Append(asyncKeyword).Append(returnType).Append(' ').Append(name)
        .Append('(').Append(string.Join(", ", signature)).Append(")\n    {\n");
    body.Append(Body(emitter, resource, method, verb, path, parameters, bodyType, bodyIsModel, response, pagination, file));
    body.Append("    }\n");
    return body.ToString();
  }

  private static string ReturnType(
      Emitter emitter,
      IDictionary<string, object?> response,
      string? pagination,
      Source file)
  {
    if (pagination is not null)
    {
      var item = ItemType(emitter, response, pagination);
      return $"Paginator<{item ?? "object?"}>";
    }

    var kind = Ir.Str(Ir.Get(response, "kind"), "empty");
    if (kind == "empty")
    {
      return "Task";
    }

    if (kind is "binary" or "text")
    {
      return "Task<string>";
    }

    return $"Task<{emitter.Types.Render(Ir.Obj(Ir.Get(response, "type")), true)}>";
  }

  private static string? ItemType(Emitter emitter, IDictionary<string, object?> response, string paginationId)
  {
    var reference = ItemRef(emitter, response, paginationId);
    return reference is null ? null : emitter.Types.Render(reference, true);
  }

  private static IDictionary<string, object?>? ItemRef(
      Emitter emitter,
      IDictionary<string, object?> response,
      string paginationId)
  {
    if (Ir.Str(Ir.Get(response, "kind")) != "json")
    {
      return null;
    }

    var reference = Ir.Obj(Ir.Get(response, "type"));
    var items = ItemsSource(emitter, paginationId);
    if (Ir.Str(Ir.Get(items, "kind")) == "body")
    {
      var walked = WalkToField(emitter, reference, Ir.Strings(Ir.Get(items, "path")));
      if (walked is not null)
      {
        reference = walked;
      }
    }

    if (Ir.Str(Ir.Get(reference, "kind")) != "array")
    {
      return null;
    }

    var inner = Ir.Obj(Ir.Get(reference, "items"));
    return inner.Count == 0 ? null : inner;
  }

  private static IDictionary<string, object?> ItemsSource(Emitter emitter, string paginationId)
  {
    foreach (var scheme in Ir.Objects(Ir.Get(emitter.IrRoot, "pagination")))
    {
      if (Ir.Str(Ir.Get(scheme, "id")) == paginationId)
      {
        return Ir.Obj(Ir.Get(scheme, "itemsSource"));
      }
    }

    return new Dictionary<string, object?>();
  }

  /// <summary>Follow a dotted path through named object types to the field it names.</summary>
  /// <summary>Wire names on a body whose values are file content.</summary>
  /// <remarks>
  /// Read from the IR and passed to the runtime, because C# types a binary-format field as a string - the
  /// same constraint PHP and Java have, and the reason "which field is a file" cannot be decided inside the
  /// runtime the way it can in TypeScript, Python, and Go.
  /// </remarks>
  private static List<string> BinaryFieldNames(Emitter emitter, object? reference)
  {
    var declared = Ir.Obj(reference);
    if (Ir.Str(Ir.Get(declared, "kind"), string.Empty) != "named")
    {
      return new List<string>();
    }

    if (!emitter.Types.Types.TryGetValue(Ir.Str(Ir.Get(declared, "id"), string.Empty), out var named))
    {
      return new List<string>();
    }

    var found = new List<string>();
    foreach (var field in Ir.Objects(Ir.Get(named, "fields")))
    {
      var type = Ir.Obj(Ir.Get(field, "type"));
      // Unwrapped: an optional binary field is a nullable wrapper around the binary.
      while (Ir.Str(Ir.Get(type, "kind"), string.Empty) == "nullable")
      {
        type = Ir.Obj(Ir.Get(type, "inner"));
      }

      if (Ir.Str(Ir.Get(type, "kind"), string.Empty) == "binary")
      {
        found.Add(Ir.Str(Ir.Get(field, "wireName"), string.Empty));
      }
    }

    return found;
  }

  private static IDictionary<string, object?>? WalkToField(
      Emitter emitter,
      IDictionary<string, object?> reference,
      List<string> path)
  {
    var current = reference;
    foreach (var segment in path)
    {
      if (Ir.Str(Ir.Get(current, "kind")) != "named")
      {
        return null;
      }

      if (!emitter.Types.Types.TryGetValue(Ir.Str(Ir.Get(current, "id")), out var type)
          || Ir.Str(Ir.Get(type, "kind")) != "object")
      {
        return null;
      }

      IDictionary<string, object?>? found = null;
      foreach (var field in Ir.Objects(Ir.Get(type, "fields")))
      {
        if (Ir.Str(Ir.Get(field, "wireName")) == segment)
        {
          found = Ir.Obj(Ir.Get(field, "type"));
          break;
        }
      }

      if (found is null || found.Count == 0)
      {
        return null;
      }

      current = found;
    }

    return current;
  }

  private static string Body(
      Emitter emitter,
      IDictionary<string, object?> resource,
      IDictionary<string, object?> method,
      string verb,
      string path,
      List<Param> parameters,
      string? bodyType,
      bool bodyIsModel,
      IDictionary<string, object?> response,
      string? pagination,
      Source file)
  {
    var body = new StringBuilder();

    var pathExpression = Source.Quote(path);
    var pathParams = parameters.Where(param => param.Location == "path").ToList();
    if (pathParams.Count > 0)
    {
      var pairs = pathParams.Select(param =>
          $"[{Source.Quote(param.WireName)}] = {WireExpression(emitter, param)}");
      pathExpression =
          $"Query.Path({pathExpression}, new Dictionary<string, object?> {{ {string.Join(", ", pairs)} }})";
    }

    var queryParams = parameters.Where(param => param.Location == "query").ToList();
    var queryExpression = "new Dictionary<string, object?>()";
    if (queryParams.Count > 0)
    {
      body.Append("        var query = new Dictionary<string, object?>\n        {\n");
      foreach (var param in queryParams)
      {
        body.Append("            [").Append(Source.Quote(param.WireName)).Append("] = ")
                    .Append(WireExpression(emitter, param)).Append(",\n");
      }

      body.Append("        };\n\n");
      queryExpression = "query";
    }

    // The encoding the spec declared, not a default. `application/x-www-form-urlencoded` sent as JSON is a
    // request the server rejects, and it was every write operation of every form-based API before this
    // existed. `Form.Encode` takes the same JSON tree `Json.Write` would, so field naming has one
    // implementation rather than two.
    var formEncoded = Ir.Str(Ir.Get(Ir.Obj(Ir.Get(method, "body")), "contentType"), string.Empty)
        .Contains("x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase);
    var multipart = Ir.Str(Ir.Get(Ir.Obj(Ir.Get(method, "body")), "contentType"), string.Empty)
        .StartsWith("multipart/", StringComparison.OrdinalIgnoreCase);
    var writer = formEncoded ? "Form.Encode" : "Json.Write";
    var requestContentType = formEncoded ? "application/x-www-form-urlencoded" : "application/json";

    // A generated model knows its own JSON tree; anything else is already a tree and is written directly.
    var bodyTree = bodyIsModel ? "body.ToJson()" : "body";
    var bodyExpression = bodyType is null ? "null" : $"{writer}({bodyTree})";
    if (bodyType is not null && !Ir.Flag(Ir.Get(Ir.Obj(Ir.Get(method, "body")), "required")))
    {
      // An optional body: null means send nothing, not send "null".
      bodyExpression = $"body is null ? null : {writer}({bodyTree})";
    }

    if (pagination is not null)
    {
      return body + Paginated(emitter, resource, method, verb, pathExpression, queryExpression, response, pagination, file);
    }

    var kind = Ir.Str(Ir.Get(response, "kind"), "empty");
    var operation = OperationKey(resource, method);

    if (kind == "empty")
    {
      body.Append("        await _client.RequestAsync(").Append(Source.Quote(verb)).Append(", ")
          .Append(pathExpression).Append(", ").Append(queryExpression).Append(", ").Append(bodyExpression)
          .Append(", options, ").Append(Source.Quote(requestContentType))
          .Append(", cancellationToken).ConfigureAwait(false);\n");
      return body.ToString();
    }

    if (kind is "binary" or "text")
    {
      body.Append("        var response = await _client.RequestAsync(").Append(Source.Quote(verb)).Append(", ")
          .Append(pathExpression).Append(", ").Append(queryExpression).Append(", ").Append(bodyExpression)
          .Append(", options, ").Append(Source.Quote(requestContentType))
          .Append(", cancellationToken).ConfigureAwait(false);\n");
      body.Append("        return response.Body;\n");
      return body.ToString();
    }

    if (multipart && bodyType is not null)
    {
      // Encoded to a local, because the content type carries the boundary the encoder generated —
      // inventing one separately from the body it delimits is the one multipart mistake that cannot be
      // recovered from. The body then travels as bytes, since file content is not text.
      var fileFields = string.Join(
          ", ",
          BinaryFieldNames(emitter, Ir.Get(Ir.Obj(Ir.Get(method, "body")), "type")).Select(Source.Quote));
      body.Append("        var encoded = Multipart.Encode(").Append(bodyTree)
          .Append(", new[] { ").Append(fileFields).Append(" });\n");
      body.Append("        var data = await _client.RequestJsonAsync(").Append(Source.Quote(verb))
          .Append(", ").Append(pathExpression).Append(", ").Append(queryExpression)
          .Append(", encoded.Body, options, encoded.ContentType, cancellationToken).ConfigureAwait(false);\n");
    }
    else
    {
      body.Append("        var data = await _client.RequestJsonAsync(").Append(Source.Quote(verb)).Append(", ")
          .Append(pathExpression).Append(", ").Append(queryExpression).Append(", ").Append(bodyExpression)
          .Append(", options, cancellationToken")
          .Append(formEncoded ? ", " + Source.Quote(requestContentType) : string.Empty)
          .Append(").ConfigureAwait(false);\n");
    }

    var reference = Ir.Obj(Ir.Get(response, "type"));
    var descriptor = emitter.SchemaPlan.Describe(reference);
    if (descriptor != "{\"k\":\"any\"}")
    {
      // Validated *before* decoding, so a mismatch is reported with the field path the spec declared rather
      // than as a decode failure with less context.
      body.Append("        Validate.Enforce(\n            data, Schema.Of(").Append(Source.Quote(descriptor))
          .Append("), Schemas.Table, ").Append(Source.Quote(operation))
          .Append(", _client.ValidationMode);\n");
    }

    body.Append("        return ").Append(Decode(emitter, reference, "data")).Append(";\n");
    return body.ToString();
  }

  private static string Decode(Emitter emitter, IDictionary<string, object?> reference, string value)
  {
    var kind = Ir.Str(Ir.Get(reference, "kind"), "unknown");
    if (kind == "named")
    {
      var id = Ir.Str(Ir.Get(reference, "id"));
      if (emitter.Types.IsObject(id))
      {
        return $"{emitter.Types.NameOf(id)}.FromJson({value})";
      }

      if (emitter.Types.IsEnum(id))
      {
        var name = emitter.Types.NameOf(id);
        // `FromWire` rather than `Enum.Parse`: a member the server added after generation must not crash
        // the client. The `??` gives the declared non-nullable return something to be.
        return $"{name}Extensions.FromWire({value} as string) ?? default";
      }
    }

    if (kind == "array")
    {
      var items = Ir.Obj(Ir.Get(reference, "items"));
      if (Ir.Str(Ir.Get(items, "kind")) == "named" && emitter.Types.IsObject(Ir.Str(Ir.Get(items, "id"))))
      {
        return $"Support.List({value}, {emitter.Types.NameOf(Ir.Str(Ir.Get(items, "id")))}.FromJson)";
      }

      return $"Support.List({value}, item => item)";
    }

    // A scalar, a map, or something structural: the validator has already checked the shape, so a cast here
    // would only hide a mismatch it reported.
    var rendered = emitter.Types.Render(reference, true);
    return rendered == "object" ? value : $"({rendered}){value}!";
  }

  private static string Paginated(
      Emitter emitter,
      IDictionary<string, object?> resource,
      IDictionary<string, object?> method,
      string verb,
      string pathExpression,
      string queryExpression,
      IDictionary<string, object?> response,
      string paginationId,
      Source file)
  {
    var scheme = SchemeById(emitter, paginationId);
    var style = Ir.Str(Ir.Get(scheme, "style"), "offset") switch
    {
      "cursor" => "Cursor",
      "page" => "Page",
      _ => "Offset",
    };

    var body = new StringBuilder();
    body.Append("        var scheme = new PaginationScheme\n        {\n");
    body.Append("            Style = PaginationStyle.").Append(style).Append(",\n");
    foreach (var (key, property) in new[]
    {
            ("limitParam", "LimitParam"),
            ("offsetParam", "OffsetParam"),
            ("pageParam", "PageParam"),
            ("cursorParam", "CursorParam"),
        })
    {
      var value = Ir.StrOrNull(Ir.Get(scheme, key));
      if (value is not null)
      {
        body.Append("            ").Append(property).Append(" = ").Append(Source.Quote(value)).Append(",\n");
      }
    }

    var items = Ir.Obj(Ir.Get(scheme, "itemsSource"));
    if (Ir.Str(Ir.Get(items, "kind")) == "body")
    {
      body.Append("            ItemsPath = new[] { ").Append(QuotedPath(Ir.Strings(Ir.Get(items, "path"))))
          .Append(" },\n");
    }

    var cursor = Ir.Obj(Ir.Get(scheme, "cursorSource"));
    if (Ir.Str(Ir.Get(cursor, "kind")) == "body")
    {
      body.Append("            CursorPath = new[] { ").Append(QuotedPath(Ir.Strings(Ir.Get(cursor, "path"))))
          .Append(" },\n");
    }

    var total = Ir.Obj(Ir.Get(scheme, "totalSource"));
    if (Ir.Str(Ir.Get(total, "kind")) == "header")
    {
      body.Append("            TotalHeader = ").Append(Source.Quote(Ir.Str(Ir.Get(total, "name"))))
          .Append(",\n");
    }

    body.Append("        };\n\n");

    var itemRef = ItemRef(emitter, response, paginationId);
    var itemDescriptor = itemRef is null ? "{\"k\":\"any\"}" : emitter.SchemaPlan.Describe(itemRef);
    var itemClass = itemRef is not null
        && Ir.Str(Ir.Get(itemRef, "kind")) == "named"
        && emitter.Types.IsObject(Ir.Str(Ir.Get(itemRef, "id")))
        ? emitter.Types.NameOf(Ir.Str(Ir.Get(itemRef, "id")))
        : null;
    var itemType = ItemType(emitter, response, paginationId) ?? "object?";

    body.Append("        return new Paginator<").Append(itemType).Append(">(\n");
    body.Append("            scheme,\n");
    body.Append("            (parameters, token) => _client.RequestPageAsync(").Append(Source.Quote(verb))
        .Append(", ").Append(pathExpression).Append(", Support.Merged(").Append(queryExpression)
        .Append(", parameters), options, token),\n");
    body.Append("            ").Append(queryExpression).Append(",\n");

    // Items, not the envelope. Validation placed only on the single-response path silently skips every list
    // operation — found in TypeScript, Go, and PHP in turn — but validating the *envelope* is wrong too: a spec
    // may declare fields required on the envelope that a real page omits. The caller receives items.
    if (itemDescriptor != "{\"k\":\"any\"}")
    {
      body.Append("            items =>\n            {\n");
      body.Append("                Validate.Enforce(\n                    items, Schema.Of(")
          .Append(Source.Quote("{\"k\":\"arr\",\"i\":" + itemDescriptor + "}"))
          .Append("), Schemas.Table,\n                    ")
          .Append(Source.Quote(OperationKey(resource, method)))
          .Append(", _client.ValidationMode);\n");
      body.Append("                return Support.List(items, ")
          .Append(itemClass is null ? "item => item" : itemClass + ".FromJson").Append(");\n");
      body.Append("            });\n");
    }
    else
    {
      body.Append("            items => Support.List(items, ")
          .Append(itemClass is null ? "item => item" : itemClass + ".FromJson").Append("));\n");
    }

    return body.ToString();
  }

  private static IDictionary<string, object?> SchemeById(Emitter emitter, string paginationId)
  {
    foreach (var scheme in Ir.Objects(Ir.Get(emitter.IrRoot, "pagination")))
    {
      if (Ir.Str(Ir.Get(scheme, "id")) == paginationId)
      {
        return scheme;
      }
    }

    return new Dictionary<string, object?>();
  }

  private static string QuotedPath(List<string> path) => string.Join(", ", path.Select(Source.Quote));

  public static string OperationKey(
      IDictionary<string, object?> resource,
      IDictionary<string, object?> method) =>
      string.Join('.', Ir.Tokens(Ir.Get(resource, "name")))
      + "."
      + Naming.Camel(Ir.Tokens(Ir.Get(method, "name")));

  /// <summary>
  /// A parameter as the value that should reach the wire.
  /// </summary>
  /// <remarks>
  /// <para>
  /// An enum needs <c>.WireValue()</c> here, and this is the one place C# forces the emitter to know something the
  /// runtime cannot. Every other target's runtime detects an enum at the boundary — TypeScript by its literal type,
  /// Go and Java through an interface the enum implements. <b>A C# enum cannot implement an interface</b>, so
  /// <c>IWireValued</c> never matches and the value falls through to <c>ToString()</c>: <c>kind=Member</c> instead
  /// of <c>kind=member</c>.
  /// </para>
  /// <para>
  /// Found by the cross-language conformance suite, which is the third time an enum's wire value has been the bug —
  /// and it recurs specifically in the languages where an enum is not simply a string.
  /// </para>
  /// </remarks>
  private static string WireExpression(Emitter emitter, Param param)
  {
    var bare = param.Type.TrimEnd('?');
    var isEnum = emitter.Types.Types.Keys.Any(
        id => emitter.Types.NameOf(id) == bare && emitter.Types.IsEnum(id));
    if (!isEnum)
    {
      return param.Name;
    }

    // `?.` for an optional one, so an omitted parameter stays null and `Query.Flatten` drops it.
    return param.Type.EndsWith('?') ? $"{param.Name}?.WireValue()" : $"{param.Name}.WireValue()";
  }
}
