package graft.target.java;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Emitting one method on a resource class. */
final class Methods {

  private Methods() {}

  /** A parameter in a generated signature. */
  private record Param(
      String name, String type, boolean required, String wireName, String location) {}

  static String render(
      Emitter emitter, Map<String, Object> resource, Map<String, Object> method, Source file) {
    Map<String, Object> http = Ir.obj(method.get("http"));
    // `http.verb`, not `http.method`. The PHP target read the latter — which the IR does not have —
    // and
    // emitted every operation as a GET, silently. Checked against the schema, not remembered.
    String verb = Ir.str(http.get("verb"), "get").toUpperCase(java.util.Locale.ROOT);
    String path = Ir.str(http.get("path"), "/");
    Map<String, Object> response = Ir.obj(method.get("response"));
    String responseKind = Ir.str(response.get("kind"), "empty");
    String name = Naming.member(Ir.tokens(method.get("name")));

    // Streaming is not implemented, and the handshake does not claim it. Skipping is the honest
    // outcome: a
    // method that JSON-decoded an SSE stream cannot work and looks like it should.
    if ("stream".equals(responseKind)) {
      emitter.warn(
          "The Java target does not support streaming responses, so `"
              + operationKey(resource, method)
              + "` was not generated.");
      return "";
    }

    List<Param> params = new ArrayList<>();
    for (Map<String, Object> param : Ir.objects(http.get("params"))) {
      String location = Ir.str(param.get("location"), "");
      if (!location.equals("path") && !location.equals("query")) {
        continue;
      }
      boolean required = "path".equals(location) || Ir.flag(param.get("required"));
      Map<String, Object> ref = Ir.obj(param.get("type"));
      params.add(
          new Param(
              Naming.member(Ir.tokens(param.get("name"))),
              emitter
                  .types()
                  .render(
                      ref.isEmpty() ? Map.of("kind", "primitive", "type", "string") : ref,
                      required),
              required,
              Ir.str(param.get("wireName"), ""),
              location));
    }

    for (Param param : params) {
      // Registered here, not only for the return type. A method taking an `Instant` query parameter
      // compiled
      // nowhere until this existed, and the error named the resource rather than the parameter.
      file.addImports(TypeMapper.importsFor(param.type()));
    }

    Map<String, Object> body = Ir.obj(method.get("body"));
    String bodyType = null;
    boolean bodyIsModel = false;
    if (!body.isEmpty()) {
      Map<String, Object> bodyRef = Ir.obj(body.get("type"));
      bodyType = emitter.types().render(bodyRef, true);
      file.addImports(TypeMapper.importsFor(bodyType));
      bodyIsModel =
          "named".equals(Ir.str(bodyRef.get("kind"), ""))
              && emitter.types().isObject(Ir.str(bodyRef.get("id"), ""));
    }

    String pagination = Ir.str(method.get("paginationId"), null);
    String returnType = returnType(emitter, response, pagination, file);

    // Required parameters first, then optional, then the body, then options. Java has no named
    // arguments, so
    // the order *is* the API — and putting required values first is what a reader expects.
    params.sort((a, b) -> Boolean.compare(b.required(), a.required()));

    List<String> signature = new ArrayList<>();
    for (Param param : params) {
      signature.add(param.type() + " " + param.name());
    }
    if (bodyType != null) {
      signature.add(bodyType + " body");
    }
    signature.add("RequestOptions options");

    Map<String, Object> docs = Ir.obj(method.get("docs"));
    List<String> doc =
        Source.prose(Ir.str(docs.get("summary"), null), Ir.str(docs.get("description"), null));
    if (Ir.flag(method.get("deprecated"))) {
      doc.add("");
      doc.add(
          "@deprecated " + Ir.str(docs.get("deprecationReason"), "This operation is deprecated."));
    }

    StringBuilder out = new StringBuilder(Source.javadoc(doc, 2));
    if (Ir.flag(method.get("deprecated"))) {
      out.append("  @Deprecated\n");
    }
    out.append("  public ")
        .append(returnType)
        .append(' ')
        .append(name)
        .append('(')
        .append(String.join(", ", signature))
        .append(") {\n");
    out.append(
        body(
            emitter,
            resource,
            method,
            verb,
            path,
            params,
            bodyType,
            bodyIsModel,
            response,
            pagination,
            file));
    out.append("  }\n");

    // A convenience overload without `options`, because passing `null` at every call site is what a
    // Java
    // developer would otherwise have to do — and the JDK's own APIs pair a full method with a short
    // one.
    List<String> shortSignature = new ArrayList<>(signature.subList(0, signature.size() - 1));
    List<String> forwarded = new ArrayList<>();
    for (Param param : params) {
      forwarded.add(param.name());
    }
    if (bodyType != null) {
      forwarded.add("body");
    }
    forwarded.add("null");
    out.append("\n  /** As {@link #").append(name).append("} with default options. */\n");
    out.append("  public ")
        .append(returnType)
        .append(' ')
        .append(name)
        .append('(')
        .append(String.join(", ", shortSignature))
        .append(") {\n");
    out.append("    return ")
        .append(returnType.equals("void") ? "" : "")
        .append(name)
        .append('(')
        .append(String.join(", ", forwarded))
        .append(");\n  }\n");
    if (returnType.equals("void")) {
      // `return void(...)` does not compile, so the void overload calls and returns nothing.
      String fixed = out.toString().replace("    return " + name + "(", "    " + name + "(");
      return fixed;
    }
    return out.toString();
  }

