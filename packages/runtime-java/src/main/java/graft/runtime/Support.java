package graft.runtime;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * Helpers generated models call.
 *
 * <p>In the runtime rather than emitted per SDK, because they are identical for every spec and
 * hand-written code is where this project puts quality ({@code AGENTS.md}). Generated decoders stay
 * a list of narrowing assignments, which is the part that genuinely differs per model.
 */
public final class Support {

  private Support() {}

  /**
   * A required field was absent or the wrong type.
   *
   * <p>Returns {@code <T>} rather than {@code void} so it can be used as the else-branch of a
   * conditional expression, which is what lets a generated decoder narrow in one statement per
   * field.
   */
  public static <T> T fail(String owner, String field, String expected) {
    throw new DecodeException(owner + ": expected " + expected + " for `" + field + "`");
  }

  /**
   * Parse an RFC 3339 timestamp, tolerating an offset.
   *
   * <p>Returns null on an unparseable value rather than throwing, so the caller decides whether
   * that is fatal — which depends on whether the field was required. {@code Instant.parse} rejects
   * an offset other than {@code Z}, which real APIs send, so {@code OffsetDateTime} is tried
   * second.
   */
  public static Instant instant(Object value) {
    if (value instanceof Instant already) {
      return already;
    }
    if (!(value instanceof String text) || text.isBlank()) {
      return null;
    }
    try {
      return Instant.parse(text);
    } catch (java.time.format.DateTimeParseException ignored) {
      try {
        return OffsetDateTime.parse(text).toInstant();
      } catch (java.time.format.DateTimeParseException alsoIgnored) {
        return null;
      }
    }
  }

  /** Decode a JSON array, dropping nothing: a null element stays null. */
  public static <T> List<T> list(Object value, Function<Object, T> decode) {
    if (!(value instanceof List<?> items)) {
      return List.of();
    }
    List<T> out = new ArrayList<>(items.size());
    for (Object item : items) {
      out.add(decode.apply(item));
    }
    // `Collections.unmodifiableList`, not `List.copyOf`: the latter rejects null elements, and a
    // JSON array
    // is allowed to contain them.
    return java.util.Collections.unmodifiableList(out);
  }

  /** Decode a JSON object as a map. */
  public static <T> Map<String, T> mapOf(Object value, Function<Object, T> decode) {
    if (value instanceof List<?> empty && empty.isEmpty()) {
      // An empty map arrives as `[]` from a PHP backend, which is the artifact SPEC.md §3.1.2
      // names.
      return Map.of();
    }
    if (!(value instanceof Map<?, ?> map)) {
      return Map.of();
    }
    LinkedHashMap<String, T> out = new LinkedHashMap<>();
    map.forEach((key, item) -> out.put(String.valueOf(key), decode.apply(item)));
    return java.util.Collections.unmodifiableMap(out);
  }

  /**
   * Encode one value for a request body: a model's tree, an enum's wire value, or the value itself.
   */
  public static Object encodeOne(Object value) {
    if (value == null) {
      return null;
    }
    if (value instanceof Query.WireValued wired) {
      return wired.wireValue();
    }
    if (value instanceof Instant instant) {
      return instant.toString();
    }
    if (value instanceof Json.JsonValue custom) {
      return custom.toJson();
    }
    return value;
  }

  /** Encode a list for a request body. */
  public static <T> List<Object> encodeList(List<T> values, Function<T, Object> encode) {
    List<Object> out = new ArrayList<>(values.size());
    for (T value : values) {
      out.add(encode.apply(value));
    }
    return out;
  }

  /**
   * A paginated method's base query, plus the parameters the paginator advances.
   *
   * <p>The paginator's parameters win, because they are the ones that change per page — a base
   * {@code offset} would otherwise pin every request to the first page. A {@code LinkedHashMap}
   * rather than {@code Map.of}, because an omitted optional parameter is a null value and {@code
   * Map.of} rejects those.
   */
  public static Map<String, Object> merged(Map<String, ?> base, Map<String, ?> advancing) {
    LinkedHashMap<String, Object> out = new LinkedHashMap<>(base);
    out.putAll(advancing);
    return out;
  }

  /** Encode a map for a request body. */
  public static <T> Map<String, Object> encodeMap(
      Map<String, T> values, Function<T, Object> encode) {
    LinkedHashMap<String, Object> out = new LinkedHashMap<>();
    values.forEach((key, value) -> out.put(key, encode.apply(value)));
    return out;
  }
}
