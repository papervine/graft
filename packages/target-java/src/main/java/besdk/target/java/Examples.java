package besdk.target.java;

import besdk.runtime.Json;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Per-operation examples and tests (SPEC.md §3.11).
 *
 * <p>The <em>values</em> come from {@code Method.example} in the IR, so every language shows the
 * same data for the same operation. Only the rendering is here, which is the whole division that
 * section sets up: a target deciding what a plausible value is would be the sixth copy of one
 * judgment.
 */
final class Examples {

  private final Emitter emitter;
  private final String packageName;

  Examples(Emitter emitter, String packageName) {
    this.emitter = emitter;
    this.packageName = packageName;
  }

  /** A resource paired with the accessor path that reaches it, e.g. {@code orgs().invoices()}. */
  private record Accessor(String path, Map<String, Object> resource) {}

  /**
   * Every resource with the path a caller uses to reach it.
   *
   * <p>The flat resource list has no paths, which is fine for emitting a class and useless for
   * writing a call: a nested resource reached as {@code client.invoices()} does not exist. Java
   * reaches every resource by an accessor <em>method</em>, top-level and nested alike.
   */
  private List<Accessor> accessors() {
    List<Accessor> out = new ArrayList<>();
    walk(Ir.objects(emitter.irRoot().get("resources")), "", out);
    return out;
  }

  private void walk(List<Map<String, Object>> resources, String prefix, List<Accessor> out) {
    for (Map<String, Object> resource : resources) {
      String accessor = Naming.member(Ir.tokens(resource.get("name"))) + "()";
      String path = prefix.isEmpty() ? accessor : prefix + "." + accessor;
      out.add(new Accessor(path, resource));
      walk(Ir.objects(resource.get("subresources")), path, out);
    }
  }

  /**
   * Render an example value as Java source, guided by the type it must satisfy.
   *
   * <p>Type-directed because Java needs it: a record is a positional constructor whose components
   * must all be present in declaration order, a write model is a builder, and an enum is a
   * constant. None of those can be produced from the JSON value alone.
   */
  private String literal(Map<String, Object> ref, Object value, int indent) {
    if (ref == null || ref.isEmpty()) {
      return bare(value);
    }
    String kind = Ir.str(ref.get("kind"), "");
    String pad = "    ".repeat(indent + 1);
    String close = "    ".repeat(indent);

    switch (kind) {
      case "nullable":
        return value == null ? "null" : literal(Ir.obj(ref.get("inner")), value, indent);
      case "binary":
        // A `format: binary` field is a String in Java, so the placeholder needs no wrapping —
        // unlike
        // TypeScript's `Blob` or Go's `[]byte`.
        return bare(value);
      case "array":
        {
          if (!(value instanceof List<?> items) || items.isEmpty()) {
            return "List.of()";
          }
          List<String> parts = new ArrayList<>();
          for (Object item : items) {
            parts.add(pad + literal(Ir.obj(ref.get("items")), item, indent + 1));
          }
          return "List.of(\n" + String.join(",\n", parts) + ")";
        }
      case "union":
        {
          // The first variant, matching what the core synthesized from. A union renders as `Object`
          // in Java
          // (§3.3.9), so the literal has to be a concrete value of *some* variant.
          List<Map<String, Object>> variants = Ir.objects(ref.get("variants"));
          return variants.isEmpty() ? bare(value) : literal(variants.get(0), value, indent);
        }
      case "named":
        {
          Map<String, Object> type = emitter.types().types().get(Ir.str(ref.get("id"), ""));
          if (type == null) {
            return bare(value);
          }
          String typeKind = Ir.str(type.get("kind"), "");
          if ("alias".equals(typeKind)) {
            return literal(Ir.obj(type.get("target")), value, indent);
          }
          String className = emitter.types().render(ref, false);
          if ("enum".equals(typeKind)) {
            // A constant, not the wire string: a generated enum does not accept one. Matched on the
            // wire
            // value rather than recomputing the constant name, so a member whose name sanitises
            // oddly still
            // resolves.
            for (Map<String, Object> member : Ir.objects(type.get("members"))) {
              if (String.valueOf(member.get("wireValue")).equals(String.valueOf(value))) {
                return className + "." + Naming.constant(Ir.tokens(member.get("name")));
              }
            }
            return className + ".values()[0]";
          }
          if (!(value instanceof Map<?, ?> fields)) {
            return bare(value);
          }
          String role = Ir.str(type.get("role"), "shared");
          boolean writeShape = "create".equals(role) || "update".equals(role);
          return writeShape
              ? builderCall(className, type, fields, pad, close, indent)
              : recordCall(className, type, fields, pad, close, indent);
        }
      default:
        return bare(value);
    }
  }

