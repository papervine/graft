package besdk.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class ValidateTest {

  private static List<String> check(Object value, String descriptor) {
    return Validate.check(value, Schema.of(descriptor), Map.of());
  }

  @Test
  void acceptsMatchingPrimitives() {
    assertTrue(check("x", "{\"k\":\"str\"}").isEmpty());
    assertTrue(check(1L, "{\"k\":\"int\"}").isEmpty());
    assertTrue(check(1.5, "{\"k\":\"num\"}").isEmpty());
    assertTrue(check(Boolean.TRUE, "{\"k\":\"bool\"}").isEmpty());
    assertTrue(check(null, "{\"k\":\"null\",\"i\":{\"k\":\"str\"}}").isEmpty());
  }

  @Test
  void namesTheFieldAndBothTypes() {
    List<String> problems =
        check(Map.of("id", 42L), "{\"k\":\"obj\",\"f\":[[\"id\",{\"k\":\"str\"},1]]}");
    assertEquals(List.of("id should be a string but was an integer"), problems);
  }

  @Test
  void acceptsAWholeDoubleWhereAnIntegerIsDeclared() {
    // A JSON integer arrives as 1.0 from serialisers with no integer type. Rejecting that would
    // fail on data
    // that is actually correct.
    assertTrue(check(1.0, "{\"k\":\"int\"}").isEmpty());
    assertFalse(check(1.5, "{\"k\":\"int\"}").isEmpty());
  }

  @Test
  void reportsAMissingRequiredFieldButNotAMissingOptionalOne() {
    String schema = "{\"k\":\"obj\",\"f\":[[\"id\",{\"k\":\"str\"},1],[\"name\",{\"k\":\"str\"}]]}";
    assertEquals(List.of("id is missing"), check(Map.of("name", "x"), schema));
    assertTrue(check(Map.of("id", "x"), schema).isEmpty());
  }

  @Test
  void neverComplainsAboutUnknownFields() {
    // A server adding a field must not break a client. That is the whole point of an evolving API.
    assertTrue(
        check(
                Map.of("id", "x", "brandNew", 123L),
                "{\"k\":\"obj\",\"f\":[[\"id\",{\"k\":\"str\"},1]]}")
            .isEmpty());
  }

  @Test
  void treatsAnEmptyArrayAsAValidEmptyMap() {
    // The PHP empty-map artifact: a PHP backend serialises `{}` as `[]`, and that is a valid empty
    // map rather
    // than a wrong type.
    assertTrue(check(List.of(), "{\"k\":\"map\",\"v\":{\"k\":\"str\"}}").isEmpty());
    assertTrue(check(List.of(), "{\"k\":\"obj\",\"f\":[]}").isEmpty());
  }

  @Test
  void walksArraysAndReportsTheIndex() {
    List<String> problems = check(List.of("a", 2L), "{\"k\":\"arr\",\"i\":{\"k\":\"str\"}}");
    assertEquals(List.of("[1] should be a string but was an integer"), problems);
  }

  @Test
  void acceptsAnyBranchOfAUnionAndReportsOnceWhenNoneMatch() {
    String schema = "{\"k\":\"or\",\"o\":[{\"k\":\"str\"},{\"k\":\"int\"}]}";
    assertTrue(check("x", schema).isEmpty());
    assertTrue(check(3L, schema).isEmpty());
    // One message, not one per branch: a union of five reporting five problems buries the real one.
    assertEquals(1, check(Boolean.TRUE, schema).size());
  }

  @Test
  void terminatesOnASelfReferentialSchema() {
    // The cycle closes through the table rather than through recursion, so this is finite by
    // construction
    // rather than by a depth cap.
    Map<String, Schema> table =
        Schema.table(
            "{\"Node\":{\"k\":\"obj\",\"f\":[[\"child\",{\"k\":\"ref\",\"n\":\"Node\"}]]}}");
    Object value = Map.of("child", Map.of("child", Map.of("child", Map.of())));
    assertTrue(Validate.check(value, Schema.of("{\"k\":\"ref\",\"n\":\"Node\"}"), table).isEmpty());
  }

  @Test
  void treatsAMissingTableEntryAsAny() {
    // An incomplete table must not reject correct data.
    assertTrue(
        Validate.check(
                Map.of("anything", 1L), Schema.of("{\"k\":\"ref\",\"n\":\"Absent\"}"), Map.of())
            .isEmpty());
  }

  @Test
  void enforceThrowsInStrictModeAndIsSilentWhenOff() {
    Schema schema = Schema.of("{\"k\":\"obj\",\"f\":[[\"id\",{\"k\":\"str\"},1]]}");
    Object value = Map.of("id", 1L);
    Validate.enforce(value, schema, Map.of(), "widgets.get", ValidationMode.OFF);

    ResponseValidationException error =
        assertThrows(
            ResponseValidationException.class,
            () -> Validate.enforce(value, schema, Map.of(), "widgets.get", ValidationMode.STRICT));
    assertTrue(error.getMessage().contains("widgets.get"));
    assertEquals("widgets.get", error.operation());
  }

  @Test
  void aValidationFailureIsNotAnApiException() {
    // The server answered successfully; what failed is the contract between spec and
    // implementation. A caller
    // catching ApiException to handle "the API said no" must not swallow this.
    assertFalse(ApiException.class.isAssignableFrom(ResponseValidationException.class));
    assertTrue(SdkException.class.isAssignableFrom(ResponseValidationException.class));
  }
}
