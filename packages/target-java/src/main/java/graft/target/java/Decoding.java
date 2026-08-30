package graft.target.java;

/**
 * Generating the narrowing that turns a decoded JSON value into a typed field.
 *
 * <p>Its own class because the rules are per-type and there are enough of them that inlining would
 * bury the emitter. Each returns a statement or two, indented for a method body.
 */
final class Decoding {

  private Decoding() {}

  /**
   * Read one field into a local, narrowed to its declared type.
   *
   * <p>A <b>required</b> field of the wrong type throws, naming the field and what was expected —
   * the backstop for when validation is off, and a far better failure than a {@code
   * ClassCastException} from inside a constructor. An <b>optional</b> field of the wrong type
   * becomes null: it was already allowed to be absent, and the validator reports the mismatch with
   * the field name in strict mode.
   */
  static String local(Models.Property property, String owner, String arg, TypeMapper types) {
    String raw = property.name() + "Raw";
    String type = property.type();
    StringBuilder out = new StringBuilder();
    out.append("    Object ")
        .append(raw)
        .append(" = map.get(")
        .append(Source.quote(property.wireName()))
        .append(");\n");

    String value = narrow(type, raw, property, owner, types);
    out.append("    ")
        .append(type)
        .append(' ')
        .append(property.name())
        .append(" = ")
        .append(value)
        .append(";\n");
    return out.toString();
  }

  private static String narrow(
      String type, String raw, Models.Property property, String owner, TypeMapper types) {
    String missing =
        "Support.fail(" + Source.quote(owner) + ", " + Source.quote(property.wireName()) + ", ";
    return switch (type) {
      case "String" ->
          property.required()
              ? raw + " instanceof String s ? s : " + missing + Source.quote("a string") + ")"
              : raw + " instanceof String s ? s : null";
      case "long" ->
          raw
              + " instanceof Number n ? n.longValue() : "
              + missing
              + Source.quote("an integer")
              + ")";
      case "Long" -> raw + " instanceof Number n ? Long.valueOf(n.longValue()) : null";
      case "int" ->
          raw
              + " instanceof Number n ? n.intValue() : "
              + missing
              + Source.quote("an integer")
              + ")";
      case "Integer" -> raw + " instanceof Number n ? Integer.valueOf(n.intValue()) : null";
      case "double" ->
          raw
              + " instanceof Number n ? n.doubleValue() : "
              + missing
              + Source.quote("a number")
              + ")";
      case "Double" -> raw + " instanceof Number n ? Double.valueOf(n.doubleValue()) : null";
      case "boolean" ->
          raw + " instanceof Boolean b ? b : " + missing + Source.quote("a boolean") + ")";
      case "Boolean" -> raw + " instanceof Boolean b ? b : null";
      case "Instant" -> "Support.instant(" + raw + ")";
      case "Object" -> raw;
      default -> nested(type, raw, property, types);
    };
  }

  private static String nested(
      String type, String raw, Models.Property property, TypeMapper types) {
    if (type.startsWith("List<")) {
      String element = type.substring(5, type.length() - 1);
      return "Support.list(" + raw + ", " + decoderRef(element, types) + ")";
    }
    if (type.startsWith("Map<String, ")) {
      String element = type.substring(12, type.length() - 1);
      return "Support.mapOf(" + raw + ", " + decoderRef(element, types) + ")";
    }
    // An enum has `fromWire`, not `fromJson` — and `fromWire` returns null for a member the server
    // added
    // after generation, which is the open-enum rule. Calling `fromJson` on one does not compile,
    // which is how
    // this was found; in a language without a compiler it would have been a runtime failure.
    if (types.isEnumName(type)) {
      return type + ".fromWire(" + raw + " instanceof String s ? s : null)";
    }
    return property.required()
        ? type + ".fromJson(" + raw + ")"
        : "(" + raw + " == null ? null : " + type + ".fromJson(" + raw + "))";
  }

  /** A function reference that decodes one element of a collection. */
  private static String decoderRef(String element, TypeMapper types) {
    return switch (element) {
      case "String" -> "value -> value instanceof String s ? s : null";
      case "Long" -> "value -> value instanceof Number n ? Long.valueOf(n.longValue()) : null";
      case "Integer" -> "value -> value instanceof Number n ? Integer.valueOf(n.intValue()) : null";
      case "Double" ->
          "value -> value instanceof Number n ? Double.valueOf(n.doubleValue()) : null";
      case "Boolean" -> "value -> value instanceof Boolean b ? b : null";
      case "Object" -> "value -> value";
      case "Instant" -> "Support::instant";
      // A nested collection decodes with the same helpers, one level down.
      default -> {
        if (element.startsWith("List<") || element.startsWith("Map<")) {
          yield "value -> value";
        }
        yield types.isEnumName(element)
            ? "value -> " + element + ".fromWire(value instanceof String s ? s : null)"
            : element + "::fromJson";
      }
    };
  }

  /** Add one field to a request body's JSON tree, omitting nulls. */
  static String encode(Models.Property property) {
    String name = property.name();
    String type = property.type();
    if (Models.isPrimitive(type)) {
      // A required primitive cannot be null, so there is nothing to check.
      return "    out.put(" + Source.quote(property.wireName()) + ", " + name + ");\n";
    }
    String rendered = encodeValue(type, name);
    return "    if ("
        + name
        + " != null) {\n      out.put("
        + Source.quote(property.wireName())
        + ", "
        + rendered
        + ");\n    }\n";
  }

  private static String encodeValue(String type, String name) {
    if (type.equals("Instant")) {
      return name + ".toString()";
    }
    if (type.startsWith("List<")) {
      String element = type.substring(5, type.length() - 1);
      return "Support.encodeList(" + name + ", " + encoderRef(element) + ")";
    }
    if (type.startsWith("Map<String, ")) {
      String element = type.substring(12, type.length() - 1);
      return "Support.encodeMap(" + name + ", " + encoderRef(element) + ")";
    }
    return switch (type) {
      case "String", "Long", "Integer", "Double", "Boolean", "Object" -> name;
      // A named model or enum knows its own wire form.
      default -> "Support.encodeOne(" + name + ")";
    };
  }

  private static String encoderRef(String element) {
    return switch (element) {
      case "String", "Long", "Integer", "Double", "Boolean", "Object" -> "value -> value";
      case "Instant" -> "value -> value.toString()";
      default -> "Support::encodeOne";
    };
  }
}
