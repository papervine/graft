package graft.runtime;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JSON parsing and serialisation, hand-written and dependency-free.
 *
 * <p>Not Jackson, and the reasoning is in SPEC.md §3.3.9: a generated SDK is a <em>library</em>,
 * and a library that pins Jackson creates version skew with whatever the consuming application
 * already has. It is why Stripe's Java SDK shades its JSON library rather than depending on one.
 *
 * <p>What makes this tractable is how narrow the job is. There is no annotation processing, no
 * reflection, and no polymorphic binding: parse a response into a tree of {@code Map}, {@code
 * List}, {@code String}, {@code Long}, {@code Double}, {@code Boolean}, and {@code null}, and
 * serialise a request from the same. Generated models carry explicit decoders, exactly as the PHP
 * target's {@code fromArray} does.
 *
 * <p>Three risks this takes on, each named rather than discovered, and each tested:
 *
 * <ul>
 *   <li><b>Escapes</b>, including {@code \\uXXXX} surrogate pairs for characters outside the BMP.
 *   <li><b>Numeric precision.</b> An integer that fits in a {@code long} becomes one; anything else
 *       becomes a {@code double}, and an integer too large for {@code long} keeps its magnitude
 *       rather than overflowing silently.
 *   <li><b>Depth.</b> A recursive-descent parser on deeply nested input would overflow the stack,
 *       so nesting is capped and reported as a {@link DecodeException} rather than an {@link
 *       StackOverflowError}.
 * </ul>
 */
public final class Json {

  /**
   * How deep a document may nest.
   *
   * <p>512 is far beyond any real API response and far below the default stack depth. The point is
   * that a hostile or broken document produces a catchable exception naming the problem, where
   * {@code StackOverflowError} is an {@code Error} that most code neither catches nor recovers
   * from.
   */
  private static final int MAX_DEPTH = 512;

  private Json() {}

  /** Parse a JSON document into a tree. */
  public static Object parse(String text) {
    Parser parser = new Parser(text);
    parser.skipWhitespace();
    Object value = parser.value(0);
    parser.skipWhitespace();
    if (!parser.atEnd()) {
      throw new DecodeException("unexpected trailing content at offset " + parser.offset());
    }
    return value;
  }

  /** Serialise a tree to JSON. */
  public static String write(Object value) {
    StringBuilder out = new StringBuilder();
    writeValue(out, value, 0);
    return out.toString();
  }

  // -- writing --------------------------------------------------------------

