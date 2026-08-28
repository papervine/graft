package besdk.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The hand-written JSON layer.
 *
 * <p>Written rather than depending on Jackson, because a library that pins Jackson creates version
 * skew with whatever the consuming application already has (SPEC.md §3.3.9). That decision is only
 * defensible if the three risks it takes on are actually covered, so each has a test here: escapes
 * including surrogate pairs, numeric precision, and nesting depth.
 */
final class JsonTest {

  @Test
  void parsesEachPrimitive() {
    assertEquals("x", Json.parse("\"x\""));
    assertEquals(1L, Json.parse("1"));
    assertEquals(1.5, Json.parse("1.5"));
    assertEquals(Boolean.TRUE, Json.parse("true"));
    assertNull(Json.parse("null"));
  }

  @Test
  void anIntegerBecomesALongAndAFractionBecomesADouble() {
    // The distinction matters downstream: `Schema.Int` accepts a long, and a model field typed
    // `long` cannot
    // take a Double without a cast that would silently truncate.
    assertInstanceOf(Long.class, Json.parse("42"));
    assertInstanceOf(Double.class, Json.parse("42.0"));
    assertInstanceOf(Double.class, Json.parse("1e3"));
  }

  @Test
  void anIntegerTooLargeForALongKeepsItsMagnitude() {
    // The failure mode this avoids is a silent narrowing wrap to a negative number, which is worse
    // than a
    // loss of precision because it changes the sign.
    Object huge = Json.parse("123456789012345678901234567890");
    assertInstanceOf(Double.class, huge);
    assertTrue(((Double) huge) > 1e29);
  }

  @Test
  void handlesEveryEscape() {
    assertEquals("a\"b", Json.parse("\"a\\\"b\""));
    assertEquals("a\\b", Json.parse("\"a\\\\b\""));
    assertEquals("a/b", Json.parse("\"a\\/b\""));
    assertEquals("a\nb", Json.parse("\"a\\nb\""));
    assertEquals("a\tb", Json.parse("\"a\\tb\""));
    assertEquals("\u00e9", Json.parse("\"\\u00e9\""));
  }

  @Test
  void reassemblesASurrogatePair() {
    // An emoji outside the BMP arrives as two consecutive `\\u` escapes. Appending each half as a
    // `char`
    // reassembles it, because that is exactly how Java stores it — a code-point-based reader would
    // produce
    // two replacement characters instead.
    String parsed = (String) Json.parse("\"\\ud83d\\ude80\"");
    assertEquals("\uD83D\uDE80", parsed);
    assertEquals(1, parsed.codePointCount(0, parsed.length()));
  }

  @Test
  void reportsExcessiveNestingRatherThanOverflowingTheStack() {
    // A recursive-descent parser on hostile input would raise StackOverflowError, which is an Error
    // that most
    // code neither catches nor recovers from. A DecodeException names the problem and is catchable.
    String deep = "[".repeat(2000) + "]".repeat(2000);
    DecodeException error = assertThrows(DecodeException.class, () -> Json.parse(deep));
    assertTrue(error.getMessage().contains("nests deeper"));
  }

  @Test
  void rejectsTrailingContent() {
    assertThrows(DecodeException.class, () -> Json.parse("{} {}"));
  }

  @Test
  void rejectsAnUnterminatedString() {
    assertThrows(DecodeException.class, () -> Json.parse("\"abc"));
  }

  @Test
  void preservesFieldOrder() {
    // Round-tripping a body through a proxy should not reorder it.
    Object parsed = Json.parse("{\"b\":1,\"a\":2}");
    assertEquals(List.of("b", "a"), List.copyOf(((Map<?, ?>) parsed).keySet()));
    assertEquals("{\"b\":1,\"a\":2}", Json.write(parsed));
  }

  @Test
  void writesAWholeDoubleWithoutATrailingZero() {
    // `1.0` is valid JSON but reads oddly in a request body, and every other language sends `1` for
    // the same
    // value — which the cross-language suite would flag.
    assertEquals("1", Json.write(1.0d));
    assertEquals("1.5", Json.write(1.5d));
  }

  @Test
  void escapesControlCharactersButNotPrintableUnicode() {
    assertEquals("\"a\\u0001b\"", Json.write("a\u0001b"));
    // Emitted as-is so UTF-8 output stays readable rather than becoming a wall of escapes.
    assertEquals("\"caf\u00e9\"", Json.write("caf\u00e9"));
  }

  @Test
  void refusesToSerialiseNanAndInfinity() {
    // JSON can express neither, and the bare word would produce a document no parser accepts.
    assertThrows(DecodeException.class, () -> Json.write(Double.NaN));
    assertThrows(DecodeException.class, () -> Json.write(Double.POSITIVE_INFINITY));
  }

  @Test
  void roundTripsANestedDocument() {
    String source = "{\"a\":[1,{\"b\":null},true],\"c\":\"x\"}";
    assertEquals(source, Json.write(Json.parse(source)));
  }
}
