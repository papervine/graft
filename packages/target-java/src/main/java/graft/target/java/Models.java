package graft.target.java;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Emitting models: records for read shapes, builders for write shapes.
 *
 * <p><b>Records for reads.</b> A decoded response is a value: immutable, equal by content, with a
 * useful {@code toString} for free. That is exactly what a record is, and it is why no other
 * target's read model is this short.
 *
 * <p><b>Builders for writes.</b> Java has neither keyword arguments nor default parameter values,
 * so a request body with twenty optional fields has no usable constructor — the alternatives are a
 * telescoping constructor set, which becomes ambiguous the moment two optional fields share a type,
 * or a builder (SPEC.md §3.3.9). PHP and Python need no builder for the same shape, because named
 * arguments solve it.
 */
final class Models {

  private final TypeMapper types;
  private final String packageName;
  private final String generatedNotice;

  Models(TypeMapper types, String packageName, String generatedNotice) {
    this.types = types;
    this.packageName = packageName;
    this.generatedNotice = generatedNotice;
  }

  /** One field, as the emitter needs it. */
  record Property(String wireName, String name, String type, boolean required, String summary) {}

  List<Emitter.File> files() {
    List<Emitter.File> out = new ArrayList<>();
    types
        .types()
        .forEach(
            (id, type) -> {
              String kind = Ir.str(type.get("kind"), "");
              // An alias contributes no file: it resolves to its target everywhere it is
              // referenced, and a
              // one-field wrapper class is noise a reader has to see through.
              if ("alias".equals(kind)) {
                return;
              }
              String name = types.nameOf(id);
              String source =
                  "enum".equals(kind) ? enumSource(name, type) : recordSource(name, type);
              out.add(new Emitter.File(sourcePath(name), source));
            });
    return out;
  }

  String sourcePath(String typeName) {
    return "src/main/java/" + packageName.replace('.', '/') + "/" + typeName + ".java";
  }

  /**
   * A native Java enum with a wire value.
   *
   * <p>{@code fromWire} returns null for an unknown member rather than throwing, which is the
   * open-enum rule (§3.3.1): a server adding a value must not turn an additive API change into a
   * client crash. {@code valueOf} would throw, and {@code Enum.valueOf} on the Java name would fail
   * anyway for a wire value like {@code us-east-1}.
   */
  private String enumSource(String name, Map<String, Object> type) {
    Source file = new Source(packageName, List.of());
    List<Map<String, Object>> members = Ir.objects(type.get("members"));

    List<String> doc = new ArrayList<>(List.of(generatedNotice, ""));
    doc.addAll(
        Source.prose(
            Ir.str(Ir.obj(type.get("docs")).get("summary"), name + "."),
            Ir.str(Ir.obj(type.get("docs")).get("description"), null)));
    doc.add("");
    doc.add(
        "<p>Use {@link #fromWire} on a value from the API: it returns null for a member added after"
            + " this");
    doc.add(
        "SDK was generated, where a throwing lookup would turn an additive change into a crash.");

    StringBuilder body = new StringBuilder(Source.javadoc(doc, 0));
    body.append("public enum ").append(name).append(" implements Query.WireValued {\n");

    List<String> seen = new ArrayList<>();
    List<String> constants = new ArrayList<>();
    for (Map<String, Object> member : members) {
      Object wire = member.get("wireValue");
      String constant = Naming.constant(Ir.tokens(member.get("name")));
      String unique = constant;
      int suffix = 2;
      while (seen.contains(unique)) {
        unique = constant + "_" + suffix++;
      }
      seen.add(unique);
      constants.add(unique + "(" + Source.quote(String.valueOf(wire)) + ")");
    }
    body.append("  ").append(String.join(",\n  ", constants)).append(";\n\n");
    body.append("  private final String wire;\n\n");
    body.append("  ").append(name).append("(String wire) {\n    this.wire = wire;\n  }\n\n");
    body.append("  @Override\n  public String wireValue() {\n    return wire;\n  }\n\n");
    body.append(
        Source.javadoc(
            List.of(
                "The member with this wire value, or null when the server sent one this SDK does"
                    + " not know."),
            2));
    body.append("  public static ").append(name).append(" fromWire(String value) {\n");
    body.append("    for (").append(name).append(" candidate : values()) {\n");
    body.append(
        "      if (candidate.wire.equals(value)) {\n        return candidate;\n      }\n    }\n");
    body.append("    return null;\n  }\n}");

    file.addImport(packageName + ".core.Query");
    file.add(body.toString());
    return file.render();
  }