  /**
   * A record's canonical constructor: every component, in declaration order, `null` where absent.
   *
   * <p>Positional and complete because that is what a record declares — skipping an absent
   * component would not compile, which is a stricter contract than any other target's here.
   */
  private String recordCall(
      String className,
      Map<String, Object> type,
      Map<?, ?> fields,
      String pad,
      String close,
      int indent) {
    // The *record's* component order, read from the models emitter rather than the IR's field
    // order.
    // A record puts required components first (see `propertiesOf`), so iterating the IR order
    // passed a
    // `String` where a `Role` was declared — which the compiler caught, and which recomputing the
    // sort
    // here would have gone on getting wrong the next time that rule changed.
    Map<String, Map<String, Object>> byWire = new LinkedHashMap<>();
    for (Map<String, Object> field : Ir.objects(type.get("fields"))) {
      byWire.put(Ir.str(field.get("wireName"), ""), field);
    }
    List<String> args = new ArrayList<>();
    for (Models.Property property : emitter.models().propertiesOf(type)) {
      Map<String, Object> field = byWire.get(property.wireName());
      Object raw = fields.get(property.wireName());
      args.add(
          pad
              + (raw == null || field == null
                  ? "null"
                  : literal(Ir.obj(field.get("type")), raw, indent + 1)));
    }
    return args.isEmpty()
        ? "new " + className + "()"
        : "new " + className + "(\n" + String.join(",\n", args) + ")";
  }

  /**
   * A write model's builder: only the fields the example carries, which is the point of a builder.
   */
  private String builderCall(
      String className,
      Map<String, Object> type,
      Map<?, ?> fields,
      String pad,
      String close,
      int indent) {
    StringBuilder out = new StringBuilder(className + ".builder()");
    for (Map<String, Object> field : Ir.objects(type.get("fields"))) {
      String wire = Ir.str(field.get("wireName"), "");
      Object raw = fields.get(wire);
      if (raw == null) {
        continue;
      }
      out.append("\n")
          .append(pad)
          .append(".")
          .append(Naming.member(Ir.tokens(field.get("name"))))
          .append("(")
          .append(literal(Ir.obj(field.get("type")), raw, indent + 1))
          .append(")");
    }
    out.append("\n").append(pad).append(".build()");
    return out.toString();
  }

  /** A value with no type to guide it, which is correct for `Object` and map values. */
  private String bare(Object value) {
    if (value == null) {
      return "null";
    }
    if (value instanceof String text) {
      return Source.quote(text);
    }
    if (value instanceof Boolean flag) {
      return flag ? "true" : "false";
    }
    if (value instanceof Number number) {
      double asDouble = number.doubleValue();
      // A JSON number parses as a Double, so an id would otherwise be `1.0` where a `long` is
      // declared.
      if (asDouble == Math.floor(asDouble) && Math.abs(asDouble) < 1e15) {
        return String.valueOf((long) asDouble) + "L";
      }
      return String.valueOf(asDouble);
    }
    if (value instanceof List<?> items) {
      List<String> parts = new ArrayList<>();
      for (Object item : items) {
        parts.add(bare(item));
      }
      return "List.of(" + String.join(", ", parts) + ")";
    }
    if (value instanceof Map<?, ?> fields) {
      List<String> parts = new ArrayList<>();
      for (Map.Entry<?, ?> entry : fields.entrySet()) {
        if (entry.getValue() == null) {
          continue;
        }
        parts.add(Source.quote(String.valueOf(entry.getKey())) + ", " + bare(entry.getValue()));
      }
      // `Map.of` rejects nulls, which is why they are filtered above rather than rendered.
      return "Map.of(" + String.join(", ", parts) + ")";
    }
    return "null";
  }

