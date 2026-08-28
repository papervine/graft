package besdk.runtime;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads the compact descriptor form the generated table ships in.
 *
 * <p>Compact because the table for a large spec is thousands of entries and it lands in every
 * consumer's jar: {@code {"k":"str"}} rather than a builder call per node. Parsed once, at class
 * initialisation of the generated {@code Schemas} class — a per-call parse would be a per-request
 * cost for data that never changes.
 */
final class SchemaParser {

  private SchemaParser() {}

  static Map<String, Schema> table(String json) {
    Object parsed = Json.parse(json);
    if (!(parsed instanceof Map<?, ?> map)) {
      throw new DecodeException("schema table was not an object");
    }
    Map<String, Schema> out = new LinkedHashMap<>();
    map.forEach((name, descriptor) -> out.put(String.valueOf(name), node(descriptor)));
    return Map.copyOf(out);
  }

  static Schema one(String json) {
    return node(Json.parse(json));
  }

  private static Schema node(Object value) {
    if (!(value instanceof Map<?, ?> map)) {
      return new Schema.Any();
    }
    String kind = map.get("k") instanceof String k ? k : "any";
    return switch (kind) {
      case "str" -> new Schema.Str();
      case "date" -> new Schema.Date();
      case "num" -> new Schema.Num();
      case "int" -> new Schema.Int();
      case "bool" -> new Schema.Bool();
      case "arr" -> new Schema.Arr(node(map.get("i")));
      case "map" -> new Schema.MapOf(node(map.get("v")));
      case "null" -> new Schema.Nullable(node(map.get("i")));
      case "or" -> new Schema.Or(branches(map.get("o")));
      case "ref" -> new Schema.Ref(map.get("n") instanceof String n ? n : "");
      case "obj" ->
          new Schema.Obj(fields(map.get("f")), map.containsKey("a") ? node(map.get("a")) : null);
      default -> new Schema.Any();
    };
  }

  private static List<Schema> branches(Object value) {
    List<Schema> out = new ArrayList<>();
    if (value instanceof Iterable<?> items) {
      for (Object item : items) {
        out.add(node(item));
      }
    }
    return List.copyOf(out);
  }

  private static List<Schema.Field> fields(Object value) {
    List<Schema.Field> out = new ArrayList<>();
    if (!(value instanceof Iterable<?> items)) {
      return List.of();
    }
    for (Object item : items) {
      if (!(item instanceof List<?> triple) || triple.isEmpty()) {
        continue;
      }
      String name = String.valueOf(triple.get(0));
      Schema schema = triple.size() > 1 ? node(triple.get(1)) : new Schema.Any();
      // A third element, present and equal to 1, marks the field required. Absent means optional —
      // which
      // keeps the common case one element shorter across thousands of entries.
      boolean required =
          triple.size() > 2 && triple.get(2) instanceof Number n && n.intValue() == 1;
      out.add(new Schema.Field(name, schema, required));
    }
    return List.copyOf(out);
  }
}
