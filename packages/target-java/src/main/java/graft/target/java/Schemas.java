package graft.target.java;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Planning the validation descriptor table (SPEC.md §3.4.1.1).
 *
 * <p>Emits the same compact JSON form every other target does, so the shape is reviewed once and
 * the runtime walkers agree by construction. Two properties matter:
 *
 * <ul>
 *   <li><b>Only reachable types are emitted.</b> A descriptor is useful only for a type that
 *       appears in a response, and a spec's type graph is much larger than its response graph.
 *   <li><b>Cycles terminate through the table</b>, not through recursion, so a self-referential
 *       schema is finite by construction rather than by a depth cap.
 * </ul>
 */
final class Schemas {

  private final TypeMapper types;
  private final Map<String, String> table = new TreeMap<>();
  private final List<String> started = new ArrayList<>();

  Schemas(TypeMapper types) {
    this.types = types;
  }

  /** Sorted, so output is byte-stable across runs and a regeneration is not a spurious diff. */
  Map<String, String> table() {
    return new LinkedHashMap<>(table);
  }

  /** A descriptor for a reference, adding anything it names to the table. */
  String describe(Map<String, Object> ref) {
    if (ref == null || ref.isEmpty()) {
      return "{\"k\":\"any\"}";
    }
    String kind = Ir.str(ref.get("kind"), "unknown");
    return switch (kind) {
      case "primitive" -> primitive(ref);
      case "array" -> "{\"k\":\"arr\",\"i\":" + describe(Ir.obj(ref.get("items"))) + "}";
      case "map" -> "{\"k\":\"map\",\"v\":" + describe(Ir.obj(ref.get("values"))) + "}";
      case "nullable" -> "{\"k\":\"null\",\"i\":" + describe(Ir.obj(ref.get("inner"))) + "}";
      case "named" -> named(ref);
      case "union" -> union(ref);
      // Binary never reaches the JSON validator; a binary inside a JSON body is a base64 string.
      case "binary", "text" -> "{\"k\":\"str\"}";
      case "literal" -> literal(ref);
      default -> "{\"k\":\"any\"}";
    };
  }

  private String primitive(Map<String, Object> ref) {
    return switch (Ir.str(ref.get("type"), "")) {
      // Only `date-time` is a date; a `date` stays a string, matching how the model decodes it.
      case "string" ->
          "date-time".equals(Ir.str(ref.get("format"), ""))
              ? "{\"k\":\"date\"}"
              : "{\"k\":\"str\"}";
      case "integer" -> "{\"k\":\"int\"}";
      case "number" -> "{\"k\":\"num\"}";
      case "boolean" -> "{\"k\":\"bool\"}";
      default -> "{\"k\":\"any\"}";
    };
  }

  private String literal(Map<String, Object> ref) {
    // Validated as its base type, for the same reason an enum is: a server widening it must not
    // become a
    // decode failure.
    Object value = ref.get("value");
    if (value instanceof String) {
      return "{\"k\":\"str\"}";
    }
    if (value instanceof Number) {
      return "{\"k\":\"num\"}";
    }
    return "{\"k\":\"bool\"}";
  }

  private String union(Map<String, Object> ref) {
    List<String> branches = new ArrayList<>();
    for (Map<String, Object> variant : Ir.objects(ref.get("variants"))) {
      branches.add(describe(variant));
    }
    return "{\"k\":\"or\",\"o\":[" + String.join(",", branches) + "]}";
  }

  private String named(Map<String, Object> ref) {
    String id = Ir.str(ref.get("id"), "");
    Map<String, Object> type = types.types().get(id);
    if (type == null) {
      return "{\"k\":\"any\"}";
    }
    // An alias is inlined: it has no type of its own, so a `ref` would point at nothing.
    if ("alias".equals(Ir.str(type.get("kind"), ""))) {
      return describe(Ir.obj(type.get("target")));
    }
    String name = types.nameOf(id);
    ensure(id, name, type);
    return "{\"k\":\"ref\",\"n\":\"" + name + "\"}";
  }

  private void ensure(String id, String name, Map<String, Object> type) {
    if (started.contains(id)) {
      return;
    }
    started.add(id);
    // Reserved before recursing, so a self-reference finds the key present and emits a `ref`.
    table.put(name, "{\"k\":\"any\"}");
    table.put(name, describeNamed(type));
  }

  private String describeNamed(Map<String, Object> type) {
    return switch (Ir.str(type.get("kind"), "")) {
      // Base type only, never membership. Servers add enum values without warning, and the
      // open-enum rule
      // (§3.3.1) exists precisely so that does not break a client.
      case "enum" -> enumBase(type);
      case "object" -> describeObject(type);
      default -> "{\"k\":\"any\"}";
    };
  }

  private String enumBase(Map<String, Object> type) {
    for (Map<String, Object> member : Ir.objects(type.get("members"))) {
      if (member.get("wireValue") instanceof Number) {
        return "{\"k\":\"num\"}";
      }
    }
    return "{\"k\":\"str\"}";
  }

  private String describeObject(Map<String, Object> type) {
    List<String> fields = new ArrayList<>();
    for (Map<String, Object> field : Ir.objects(type.get("fields"))) {
      String wire = Ir.str(field.get("wireName"), "");
      String descriptor = describe(Ir.obj(field.get("type")));
      fields.add(
          Ir.flag(field.get("required"))
              ? "[\"" + wire + "\"," + descriptor + ",1]"
              : "[\"" + wire + "\"," + descriptor + "]");
    }
    String result = "{\"k\":\"obj\",\"f\":[" + String.join(",", fields) + "]";
    Map<String, Object> additional = Ir.obj(type.get("additional"));
    if (!additional.isEmpty()) {
      result += ",\"a\":" + describe(additional);
    }
    return result + "}";
  }
}