  private static String returnType(
      Emitter emitter, Map<String, Object> response, String pagination, Source file) {
    if (pagination != null) {
      file.addImport(emitter.packageName() + ".core.Paginator");
      String item = itemType(emitter, response, pagination);
      return "Paginator<" + (item == null ? "Object" : item) + ">";
    }
    String kind = Ir.str(response.get("kind"), "empty");
    if (kind.equals("empty")) {
      return "void";
    }
    if (kind.equals("binary") || kind.equals("text")) {
      return "String";
    }
    String rendered = emitter.types().render(Ir.obj(response.get("type")), true);
    file.addImports(TypeMapper.importsFor(rendered));
    return rendered;
  }

  /** The element type of a paginated response, from the response shape rather than the scheme. */
  private static String itemType(
      Emitter emitter, Map<String, Object> response, String paginationId) {
    Map<String, Object> ref = itemRef(emitter, response, paginationId);
    return ref == null ? null : Models.boxed(emitter.types().render(ref, false));
  }

  private static Map<String, Object> itemRef(
      Emitter emitter, Map<String, Object> response, String paginationId) {
    if (!"json".equals(Ir.str(response.get("kind"), ""))) {
      return null;
    }
    Map<String, Object> ref = Ir.obj(response.get("type"));
    Map<String, Object> items = itemsSource(emitter, paginationId);
    if ("body".equals(Ir.str(items.get("kind"), ""))) {
      Map<String, Object> walked = walkToField(emitter, ref, Ir.strings(items.get("path")));
      if (walked != null) {
        ref = walked;
      }
    }
    if (!"array".equals(Ir.str(ref.get("kind"), ""))) {
      return null;
    }
    Map<String, Object> inner = Ir.obj(ref.get("items"));
    return inner.isEmpty() ? null : inner;
  }

  private static Map<String, Object> itemsSource(Emitter emitter, String paginationId) {
    for (Map<String, Object> scheme : Ir.objects(emitter.irRoot().get("pagination"))) {
      if (paginationId.equals(Ir.str(scheme.get("id"), ""))) {
        return Ir.obj(scheme.get("itemsSource"));
      }
    }
    return Map.of();
  }

  /** Follow a dotted path through named object types to the field it names. */
  /**
   * Wire names on a body whose values are file content.
   *
   * <p>Read from the IR and passed to the runtime, because Java's type for a {@code format: binary}
   * field is {@code String} — the same constraint PHP has, and the reason "which field is a file"
   * cannot be decided inside the runtime the way it can in TypeScript, Python, and Go.
   */
  private static List<String> binaryFieldNames(Emitter emitter, Object ref) {
    Map<String, Object> reference = Ir.obj(ref);
    if (!"named".equals(Ir.str(reference.get("kind"), ""))) {
      return List.of();
    }
    Map<String, Object> named = emitter.types().types().get(Ir.str(reference.get("id"), ""));
    if (named == null) {
      return List.of();
    }
    List<String> out = new ArrayList<>();
    for (Map<String, Object> field : Ir.objects(named.get("fields"))) {
      Map<String, Object> type = Ir.obj(field.get("type"));
      // Unwrapped: an optional binary field is a nullable wrapper around the binary.
      while ("nullable".equals(Ir.str(type.get("kind"), ""))) {
        type = Ir.obj(type.get("inner"));
      }
      if ("binary".equals(Ir.str(type.get("kind"), ""))) {
        out.add(Ir.str(field.get("wireName"), ""));
      }
    }
    return out;
  }