  /**
   * The arguments for one call.
   *
   * <p>Required parameters first, then optional, then the body, then options — the same order
   * {@code Methods.render} sorts the signature into. Java has no named arguments, so the order
   * <em>is</em> the API, and getting it wrong here silently passes a limit where an id belongs.
   */
  private String args(Map<String, Object> method) {
    Map<String, Object> example = Ir.obj(method.get("example"));
    if (example.isEmpty()) {
      return "null";
    }
    Map<String, Object> params = Ir.obj(example.get("params"));
    Map<String, Object> http = Ir.obj(method.get("http"));

    // The same subset and the same sort as the signature: path and query only, required first.
    List<Map<String, Object>> declared = new ArrayList<>();
    for (Map<String, Object> param : Ir.objects(http.get("params"))) {
      String location = Ir.str(param.get("location"), "");
      if (location.equals("path") || location.equals("query")) {
        declared.add(param);
      }
    }
    declared.sort((a, b) -> Boolean.compare(required(b), required(a)));

    List<String> out = new ArrayList<>();
    for (Map<String, Object> param : declared) {
      String wire = Ir.str(param.get("wireName"), "");
      Object value = params.get(wire);
      // An optional parameter the example omits is passed as null, because the signature declares
      // it.
      out.add(value == null ? "null" : literal(Ir.obj(param.get("type")), value, 2));
    }
    Map<String, Object> body = Ir.obj(method.get("body"));
    if (!body.isEmpty()) {
      out.add(
          example.containsKey("body")
              ? literal(Ir.obj(body.get("type")), example.get("body"), 2)
              : "null");
    }
    // The trailing `RequestOptions`, which every generated method declares.
    out.add("null");
    return String.join(", ", out);
  }

  private static boolean required(Map<String, Object> param) {
    return "path".equals(Ir.str(param.get("location"), "")) || Ir.flag(param.get("required"));
  }

  /**
   * The path the SDK should produce, with the example's values interpolated.
   *
   * <p>Computed rather than asserted loosely: path interpolation is one of the four things a
   * generated test exists to check, and a test asserting only that the path <em>contains</em> a
   * resource name would pass while {@code /orgs/{orgId}/members} came out as {@code
   * /orgs/null/members}.
   */
  private String examplePath(Map<String, Object> method) {
    Map<String, Object> http = Ir.obj(method.get("http"));
    String path = Ir.str(http.get("path"), "/");
    Map<String, Object> params = Ir.obj(Ir.obj(method.get("example")).get("params"));
    for (Map<String, Object> param : Ir.objects(http.get("params"))) {
      if (!"path".equals(Ir.str(param.get("location"), ""))) {
        continue;
      }
      String wire = Ir.str(param.get("wireName"), "");
      Object value = params.get(wire);
      String encoded =
          URLEncoder.encode(value == null ? "" : String.valueOf(value), StandardCharsets.UTF_8)
              .replace("+", "%20");
      path = path.replace("{" + wire + "}", encoded);
    }
    return path;
  }

  private String className(Accessor accessor, Map<String, Object> method) {
    String resource = Naming.type(Ir.tokens(accessor.resource().get("name")));
    return resource + Naming.type(Ir.tokens(method.get("name")));
  }

  /**
   * One example and one test per operation.
   *
   * <p>Both under {@code src/test/java}, which is Maven's own convention and the only place
   * surefire looks. An example is a class with a {@code static void} method rather than a {@code
   * main}: it compiles with the tests, so it cannot drift, and nothing tries to run it.
   */
  List<Emitter.File> files() {
    List<Emitter.File> out = new ArrayList<>();
    Map<String, Object> webhooks = null;

    for (Accessor accessor : accessors()) {
      for (Map<String, Object> method : Ir.objects(accessor.resource().get("methods"))) {
        if (Ir.obj(method.get("example")).isEmpty() || skips(method)) {
          continue;
        }
        out.add(exampleFile(accessor, method));
        out.add(testFile(accessor, method));
      }
    }
    return out;
  }