  private String recordSource(String name, Map<String, Object> type) {
    Source file = new Source(packageName, List.of());
    List<Property> properties = propertiesOf(type);
    String role = Ir.str(type.get("role"), "shared");
    boolean writeShape = "create".equals(role) || "update".equals(role);

    for (Property property : properties) {
      file.addImports(TypeMapper.importsFor(property.type()));
    }
    file.addImport("java.util.LinkedHashMap");
    file.addImport("java.util.Map");
    file.addImport(packageName + ".core.DecodeException");
    file.addImport(packageName + ".core.Json");
    // Imported unconditionally: any field with a declared type narrows through `Support`, and
    // google-java-format's `--fix-imports` removes it from the rare model that does not. Deciding
    // here would
    // mean predicting what the decoder emits, which is exactly the coupling that goes stale.
    file.addImport(packageName + ".core.Support");

    List<String> doc = new ArrayList<>(List.of(generatedNotice, ""));
    doc.addAll(
        Source.prose(
            Ir.str(Ir.obj(type.get("docs")).get("summary"), name + "."),
            Ir.str(Ir.obj(type.get("docs")).get("description"), null)));
    if (!writeShape) {
      doc.add("");
      doc.add(
          "<p>A record: immutable, equal by content, and not something the code that received it"
              + " should");
      doc.add("change.");
    }

    StringBuilder body = new StringBuilder(Source.javadoc(doc, 0));
    body.append("public record ").append(name).append("(\n");
    List<String> components = new ArrayList<>();
    for (Property property : properties) {
      components.add("    " + property.type() + " " + property.name());
    }
    // `implements Json.JsonValue`, so the runtime's writer can serialise a model handed to it
    // directly.
    //
    // Every record already declares `toJson()`, and the runtime's own docblock said "generated
    // request
    // models implement this" — but none did, so `Json.write(body)` on a *union* body threw
    // "cannot serialise MemberInvitedEvent as JSON" at run time. A union renders as `Object`, so
    // the
    // target had no model type to call `toJson()` on and passed the value straight through.
    // Declaring the
    // interface is what makes the runtime's promise true.
    body.append(String.join(",\n", components)).append(") implements Json.JsonValue {\n\n");
    body.append(decoder(name, properties));
    if (writeShape) {
      body.append('\n').append(builder(name, properties));
    }
    body.append('\n').append(encoder(properties));
    body.append("}");

    file.add(body.toString());
    return file.render();
  }

  List<Property> propertiesOf(Map<String, Object> type) {
    List<Property> out = new ArrayList<>();
    for (Map<String, Object> field : Ir.objects(type.get("fields"))) {
      boolean required = Ir.flag(field.get("required"));
      Map<String, Object> ref = Ir.obj(field.get("type"));
      out.add(
          new Property(
              Ir.str(field.get("wireName"), ""),
              Naming.member(Ir.tokens(field.get("name"))),
              types.render(ref.isEmpty() ? Map.of("kind", "unknown") : ref, required),
              required,
              Ir.str(Ir.obj(field.get("docs")).get("summary"), null)));
    }
    // Required first, so a record's canonical constructor reads with the mandatory values in front.
    // Unlike
    // Java's *parameter default* rules, this is a readability choice rather than a language
    // constraint —
    // records have no defaults at all.
    out.sort((a, b) -> Boolean.compare(b.required(), a.required()));
    return out;
  }

  /**
   * A decoder from the wire shape.
   *
   * <p>Generated rather than reflective: reflection over record components is slow enough to matter
   * on a large response, and it cannot know that the wire key is {@code _id} while the component is
   * {@code id} — that mapping exists only in the IR.
   *
   * <p>Each value is narrowed into a local before the constructor call, so a required field of the
   * wrong type fails with a message naming it rather than as a {@code ClassCastException} from
   * inside a constructor. The PHP target learned this from PHPStan; Java's compiler enforces it
   * outright.
   */
  private String decoder(String name, List<Property> properties) {
    StringBuilder out =
        new StringBuilder(
            Source.javadoc(
                List.of("Build from a decoded JSON object.", "", "@param data a parsed JSON tree"),
                2));
    // A parameter name no component shadows. A model with a field called `data` produced
    // `List<Member> data = ...` inside `fromJson(Object data)` — "variable data is already
    // defined". PHP hit
    // the identical bug on the identical spec, where it silently read from the wrong variable
    // instead; Java's
    // compiler turns it into a build failure, which is the better outcome for the same underlying
    // mistake.
    String arg = unshadowedArgName(properties);
    out.append("  public static ")
        .append(name)
        .append(" fromJson(Object ")
        .append(arg)
        .append(") {\n");
    out.append("    if (!(").append(arg).append(" instanceof Map<?, ?> map)) {\n");
    out.append("      throw new DecodeException(")
        .append(Source.quote(name + ": expected an object"))
        .append(");\n");
    out.append("    }\n");

    for (Property property : properties) {
      out.append(Decoding.local(property, name, arg, types));
    }

    out.append("    return new ").append(name).append("(\n");
    List<String> args = new ArrayList<>();
    for (Property property : properties) {
      args.add("        " + property.name());
    }
    out.append(String.join(",\n", args)).append(");\n  }\n");
    return out.toString();
  }