  private static Map<String, Object> walkToField(
      Emitter emitter, Map<String, Object> ref, List<String> path) {
    Map<String, Object> current = ref;
    for (String segment : path) {
      if (!"named".equals(Ir.str(current.get("kind"), ""))) {
        return null;
      }
      Map<String, Object> type = emitter.types().types().get(Ir.str(current.get("id"), ""));
      if (type == null || !"object".equals(Ir.str(type.get("kind"), ""))) {
        return null;
      }
      Map<String, Object> found = null;
      for (Map<String, Object> field : Ir.objects(type.get("fields"))) {
        if (segment.equals(Ir.str(field.get("wireName"), ""))) {
          found = Ir.obj(field.get("type"));
          break;
        }
      }
      if (found == null || found.isEmpty()) {
        return null;
      }
      current = found;
    }
    return current;
  }

  private static String body(
      Emitter emitter,
      Map<String, Object> resource,
      Map<String, Object> method,
      String verb,
      String path,
      List<Param> params,
      String bodyType,
      boolean bodyIsModel,
      Map<String, Object> response,
      String pagination,
      Source file) {
    StringBuilder out = new StringBuilder();
    file.addImport("java.util.Map");

    String pathExpression = Source.quote(path);
    List<Param> pathParams = params.stream().filter(p -> p.location().equals("path")).toList();
    if (!pathParams.isEmpty()) {
      file.addImport(emitter.packageName() + ".core.Query");
      List<String> pairs = new ArrayList<>();
      for (Param param : pathParams) {
        pairs.add(Source.quote(param.wireName()) + ", " + param.name());
      }
      pathExpression =
          "Query.path(" + pathExpression + ", Map.of(" + String.join(", ", pairs) + "))";
    }

    List<Param> queryParams = params.stream().filter(p -> p.location().equals("query")).toList();
    String queryExpression = "Map.of()";
    if (!queryParams.isEmpty()) {
      // A LinkedHashMap rather than `Map.of`, because `Map.of` rejects null values and an omitted
      // optional
      // parameter is exactly a null. `Query.flatten` drops them.
      file.addImport("java.util.LinkedHashMap");
      out.append("    var query = new LinkedHashMap<String, Object>();\n");
      for (Param param : queryParams) {
        out.append("    query.put(")
            .append(Source.quote(param.wireName()))
            .append(", ")
            .append(param.name())
            .append(");\n");
      }
      queryExpression = "query";
    }

    // A generated model knows its own JSON tree; anything else — a free-form object, a map, a union
    // the IR
    // could not name — is already a tree and is written directly. Calling `toJson()` on `Object`
    // does not
    // compile, which is how this was found.
    // The encoding the spec declared, not a default. `application/x-www-form-urlencoded` sent as
    // JSON is
    // a request the server rejects, and it was every write operation of every form-based API before
    // this
    // branch existed. `Form.encode` takes the same JSON tree `Json.write` would, so field naming
    // has one
    // implementation rather than two.
    String declaredType =
        Ir.str(Ir.obj(method.get("body")).get("contentType"), "")
            .toLowerCase(java.util.Locale.ROOT);
    boolean formEncoded = declaredType.contains("x-www-form-urlencoded");
    boolean multipart = declaredType.startsWith("multipart/");
    String bodyTree = bodyIsModel ? "body.toJson()" : "body";
    String bodyExpression =
        bodyType == null
            ? "null"
            : formEncoded ? "Form.encode(" + bodyTree + ")" : "Json.write(" + bodyTree + ")";
    if (bodyType != null) {
      file.addImport(emitter.packageName() + ".core." + (formEncoded ? "Form" : "Json"));
    }
    // The runtime takes the content type as a trailing argument, so only a non-default needs
    // passing.
    String contentTypeArg = formEncoded ? ", \"application/x-www-form-urlencoded\"" : "";

    // Multipart is encoded to a local, because the *content type carries the boundary* the encoder
    // generated — inventing one separately from the body it delimits is the one multipart mistake
    // that cannot be recovered from. The body then travels as bytes, since file content is not
    // text.
    StringBuilder prelude = new StringBuilder();
    if (bodyType != null && multipart) {
      file.addImport(emitter.packageName() + ".core.Multipart");
      file.addImport("java.util.List");
      StringBuilder names = new StringBuilder();
      for (String field : binaryFieldNames(emitter, Ir.obj(method.get("body")).get("type"))) {
        if (names.length() > 0) {
          names.append(", ");
        }
        names.append(Source.quote(field));
      }
      prelude
          .append("    Multipart.Encoded encoded =\n        Multipart.encode(")
          .append(bodyTree)
          .append(", List.of(")
          .append(names)
          .append("));\n");
      bodyExpression = "encoded.body()";
      contentTypeArg = ", encoded.contentType()";
    }

    if (pagination != null) {
      return out
          + paginated(
              emitter,
              resource,
              method,
              verb,
              pathExpression,
              queryExpression,
              response,
              pagination,
              file);
    }

    String kind = Ir.str(response.get("kind"), "empty");
    String operation = operationKey(resource, method);

    if (kind.equals("empty")) {
      out.append("    client.request(")
          .append(Source.quote(verb))
          .append(", ")
          .append(pathExpression)
          .append(", ")
          .append(queryExpression)
          .append(", ")
          .append(bodyExpression)
          .append(", options, ")
          .append(formEncoded ? "\"application/x-www-form-urlencoded\"" : "\"application/json\"")
          .append(");\n");
      return out.toString();
    }

    if (kind.equals("binary") || kind.equals("text")) {
      out.append("    return client\n        .request(")
          .append(Source.quote(verb))
          .append(", ")
          .append(pathExpression)
          .append(", ")
          .append(queryExpression)
          .append(", ")
          .append(bodyExpression)
          .append(", options, ")
          .append(formEncoded ? "\"application/x-www-form-urlencoded\"" : "\"application/json\"")
          .append(")\n        .body();\n");
      return out.toString();
    }

    out.append(prelude);
    out.append("    Object data =\n        client.requestJson(")
        .append(Source.quote(verb))
        .append(", ")
        .append(pathExpression)
        .append(", ")
        .append(queryExpression)
        .append(", ")
        .append(bodyExpression)
        .append(", options")
        .append(contentTypeArg)
        .append(");\n");

    Map<String, Object> ref = Ir.obj(response.get("type"));
    String descriptor = emitter.schemas().describe(ref);
    if (!descriptor.equals("{\"k\":\"any\"}")) {
      file.addImport(emitter.packageName() + ".core.Schema");
      file.addImport(emitter.packageName() + ".core.Validate");
      // Validated *before* decoding, so a mismatch is reported with the field path the spec
      // declared rather
      // than as a decode failure with less context.
      out.append("    Validate.enforce(\n        data, Schema.of(")
          .append(Source.quote(descriptor))
          .append("), Schemas.TABLE, ")
          .append(Source.quote(operation))
          .append(", client.validationMode());\n");
    }
    out.append("    return ").append(decode(emitter, ref, "data", file)).append(";\n");
    return out.toString();
  }