  /** Whether this target declines to generate the operation, so no example or test refers to it. */
  private boolean skips(Map<String, Object> method) {
    return "stream".equals(Ir.str(Ir.obj(method.get("response")).get("kind"), ""));
  }

  private Emitter.File exampleFile(Accessor accessor, Map<String, Object> method) {
    String name = className(accessor, method) + "Example";
    Map<String, Object> http = Ir.obj(method.get("http"));
    Map<String, Object> docs = Ir.obj(method.get("docs"));
    Map<String, Object> response = Ir.obj(method.get("response"));
    String kind = Ir.str(response.get("kind"), "empty");
    boolean paginated = !Ir.str(method.get("paginationId"), "").isEmpty();
    String call =
        "client."
            + accessor.path()
            + "."
            + Naming.member(Ir.tokens(method.get("name")))
            + "("
            + args(method)
            + ")";

    Source file = new Source(packageName, List.of());
    file.addImport("java.util.List");
    file.addImport("java.util.Map");

    List<String> doc = new ArrayList<>();
    doc.add(Ir.str(docs.get("summary"), accessor.path()));
    doc.add("");
    doc.add(
        "<p>"
            + Ir.str(http.get("verb"), "get").toUpperCase(java.util.Locale.ROOT)
            + " "
            + Ir.str(http.get("path"), "/"));
    doc.add("");
    doc.add(
        "<p>Values are synthesized from the spec, so ids and placeholders are not real. Compiled"
            + " with");
    doc.add("this package's tests, so it cannot drift out of date with the API.");

    StringBuilder body = new StringBuilder(Source.javadoc(doc, 0));
    body.append("final class ").append(name).append(" {\n\n");
    body.append("  private ").append(name).append("() {}\n\n");
    body.append("  static void run(").append(emitter.clientClass()).append(" client) {\n");
    if (paginated) {
      body.append("    for (var item : ")
          .append(call)
          .append(") {\n      System.out.println(item);\n    }\n");
    } else if (kind.equals("empty")) {
      body.append("    ").append(call).append(";\n");
    } else {
      body.append("    var result = ").append(call).append(";\n    System.out.println(result);\n");
    }
    body.append("  }\n}");
    file.add(body.toString());

    return new Emitter.File(
        "src/test/java/" + packageName.replace('.', '/') + "/" + name + ".java", file.render());
  }

