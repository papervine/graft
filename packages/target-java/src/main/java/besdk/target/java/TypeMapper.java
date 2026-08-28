package besdk.target.java;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * IR type references to Java types.
 *
 * <p>Two things differ from every previous target.
 *
 * <p><b>Boxed versus primitive is a real distinction, not a style one.</b> A required field can be
 * {@code long}; an optional one must be {@code Long}, because a primitive cannot be null and Java
 * has no other way to say "absent". So nullability decides boxing, which is why {@link #render}
 * takes a required flag rather than the caller appending a {@code ?}.
 *
 * <p><b>Generics are real.</b> Unlike PHP, {@code List<Widget>} is enforced by the compiler, so
 * there is no phpdoc-shaped gap between what the language checks and what the typechecker checks.
 */
public final class TypeMapper {

  private final Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
  private final Map<String, String> names = new LinkedHashMap<>();

  public TypeMapper(Map<String, Object> ir) {
    Map<String, Boolean> taken = new LinkedHashMap<>();
    for (Map<String, Object> type : Ir.objects(ir.get("types"))) {
      String id = Ir.str(type.get("id"), null);
      if (id == null) {
        continue;
      }
      byId.put(id, type);
      String candidate = Naming.type(Ir.tokens(type.get("name")));
      // A collision would produce two types with one name in one package, which does not compile.
      // Suffixed
      // numerically rather than by role, because the role is not always known here.
      String unique = candidate;
      int suffix = 2;
      while (taken.containsKey(unique)) {
        unique = candidate + suffix++;
      }
      taken.put(unique, Boolean.TRUE);
      names.put(id, unique);
    }
  }

  public Map<String, Map<String, Object>> types() {
    return byId;
  }

  public String nameOf(String id) {
    return names.getOrDefault(id, "Object");
  }

  public boolean isEnum(String id) {
    return "enum".equals(Ir.str(byId.getOrDefault(id, Map.of()).get("kind"), null));
  }

  /**
   * Is a *rendered type name* an enum?
   *
   * <p>By name rather than by id, because that is what the decoder has to work with — it sees
   * `Role`, not the IR id it came from.
   */
  public boolean isEnumName(String rendered) {
    for (Map.Entry<String, String> entry : names.entrySet()) {
      if (entry.getValue().equals(rendered)) {
        return isEnum(entry.getKey());
      }
    }
    return false;
  }

  public boolean isObject(String id) {
    return "object".equals(Ir.str(byId.getOrDefault(id, Map.of()).get("kind"), null));
  }

  /**
   * The Java type for a reference.
   *
   * @param required when false, a primitive is boxed so the field can be null
   */
  public String render(Map<String, Object> ref, boolean required) {
    String kind = Ir.str(ref.get("kind"), "unknown");
    return switch (kind) {
      case "primitive" -> primitive(ref, required);
      case "array" -> "List<" + render(inner(ref, "items"), false) + ">";
      case "map" -> "Map<String, " + render(inner(ref, "values"), false) + ">";
      // A nullable reference is always boxed, whatever the field's required-ness says: the value
      // itself may
      // be null.
      case "nullable" -> render(inner(ref, "inner"), false);
      case "named" -> named(ref, required);
      case "binary", "text" -> "String";
      case "literal" -> literal(ref, required);
      // Java has no anonymous union type. `Object` is what Go does with the same input (`any`), and
      // unlike
      // Go, Java could express this as a sealed interface — see SPEC.md §3.3.9 for why that is
      // designed but
      // not yet emitted.
      case "union" -> "Object";
      case "null" -> "Object";
      default -> "Object";
    };
  }

  private String primitive(Map<String, Object> ref, boolean required) {
    String type = Ir.str(ref.get("type"), "");
    String format = Ir.str(ref.get("format"), "");
    return switch (type) {
      case "string" -> "date-time".equals(format) ? "Instant" : "String";
      // `long`, not `int`: an id or a count that fits in 32 bits today may not tomorrow, and a JSON
      // integer
      // has no declared width. `int32` is the one case where the spec says otherwise.
      case "integer" ->
          "int32".equals(format) ? (required ? "int" : "Integer") : (required ? "long" : "Long");
      case "number" -> required ? "double" : "Double";
      case "boolean" -> required ? "boolean" : "Boolean";
      default -> "Object";
    };
  }

  private String named(Map<String, Object> ref, boolean required) {
    String id = Ir.str(ref.get("id"), "");
    Map<String, Object> type = byId.get(id);
    if (type == null) {
      return "Object";
    }
    // An alias resolves to its target: it has no type of its own, so a reference to it would name
    // nothing.
    if ("alias".equals(Ir.str(type.get("kind"), null))) {
      return render(Ir.obj(type.get("target")), required);
    }
    return nameOf(id);
  }

  private String literal(Map<String, Object> ref, boolean required) {
    Object value = ref.get("value");
    if (value instanceof String) {
      return "String";
    }
    if (value instanceof Number) {
      return required ? "long" : "Long";
    }
    if (value instanceof Boolean) {
      return required ? "boolean" : "Boolean";
    }
    return "Object";
  }

  /** Which {@code java.*} types a rendered type needs imported. */
  public static List<String> importsFor(String rendered) {
    List<String> out = new java.util.ArrayList<>();
    if (rendered.contains("Instant")) {
      out.add("java.time.Instant");
    }
    if (rendered.contains("List<")) {
      out.add("java.util.List");
    }
    if (rendered.contains("Map<")) {
      out.add("java.util.Map");
    }
    return out;
  }

  private Map<String, Object> inner(Map<String, Object> ref, String key) {
    Map<String, Object> value = Ir.obj(ref.get(key));
    return value.isEmpty() ? Map.of("kind", "unknown") : value;
  }
}