  /** Turn a decoded JSON tree into the declared type. */
  private static String decode(
      Emitter emitter, Map<String, Object> ref, String value, Source file) {
    String kind = Ir.str(ref.get("kind"), "unknown");
    if (kind.equals("named")) {
      String id = Ir.str(ref.get("id"), "");
      if (emitter.types().isObject(id)) {
        return emitter.types().nameOf(id) + ".fromJson(" + value + ")";
      }
      if (emitter.types().isEnum(id)) {
        // `fromWire` rather than a throwing lookup: a member the server added after generation must
        // not crash
        // the client.
        return emitter.types().nameOf(id)
            + ".fromWire("
            + value
            + " instanceof String s ? s : null)";
      }
    }
    if (kind.equals("array")) {
      Map<String, Object> items = Ir.obj(ref.get("items"));
      file.addImport(emitter.packageName() + ".core.Support");
      if ("named".equals(Ir.str(items.get("kind"), ""))
          && emitter.types().isObject(Ir.str(items.get("id"), ""))) {
        return "Support.list("
            + value
            + ", "
            + emitter.types().nameOf(Ir.str(items.get("id"), ""))
            + "::fromJson)";
      }
      return "Support.list(" + value + ", item -> item)";
    }
    // A scalar, a map, or something structural: returned as decoded. The validator has already
    // checked the
    // shape, so a cast here would only hide a mismatch it reported.
    String rendered = emitter.types().render(ref, true);
    return rendered.equals("Object") ? value : "(" + rendered + ") " + value;
  }

