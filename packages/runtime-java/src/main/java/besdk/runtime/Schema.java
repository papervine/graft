package besdk.runtime;

import java.util.List;
import java.util.Map;

/**
 * One validation descriptor.
 *
 * <p>A sealed interface with a record per kind, which is the one place Java expresses this better
 * than every other target: {@code switch} over a sealed type is checked for exhaustiveness at
 * compile time, so adding a descriptor kind without handling it is a compile error rather than a
 * silent fall-through (SPEC.md §3.3.9).
 *
 * <p>Generated code builds these from the descriptor table it ships. The table is data, and this
 * hand-written walker interprets it — one reviewed interpreter beats a validator generated per
 * type.
 */
public sealed interface Schema {

  /** Accepts anything. What an unmodelled or unreachable type degrades to. */
  record Any() implements Schema {}

  record Str() implements Schema {}

  /** An RFC 3339 timestamp. Validated as a string; the model decodes it. */
  record Date() implements Schema {}

  record Num() implements Schema {}

  record Int() implements Schema {}

  record Bool() implements Schema {}

  record Arr(Schema items) implements Schema {}

  record MapOf(Schema values) implements Schema {}

  /** {@code null} is permitted in addition to {@code inner}. */
  record Nullable(Schema inner) implements Schema {}

  /**
   * Any one branch matching is enough. `anyOf` and `oneOf` validate identically (SPEC.md §3.1.7).
   */
  record Or(List<Schema> branches) implements Schema {}

  /** A reference into the table, which is how a cycle terminates without recursing forever. */
  record Ref(String name) implements Schema {}

  record Obj(List<Field> fields, Schema additional) implements Schema {}

  /** One field of an object. */
  record Field(String wireName, Schema schema, boolean required) {}

  /** Parse the compact JSON form the generated table ships in. */
  static Map<String, Schema> table(String json) {
    return SchemaParser.table(json);
  }

  /** Parse one compact descriptor. */
  static Schema of(String json) {
    return SchemaParser.one(json);
  }
}
