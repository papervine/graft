package besdk.target.java;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Reading the IR without lying about its type.
 *
 * <p>The IR arrives from a JSON parser, so every value is {@code Object} and every collection is
 * untyped. These are <b>normalisers, not casts</b>: each returns a well-formed value of the
 * declared type for any input, so a malformed IR produces a degraded SDK rather than a {@code
 * ClassCastException} inside the emitter. That is the right failure for a tool reading a file it
 * did not write.
 *
 * <p>The PHP target learned this the expensive way — it read {@code http.method} where the IR has
 * {@code http.verb}, and every generated method came out as a GET. Silently. So the accessors here
 * are deliberately dumb and the field names are checked against `packages/protocol/src/ir.ts`
 * rather than remembered.
 */
public final class Ir {

  private Ir() {}

  /** A string-keyed object, or an empty one. */
  public static Map<String, Object> obj(Object value) {
    if (!(value instanceof Map<?, ?> map)) {
      return Map.of();
    }
    java.util.LinkedHashMap<String, Object> out = new java.util.LinkedHashMap<>();
    map.forEach((key, item) -> out.put(String.valueOf(key), item));
    return out;
  }

  /** A list of objects, dropping anything that is not one. */
  public static List<Map<String, Object>> objects(Object value) {
    List<Map<String, Object>> out = new ArrayList<>();
    if (value instanceof List<?> items) {
      for (Object item : items) {
        if (item instanceof Map<?, ?>) {
          out.add(obj(item));
        }
      }
    }
    return List.copyOf(out);
  }

  /**
   * A string, or the fallback. Never {@code String.valueOf(mixed)}, which renders a map as its
   * toString.
   */
  public static String str(Object value, String fallback) {
    return value instanceof String s && !s.isEmpty() ? s : fallback;
  }

  public static String str(Object value) {
    return str(value, "");
  }

  public static List<String> strings(Object value) {
    List<String> out = new ArrayList<>();
    if (value instanceof List<?> items) {
      for (Object item : items) {
        if (item instanceof String s) {
          out.add(s);
        }
      }
    }
    return List.copyOf(out);
  }

  public static boolean flag(Object value) {
    return value instanceof Boolean b && b;
  }

  /** The `name.tokens` of a node, or a placeholder. */
  public static List<String> tokens(Object node) {
    List<String> out = strings(obj(node).get("tokens"));
    return out.isEmpty() ? List.of("value") : out;
  }
}