  private Emitter.File testFile(Accessor accessor, Map<String, Object> method) {
    String name = className(accessor, method) + "Test";
    Map<String, Object> http = Ir.obj(method.get("http"));
    String verb = Ir.str(http.get("verb"), "get").toUpperCase(java.util.Locale.ROOT);
    Map<String, Object> response = Ir.obj(method.get("response"));
    String kind = Ir.str(response.get("kind"), "empty");
    Object status = response.get("statusCode");
    Map<String, Object> example = Ir.obj(method.get("example"));
    boolean paginated = !Ir.str(method.get("paginationId"), "").isEmpty();

    String payload = "\"\"";
    String contentType = "application/json";
    if (example.containsKey("response")) {
      if (kind.equals("text")) {
        contentType = "text/plain";
        payload = Source.quote(String.valueOf(example.get("response")));
      } else {
        payload = Source.quote(Json.write(example.get("response")));
      }
    }

    String call =
        "client."
            + accessor.path()
            + "."
            + Naming.member(Ir.tokens(method.get("name")))
            + "("
            + args(method)
            + ")";

    Source file = new Source(packageName, List.of());
    file.addImport("java.net.URI");
    file.addImport("java.util.List");
    file.addImport("java.util.Map");
    file.addImport("java.util.concurrent.atomic.AtomicReference");
    file.addImport("org.junit.jupiter.api.Test");
    file.addImport("static org.junit.jupiter.api.Assertions.assertEquals");
    file.addImport("static org.junit.jupiter.api.Assertions.assertNotNull");
    file.addImport("static org.junit.jupiter.api.Assertions.assertTrue");
    file.addImport(packageName + ".core.HttpRequestSpec");
    file.addImport(packageName + ".core.HttpResponseSpec");

    List<String> doc =
        List.of(
            accessor.path()
                + "."
                + Naming.member(Ir.tokens(method.get("name")))
                + " — "
                + verb
                + " "
                + Ir.str(http.get("path"), "/"),
            "",
            "<p>Generated from the spec. Asserts the request this SDK builds and that the declared"
                + " response",
            "decodes; it asserts nothing about the API being up, because it never calls it.",
            "",
            "<p>Regenerated on every run and not preserved — edit the spec, not this file.");

    StringBuilder body = new StringBuilder(Source.javadoc(doc, 0));
    body.append("final class ").append(name).append(" {\n\n");
    body.append("  @Test\n  void buildsTheDocumentedRequest() {\n");
    body.append("    AtomicReference<HttpRequestSpec> seen = new AtomicReference<>();\n");
    body.append("    var client =\n        ")
        .append(emitter.clientClass())
        .append(".builder()\n            .baseUrl(\"https://api.test\")\n");
    body.append("            .transport(\n                (request, timeout) -> {\n");
    body.append("                  seen.set(request);\n");
    body.append("                  return new HttpResponseSpec(\n                      ")
        .append(status instanceof Number n ? String.valueOf(n.intValue()) : "200")
        .append(", ")
        .append(payload)
        .append(", Map.of(\"content-type\", ")
        .append(Source.quote(contentType))
        .append("));\n                })\n            .build();\n\n");
    if (paginated) {
      body.append("    for (var item : ").append(call).append(") {\n      break;\n    }\n\n");
    } else if (kind.equals("empty")) {
      body.append("    ").append(call).append(";\n\n");
    } else {
      body.append("    ").append(call).append(";\n\n");
    }
    body.append("    assertNotNull(seen.get());\n");
    body.append("    assertEquals(").append(Source.quote(verb)).append(", seen.get().method());\n");
    body.append("    assertEquals(\n        ")
        .append(Source.quote(examplePath(method)))
        .append(", URI.create(seen.get().url()).getPath());\n");

    Map<String, Object> requestBody = Ir.obj(method.get("body"));
    if (!requestBody.isEmpty() && example.containsKey("body")) {
      String declared =
          Ir.str(requestBody.get("contentType"), "").toLowerCase(java.util.Locale.ROOT);
      body.append("\n    // Declared as ")
          .append(Ir.str(requestBody.get("contentType"), ""))
          .append(" in the spec.\n");
      body.append(
          "    var sentType = seen.get().headers().getOrDefault(\"Content-Type\", \"\");\n");
      if (declared.contains("x-www-form-urlencoded")) {
        body.append("    assertTrue(sentType.contains(\"x-www-form-urlencoded\"), sentType);\n");
      } else if (declared.startsWith("multipart/")) {
        body.append("    assertTrue(sentType.startsWith(\"multipart/form-data\"), sentType);\n");
        body.append("    // A boundary is what makes a multipart body parseable at all.\n");
        body.append("    assertTrue(sentType.contains(\"boundary=\"), sentType);\n");
      } else {
        body.append("    assertTrue(sentType.contains(")
            .append(Source.quote(Ir.str(requestBody.get("contentType"), "")))
            .append("), sentType);\n");
      }
    }

    boolean hasOptionalQuery = false;
    for (Map<String, Object> param : Ir.objects(http.get("params"))) {
      if ("query".equals(Ir.str(param.get("location"), "")) && !Ir.flag(param.get("required"))) {
        hasOptionalQuery = true;
      }
    }
    if (hasOptionalQuery) {
      body.append(
          "\n"
              + "    // An omitted optional query parameter must not reach the wire at all. A"
              + " generator\n");
      body.append(
          "    // serializing null would send `?since=null`, which a server reads as a value.\n");
      body.append("    var query = URI.create(seen.get().url()).getQuery();\n");
      body.append(
          "    if (query != null) {\n"
              + "      assertTrue(!query.contains(\"=null\"), query);\n"
              + "    }\n");
    }
    body.append("  }\n}");
    file.add(body.toString());

    return new Emitter.File(
        "src/test/java/" + packageName.replace('.', '/') + "/" + name + ".java", file.render());
  }
}
