package besdk.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class QueryTest {

  /** A generated enum, which carries a wire value distinct from its Java name. */
  private enum Kind implements Query.WireValued {
    MEMBER("member");

    private final String wire;

    Kind(String wire) {
      this.wire = wire;
    }

    @Override
    public String wireValue() {
      return wire;
    }
  }

  @Test
  void omitsNullButKeepsFalse() {
    // `?active=false` is a meaningful filter; omitting the parameter is a different request.
    Map<String, Object> params = new LinkedHashMap<>();
    params.put("active", Boolean.FALSE);
    params.put("other", null);
    assertEquals(Map.of("active", List.of("false")), Query.flatten(params));
  }

  @Test
  void repeatsTheKeyForACollection() {
    assertEquals(Map.of("tag", List.of("a", "b")), Query.flatten(Map.of("tag", List.of("a", "b"))));
    assertEquals(
        "https://x/y?tag=a&tag=b",
        Query.url("https://x", "/y", Query.flatten(Map.of("tag", List.of("a", "b")))));
  }

  @Test
  void sendsNothingForAnEmptyCollection() {
    assertEquals(Map.of(), Query.flatten(Map.of("tag", List.of())));
  }

  @Test
  void anEnumSendsItsWireValue() {
    // The bug this pins came from PHP, where an enum fell through to a JSON encoder and arrived as
    // `"member"` with literal quotes while every other language sent `member`. Handled explicitly
    // here.
    assertEquals(Map.of("kind", List.of("member")), Query.flatten(Map.of("kind", Kind.MEMBER)));
    assertEquals(
        Map.of("kind", List.of("member")), Query.flatten(Map.of("kind", List.of(Kind.MEMBER))));
  }

  @Test
  void aTimestampIsIso8601() {
    assertEquals(
        Map.of("since", List.of("2026-01-02T03:04:05Z")),
        Query.flatten(Map.of("since", Instant.parse("2026-01-02T03:04:05Z"))));
  }

  @Test
  void pathParametersArePercentEncoded() {
    // An id containing a slash must not escape its segment and reach a different endpoint.
    assertEquals(
        "/orgs/a%2Fb/invoices/i1",
        Query.path("/orgs/{org}/invoices/{id}", Map.of("org", "a/b", "id", "i1")));
  }

  @Test
  void aSpaceInAPathIsPercentTwentyNotPlus() {
    // `URLEncoder` is form encoding: it renders a space as `+`, which is correct in a query string
    // and wrong
    // in a path.
    assertEquals("/x/a%20b", Query.path("/x/{k}", Map.of("k", "a b")));
  }
}
