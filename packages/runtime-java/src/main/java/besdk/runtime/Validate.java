package besdk.runtime;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Walks a response against its declared shape (SPEC.md §3.4.1.1).
 *
 * <p>Two things this deliberately never checks:
 *
 * <ul>
 *   <li><b>Unknown fields.</b> A server adding a field must not break a client. That is the whole
 *       point of an evolving API.
 *   <li><b>Enum membership.</b> Servers add enum values without warning, and the open-enum rule
 *       (§3.3.1) exists precisely so that does not break a client — checking membership here would
 *       reintroduce it.
 * </ul>
 */
public final class Validate {

  private Validate() {}

  /** Collect the ways {@code value} fails to match {@code schema}. */
  public static List<String> check(Object value, Schema schema, Map<String, Schema> table) {
    List<String> problems = new ArrayList<>();
    walk(value, schema, table, "", problems);
    return problems;
  }

  /** Throw when validation fails, honouring the mode. */
  public static void enforce(
      Object value,
      Schema schema,
      Map<String, Schema> table,
      String operation,
      ValidationMode mode) {
    if (mode == ValidationMode.OFF) {
      return;
    }
    List<String> problems = check(value, schema, table);
    if (problems.isEmpty()) {
      return;
    }
    if (mode == ValidationMode.WARN) {
      System.getLogger(Validate.class.getName())
          .log(
              System.Logger.Level.WARNING,
              operation + ": response did not match the declared shape — " + problems.get(0));
      return;
    }
    throw new ResponseValidationException(operation, problems);
  }

  private static void walk(
      Object value, Schema schema, Map<String, Schema> table, String path, List<String> problems) {
    String where = path.isEmpty() ? "the response" : path;
    // Exhaustive over a sealed type, so adding a descriptor kind without handling it is a compile
    // error.
    switch (schema) {
      case Schema.Any ignored -> {}
      case Schema.Str ignored ->
          expect(value instanceof String, where, "a string", value, problems);
      case Schema.Date ignored ->
          expect(value instanceof String, where, "a string", value, problems);
      case Schema.Num ignored ->
          expect(value instanceof Number, where, "a number", value, problems);
      case Schema.Int ignored ->
          // A JSON integer may arrive as a whole double from a serialiser with no integer type;
          // rejecting
          // that would fail on data that is correct.
          expect(isInteger(value), where, "an integer", value, problems);
      case Schema.Bool ignored ->
          expect(value instanceof Boolean, where, "a boolean", value, problems);
      case Schema.Nullable nullable -> {
        if (value != null) {
          walk(value, nullable.inner(), table, path, problems);
        }
      }
      case Schema.Arr array -> {
        if (!(value instanceof List<?> items)) {
          expect(false, where, "an array", value, problems);
          return;
        }
        for (int i = 0; i < items.size(); i++) {
          walk(items.get(i), array.items(), table, path + "[" + i + "]", problems);
        }
      }
      case Schema.MapOf mapOf -> {
        if (value instanceof List<?> empty && empty.isEmpty()) {
          // An empty map arrives as `[]` from a PHP backend, which is the artifact §3.1.2 names. A
          // valid
          // empty map, not a wrong type.
          return;
        }
        if (!(value instanceof Map<?, ?> map)) {
          expect(false, where, "an object", value, problems);
          return;
        }
        map.forEach(
            (key, item) ->
                walk(item, mapOf.values(), table, join(path, String.valueOf(key)), problems));
      }
      case Schema.Obj object -> walkObject(value, object, table, path, where, problems);
      case Schema.Or union -> {
        for (Schema branch : union.branches()) {
          if (check(value, branch, table).isEmpty()) {
            return;
          }
        }
        // One message rather than every branch's failure: a union of five reporting five problems
        // buries
        // the actual one.
        expect(false, where, "one of the declared shapes", value, problems);
      }
      case Schema.Ref ref -> {
        Schema target = table.get(ref.name());
        // A missing entry is treated as `any`: an incomplete table must not reject correct data. A
        // cycle
        // terminates here, through the table, rather than through recursion.
        if (target != null) {
          walk(value, target, table, path, problems);
        }
      }
    }
  }

  private static void walkObject(
      Object value,
      Schema.Obj object,
      Map<String, Schema> table,
      String path,
      String where,
      List<String> problems) {
    if (value instanceof List<?> empty && empty.isEmpty()) {
      // Same PHP artifact as above: `{}` serialised as `[]`.
      return;
    }
    if (!(value instanceof Map<?, ?> map)) {
      expect(false, where, "an object", value, problems);
      return;
    }
    for (Schema.Field field : object.fields()) {
      if (!map.containsKey(field.wireName())) {
        if (field.required()) {
          problems.add(join(path, field.wireName()) + " is missing");
        }
        continue;
      }
      walk(
          map.get(field.wireName()), field.schema(), table, join(path, field.wireName()), problems);
    }
    if (object.additional() != null) {
      List<String> known = object.fields().stream().map(Schema.Field::wireName).toList();
      map.forEach(
          (key, item) -> {
            if (!known.contains(String.valueOf(key))) {
              walk(item, object.additional(), table, join(path, String.valueOf(key)), problems);
            }
          });
    }
  }

  private static boolean isInteger(Object value) {
    if (value instanceof Long || value instanceof Integer || value instanceof Short) {
      return true;
    }
    return value instanceof Double d && d == Math.rint(d) && !d.isInfinite();
  }

  private static void expect(
      boolean ok, String where, String expected, Object actual, List<String> problems) {
    if (!ok) {
      problems.add(where + " should be " + expected + " but was " + describe(actual));
    }
  }

  /** What arrived, named the way JSON names it rather than the way Java does. */
  private static String describe(Object value) {
    if (value == null) {
      return "null";
    }
    if (value instanceof Boolean) {
      return "a boolean";
    }
    if (value instanceof Long || value instanceof Integer) {
      return "an integer";
    }
    if (value instanceof Number) {
      return "a number";
    }
    if (value instanceof String) {
      return "a string";
    }
    if (value instanceof List<?>) {
      return "an array";
    }
    if (value instanceof Map<?, ?>) {
      return "an object";
    }
    return "something else";
  }

  private static String join(String path, String segment) {
    return path.isEmpty() ? segment : path + "." + segment;
  }
}