  private static void writeValue(StringBuilder out, Object value, int depth) {
    if (depth > MAX_DEPTH) {
      throw new DecodeException("value nests deeper than " + MAX_DEPTH + " levels");
    }
    if (value == null) {
      out.append("null");
    } else if (value instanceof String s) {
      writeString(out, s);
    } else if (value instanceof Boolean b) {
      out.append(b ? "true" : "false");
    } else if (value instanceof Double || value instanceof Float) {
      double d = ((Number) value).doubleValue();
      if (Double.isNaN(d) || Double.isInfinite(d)) {
        // JSON has no way to express either, and emitting the bare word would produce a document no
        // parser accepts. Failing here names the field the caller set.
        throw new DecodeException("cannot serialise " + d + " as JSON");
      }
      // A whole double renders as `1.0` from `toString`, which is valid JSON and reads oddly in a
      // request body; `1` is what every other language sends for the same value.
      if (d == Math.rint(d) && Math.abs(d) < 1e15) {
        out.append((long) d);
      } else {
        out.append(d);
      }
    } else if (value instanceof Number n) {
      out.append(n);
    } else if (value instanceof Map<?, ?> map) {
      out.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        if (!first) {
          out.append(',');
        }
        first = false;
        writeString(out, String.valueOf(entry.getKey()));
        out.append(':');
        writeValue(out, entry.getValue(), depth + 1);
      }
      out.append('}');
    } else if (value instanceof Iterable<?> items) {
      out.append('[');
      boolean first = true;
      for (Object item : items) {
        if (!first) {
          out.append(',');
        }
        first = false;
        writeValue(out, item, depth + 1);
      }
      out.append(']');
    } else if (value instanceof JsonValue custom) {
      writeValue(out, custom.toJson(), depth + 1);
    } else {
      throw new DecodeException("cannot serialise " + value.getClass().getName() + " as JSON");
    }
  }

  private static void writeString(StringBuilder out, String value) {
    out.append('"');
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        case '\b' -> out.append("\\b");
        case '\f' -> out.append("\\f");
        default -> {
          // Control characters must be escaped; everything else is emitted as-is, so UTF-8 output
          // stays
          // readable rather than becoming a wall of `é`.
          if (c < 0x20) {
            out.append(String.format("\\u%04x", (int) c));
          } else {
            out.append(c);
          }
        }
      }
    }
    out.append('"');
  }

  /** Something that knows its own JSON tree. Generated request models implement this. */
  public interface JsonValue {
    Object toJson();
  }

  // -- parsing --------------------------------------------------------------

  private static final class Parser {
    private final String text;
    private int index;

    Parser(String text) {
      this.text = text;
    }

    int offset() {
      return index;
    }

    boolean atEnd() {
      return index >= text.length();
    }

    void skipWhitespace() {
      while (index < text.length()) {
        char c = text.charAt(index);
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
          index++;
        } else {
          return;
        }
      }
    }

    Object value(int depth) {
      if (depth > MAX_DEPTH) {
        throw new DecodeException("document nests deeper than " + MAX_DEPTH + " levels");
      }
      if (atEnd()) {
        throw new DecodeException("unexpected end of document");
      }
      char c = text.charAt(index);
      return switch (c) {
        case '{' -> object(depth);
        case '[' -> array(depth);
        case '"' -> string();
        case 't' -> literal("true", Boolean.TRUE);
        case 'f' -> literal("false", Boolean.FALSE);
        case 'n' -> literal("null", null);
        default -> number();
      };
    }

    private Map<String, Object> object(int depth) {
      expect('{');
      // Insertion-ordered, so a re-serialised document keeps the server's field order.
      // Round-tripping a
      // body through a proxy should not reorder it.
      Map<String, Object> out = new LinkedHashMap<>();
      skipWhitespace();
      if (peek() == '}') {
        index++;
        return out;
      }
      while (true) {
        skipWhitespace();
        String key = string();
        skipWhitespace();
        expect(':');
        skipWhitespace();
        out.put(key, value(depth + 1));
        skipWhitespace();
        char next = peek();
        if (next == ',') {
          index++;
          continue;
        }
        expect('}');
        return out;
      }
    }

    private List<Object> array(int depth) {
      expect('[');
      List<Object> out = new ArrayList<>();
      skipWhitespace();
      if (peek() == ']') {
        index++;
        return out;
      }
      while (true) {
        skipWhitespace();
        out.add(value(depth + 1));
        skipWhitespace();
        char next = peek();
        if (next == ',') {
          index++;
          continue;
        }
        expect(']');
        return out;
      }
    }

    private String string() {
      expect('"');
      StringBuilder out = new StringBuilder();
      while (true) {
        if (atEnd()) {
          throw new DecodeException("unterminated string");
        }
        char c = text.charAt(index++);
        if (c == '"') {
          return out.toString();
        }
        if (c != '\\') {
          out.append(c);
          continue;
        }
        if (atEnd()) {
          throw new DecodeException("unterminated escape");
        }
        char escape = text.charAt(index++);
        switch (escape) {
          case '"' -> out.append('"');
          case '\\' -> out.append('\\');
          case '/' -> out.append('/');
          case 'b' -> out.append('\b');
          case 'f' -> out.append('\f');
          case 'n' -> out.append('\n');
          case 'r' -> out.append('\r');
          case 't' -> out.append('\t');
          case 'u' -> out.append(unicode());
          default -> throw new DecodeException("invalid escape \\" + escape);
        }
      }
    }

    /**
     * A {@code \\uXXXX} escape.
     *
     * <p>Appended as a {@code char} rather than a code point, which is what makes surrogate pairs
     * work: an emoji arrives as two consecutive escapes, and appending each half in order
     * reassembles it, because that is exactly how Java stores it.
     */
    private char unicode() {
      if (index + 4 > text.length()) {
        throw new DecodeException("truncated \\u escape");
      }
      String hex = text.substring(index, index + 4);
      index += 4;
      try {
        return (char) Integer.parseInt(hex, 16);
      } catch (NumberFormatException error) {
        throw new DecodeException("invalid \\u escape: " + hex);
      }
    }

    private Object number() {
      int start = index;
      if (peek() == '-' || peek() == '+') {
        index++;
      }
      boolean fractional = false;
      while (!atEnd()) {
        char c = text.charAt(index);
        if (c >= '0' && c <= '9') {
          index++;
        } else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
          fractional = fractional || c == '.' || c == 'e' || c == 'E';
          index++;
        } else {
          break;
        }
      }
      String raw = text.substring(start, index);
      if (raw.isEmpty() || raw.equals("-")) {
        throw new DecodeException("expected a value at offset " + start);
      }
      if (!fractional) {
        try {
          return Long.parseLong(raw);
        } catch (NumberFormatException overflow) {
          // An integer larger than `long` keeps its magnitude as a double rather than wrapping to a
          // negative number, which is the failure mode of a silent narrowing cast.
          return Double.parseDouble(raw);
        }
      }
      try {
        return Double.parseDouble(raw);
      } catch (NumberFormatException error) {
        throw new DecodeException("invalid number: " + raw);
      }
    }

    private Object literal(String word, Object result) {
      if (!text.startsWith(word, index)) {
        throw new DecodeException("invalid literal at offset " + index);
      }
      index += word.length();
      return result;
    }

    private char peek() {
      return atEnd() ? '\0' : text.charAt(index);
    }

    private void expect(char c) {
      if (atEnd() || text.charAt(index) != c) {
        throw new DecodeException("expected '" + c + "' at offset " + index);
      }
      index++;
    }
  }
}