  private static String paginated(
      Emitter emitter,
      Map<String, Object> resource,
      Map<String, Object> method,
      String verb,
      String pathExpression,
      String queryExpression,
      Map<String, Object> response,
      String paginationId,
      Source file) {
    file.addImport(emitter.packageName() + ".core.PaginationScheme");
    file.addImport(emitter.packageName() + ".core.Paginator");
    file.addImport(emitter.packageName() + ".core.Support");

    Map<String, Object> scheme = schemeById(emitter, paginationId);
    String style = Ir.str(scheme.get("style"), "offset").toUpperCase(java.util.Locale.ROOT);

    StringBuilder out = new StringBuilder();
    out.append("    var scheme =\n        PaginationScheme.builder(PaginationScheme.Style.")
        .append(style)
        .append(")\n");
    for (String key : List.of("limitParam", "offsetParam", "pageParam", "cursorParam")) {
      String value = Ir.str(scheme.get(key), null);
      if (value != null) {
        out.append("            .")
            .append(key)
            .append('(')
            .append(Source.quote(value))
            .append(")\n");
      }
    }
    Map<String, Object> items = Ir.obj(scheme.get("itemsSource"));
    if ("body".equals(Ir.str(items.get("kind"), ""))) {
      out.append("            .itemsPath(")
          .append(quotedPath(Ir.strings(items.get("path"))))
          .append(")\n");
    }
    Map<String, Object> cursor = Ir.obj(scheme.get("cursorSource"));
    if ("body".equals(Ir.str(cursor.get("kind"), ""))) {
      out.append("            .cursorPath(")
          .append(quotedPath(Ir.strings(cursor.get("path"))))
          .append(")\n");
    }
    Map<String, Object> total = Ir.obj(scheme.get("totalSource"));
    if ("header".equals(Ir.str(total.get("kind"), ""))) {
      out.append("            .totalHeader(")
          .append(Source.quote(Ir.str(total.get("name"), "")))
          .append(")\n");
    }
    out.append("            .build();\n\n");

    Map<String, Object> itemRef = itemRef(emitter, response, paginationId);
    String itemDescriptor =
        itemRef == null ? "{\"k\":\"any\"}" : emitter.schemas().describe(itemRef);
    String itemClass =
        itemRef != null
                && "named".equals(Ir.str(itemRef.get("kind"), ""))
                && emitter.types().isObject(Ir.str(itemRef.get("id"), ""))
            ? emitter.types().nameOf(Ir.str(itemRef.get("id"), ""))
            : null;
    String itemType = itemType(emitter, response, paginationId);

    out.append("    return new Paginator<>(\n        scheme,\n");
    out.append("        params -> client.requestPage(")
        .append(Source.quote(verb))
        .append(", ")
        .append(pathExpression)
        .append(", Support.merged(")
        .append(queryExpression)
        .append(", params), options),\n");
    // Passed directly, not through `Map.copyOf`: the query may hold nulls for omitted optional
    // parameters,
    // and `Map.copyOf` rejects null values.
    out.append("        ").append(queryExpression).append(",\n");

    // Items, not the envelope. Validation placed only on the single-response path silently skips
    // every list
    // operation — found in TypeScript, Go, and PHP in turn — but validating the *envelope* is wrong
    // too:
    // this spec declares fields required on the envelope that a real page omits. The caller
    // receives items.
    if (!itemDescriptor.equals("{\"k\":\"any\"}")) {
      file.addImport(emitter.packageName() + ".core.Schema");
      file.addImport(emitter.packageName() + ".core.Validate");
      out.append("        items -> {\n");
      out.append("          Validate.enforce(\n              items, Schema.of(")
          .append(Source.quote("{\"k\":\"arr\",\"i\":" + itemDescriptor + "}"))
          .append("), Schemas.TABLE,\n              ")
          .append(Source.quote(operationKey(resource, method)))
          .append(", client.validationMode());\n");
      out.append("          return Support.list(items, ")
          .append(itemClass == null ? "item -> item" : itemClass + "::fromJson")
          .append(");\n");
      out.append("        });\n");
    } else {
      out.append("        items -> Support.list(items, ")
          .append(itemClass == null ? "item -> item" : itemClass + "::fromJson")
          .append("));\n");
    }
    // Suppress nothing: `Paginator<ItemType>` is inferred from the decoder's return type, which is
    // why the
    // decoder is typed rather than raw.
    if (itemType == null) {
      out.append("");
    }
    return out.toString();
  }

  private static Map<String, Object> schemeById(Emitter emitter, String paginationId) {
    for (Map<String, Object> scheme : Ir.objects(emitter.irRoot().get("pagination"))) {
      if (paginationId.equals(Ir.str(scheme.get("id"), ""))) {
        return scheme;
      }
    }
    return Map.of();
  }

  private static String quotedPath(List<String> path) {
    List<String> quoted = new ArrayList<>();
    for (String segment : path) {
      quoted.add(Source.quote(segment));
    }
    return String.join(", ", quoted);
  }

  static String operationKey(Map<String, Object> resource, Map<String, Object> method) {
    return String.join(".", Ir.tokens(resource.get("name")))
        + "."
        + Naming.member(Ir.tokens(method.get("name")));
  }
}