  /** A JSON tree, for a write model used as a request body. */
  private String encoder(List<Property> properties) {
    StringBuilder out =
        new StringBuilder(
            Source.javadoc(
                List.of(
                    "This value as a JSON tree, for a request body.",
                    "",
                    "<p>A null field is omitted rather than sent as JSON null: absent and null mean"
                        + " different",
                    "things to most APIs, and sending null would overwrite a value the caller never"
                        + " touched."),
                2));
    out.append("  public Map<String, Object> toJson() {\n");
    out.append("    LinkedHashMap<String, Object> out = new LinkedHashMap<>();\n");
    for (Property property : properties) {
      out.append(Decoding.encode(property));
    }
    out.append("    return out;\n  }\n");
    return out.toString();
  }

  /** A fluent builder, for a write model. */
  private String builder(String name, List<Property> properties) {
    StringBuilder out =
        new StringBuilder(
            Source.javadoc(
                List.of(
                    "A builder.",
                    "",
                    "<p>Java has neither keyword arguments nor default parameter values, so a body"
                        + " with several",
                    "optional fields has no usable constructor. Every other target reaches for"
                        + " named arguments",
                    "instead; this is the language difference, not a style preference."),
                2));
    out.append("  public static Builder builder() {\n    return new Builder();\n  }\n\n");
    out.append("  /** Fluent builder for {@link ").append(name).append("}. */\n");
    out.append("  public static final class Builder {\n\n");
    for (Property property : properties) {
      out.append("    private ")
          .append(boxed(property.type()))
          .append(' ')
          .append(property.name())
          .append(";\n");
    }
    out.append("\n    private Builder() {}\n");
    for (Property property : properties) {
      out.append('\n');
      if (property.summary() != null) {
        out.append(Source.javadoc(Source.prose(property.summary(), null), 4));
      }
      out.append("    public Builder ")
          .append(property.name())
          .append('(')
          .append(boxed(property.type()))
          .append(" value) {\n");
      out.append("      this.").append(property.name()).append(" = value;\n");
      out.append("      return this;\n    }\n");
    }
    out.append("\n    public ").append(name).append(" build() {\n");
    out.append("      return new ").append(name).append("(\n");
    List<String> args = new ArrayList<>();
    for (Property property : properties) {
      // A required primitive component cannot take a null builder field, so it is unboxed with a
      // check that
      // names the field — better than an NPE with no context.
      args.add(
          property.required() && isPrimitive(property.type())
              ? "          require(" + property.name() + ", " + Source.quote(property.name()) + ")"
              : "          " + property.name());
    }
    out.append(String.join(",\n", args)).append(");\n    }\n");
    if (properties.stream().anyMatch(p -> p.required() && isPrimitive(p.type()))) {
      out.append('\n')
          .append(
              Source.javadoc(
                  List.of(
                      "A required value that was never set, named rather than surfacing as an"
                          + " NPE."),
                  4));
      out.append("    private static <T> T require(T value, String field) {\n");
      out.append("      if (value == null) {\n");
      out.append("        throw new IllegalStateException(field + \" is required\");\n      }\n");
      out.append("      return value;\n    }\n");
    }
    out.append("  }\n");
    return out.toString();
  }

  /** The boxed form of a type, so a builder field can be null before it is set. */
  static String boxed(String type) {
    return switch (type) {
      case "long" -> "Long";
      case "int" -> "Integer";
      case "double" -> "Double";
      case "boolean" -> "Boolean";
      default -> type;
    };
  }

  static boolean isPrimitive(String type) {
    return switch (type) {
      case "long", "int", "double", "boolean" -> true;
      default -> false;
    };
  }

  /**
   * A name for the decoder's parameter that no component shadows.
   *
   * @param properties the record's components
   */
  private static String unshadowedArgName(List<Property> properties) {
    List<String> taken = new ArrayList<>();
    for (Property property : properties) {
      taken.add(property.name());
    }
    for (String candidate : List.of("data", "payload", "raw", "input")) {
      if (!taken.contains(candidate)) {
        return candidate;
      }
    }
    String name = "data";
    int suffix = 2;
    while (taken.contains(name)) {
      name = "data" + suffix++;
    }
    return name;
  }
}
