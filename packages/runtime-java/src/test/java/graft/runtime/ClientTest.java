package graft.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

final class ClientTest {

  /** No sleeping: the backoff is exercised, the wall clock is not. */
  private static Client client(FakeTransport transport, int maxRetries) {
    return Client.builder()
        .baseUrl("https://api.test")
        .auth(new BearerAuth("t"))
        .maxRetries(maxRetries)
        .transport(transport)
        .sleeper(duration -> {})
        .build();
  }

  @Test
  void sendsAuthAndDefaultHeaders() {
    FakeTransport transport = new FakeTransport(List.of(FakeTransport.json(200, "{\"ok\":true}")));
    client(transport, 2).request("GET", "/things", Map.of(), null, null, "application/json");

    HttpRequestSpec request = transport.requests.get(0);
    assertEquals("Bearer t", request.headers().get("Authorization"));
    assertEquals("application/json", request.headers().get("Accept"));
    assertEquals("https://api.test/things", request.url());
  }

  @Test
  void mapsStatusesToTypedExceptions() {
    FakeTransport transport =
        new FakeTransport(List.of(FakeTransport.json(404, "{\"message\":\"no such thing\"}")));
    NotFoundException error =
        assertThrows(
            NotFoundException.class,
            () ->
                client(transport, 2)
                    .request("GET", "/things/x", Map.of(), null, null, "application/json"));
    assertEquals(404, error.statusCode());
    // The server's own words, with no status prefix — the cross-language suite pins this.
    assertEquals("no such thing", error.getMessage());
  }

  @Test
  void readsRetryAfterOnRateLimit() {
    FakeTransport transport =
        new FakeTransport(
            List.of(FakeTransport.json(429, "{\"message\":\"slow\"}", Map.of("retry-after", "2"))));
    RateLimitException error =
        assertThrows(
            RateLimitException.class,
            () ->
                client(transport, 0)
                    .request("GET", "/things", Map.of(), null, null, "application/json"));
    assertEquals(Duration.ofSeconds(2), error.retryAfter());
  }

  @Test
  void leavesRetryAfterNullWhenItIsAnHttpDate() {
    // Unparsed rather than guessed: the backoff already has a sensible default, and a wrong parse
    // would be
    // worse than none.
    FakeTransport transport =
        new FakeTransport(
            List.of(
                FakeTransport.json(
                    429, "{}", Map.of("retry-after", "Wed, 21 Oct 2026 07:28:00 GMT"))));
    RateLimitException error =
        assertThrows(
            RateLimitException.class,
            () ->
                client(transport, 0)
                    .request("GET", "/things", Map.of(), null, null, "application/json"));
    assertNull(error.retryAfter());
  }

  // -- retry safety by method (SPEC.md §3.4.0.1) -----------------------------

  @ParameterizedTest
  @ValueSource(strings = {"GET", "HEAD", "PUT", "DELETE", "OPTIONS"})
  void retriesMethodsHttpDefinesAsIdempotent(String method) {
    FakeTransport transport = new FakeTransport(List.of(FakeTransport.json(503, "{}")));
    assertThrows(
        InternalServerException.class,
        () ->
            client(transport, 2)
                .request(method, "/things", Map.of(), null, null, "application/json"));
    assertEquals(3, transport.requests.size(), method + " should be retried");
  }

  @Test
  void doesNotRetryPostWithoutAnIdempotencyKey() {
    // The bug this pins: a `POST /charges` returning 503 was sent three times, and whether the
    // server
    // processed the first is unknowable from here. The plausible outcome was three charges.
    FakeTransport transport = new FakeTransport(List.of(FakeTransport.json(503, "{}")));
    assertThrows(
        InternalServerException.class,
        () ->
            client(transport, 2)
                .request("POST", "/charges", Map.of(), "{}", null, "application/json"));
    assertEquals(1, transport.requests.size());
  }

  @Test
  void retriesPostWithAnIdempotencyKeyAndResendsItUnchanged() {
    FakeTransport transport = new FakeTransport(List.of(FakeTransport.json(503, "{}")));
    RequestOptions options = RequestOptions.builder().idempotencyKey("req_1").build();
    assertThrows(
        InternalServerException.class,
        () ->
            client(transport, 2)
                .request("POST", "/charges", Map.of(), "{}", options, "application/json"));
    assertEquals(3, transport.requests.size());
    for (HttpRequestSpec request : transport.requests) {
      // Deduplication happens on the server, so the key must be identical on every attempt.
      assertEquals("req_1", request.headers().get(Client.DEFAULT_IDEMPOTENCY_HEADER));
      assertEquals("{}", request.body());
    }
  }

  @Test
  void doesNotRetryA400EvenWithAKey() {
    // A 400 was understood and rejected. Resending it is pure load on someone else's service.
    FakeTransport transport = new FakeTransport(List.of(FakeTransport.json(400, "{}")));
    RequestOptions options = RequestOptions.builder().idempotencyKey("k").build();
    assertThrows(
        BadRequestException.class,
        () ->
            client(transport, 2)
                .request("POST", "/things", Map.of(), "{}", options, "application/json"));
    assertEquals(1, transport.requests.size());
  }

  @Test
  void retriesAConnectionFailureRegardlessOfMethod() {
    // A request that never completed left no side effect, so replaying it is safe even for POST —
    // the one
    // retry case an idempotency key does not gate.
    FakeTransport transport = new FakeTransport(List.of(new ConnectionException("reset")));
    assertThrows(
        ConnectionException.class,
        () ->
            client(transport, 2)
                .request("POST", "/things", Map.of(), "{}", null, "application/json"));
    assertEquals(3, transport.requests.size());
  }

  @Test
  void honoursAConfiguredIdempotencyHeader() {
    FakeTransport transport = new FakeTransport(List.of(FakeTransport.json(200, "{}")));
    Client custom =
        Client.builder()
            .baseUrl("https://api.test")
            .transport(transport)
            .idempotencyHeader("X-Idempotency-Key")
            .sleeper(duration -> {})
            .build();
    custom.request(
        "POST",
        "/things",
        Map.of(),
        "{}",
        RequestOptions.builder().idempotencyKey("k").build(),
        "application/json");
    assertEquals("k", transport.requests.get(0).headers().get("X-Idempotency-Key"));
  }

  @Test
  void clampsANegativeRetryCount() {
    // -1 made the Python retry loop run zero times, so every request failed with "no recorded
    // error".
    FakeTransport transport = new FakeTransport(List.of(FakeTransport.json(200, "{}")));
    Client custom =
        Client.builder().baseUrl("https://api.test").maxRetries(-1).transport(transport).build();
    custom.request("GET", "/things", Map.of(), null, null, "application/json");
    assertEquals(1, transport.requests.size());
  }

  @Test
  void treatsAnEmptyBodyAsNull() {
    FakeTransport transport = new FakeTransport(List.of(new HttpResponseSpec(204, "", Map.of())));
    assertNull(client(transport, 0).requestJson("DELETE", "/things/x", Map.of(), null, null));
  }

  @Test
  void classifiesANonJsonErrorBodyByStatusAlone() {
    // An HTML 502 from a proxy is common. The status still classifies it; the body is simply
    // absent.
    FakeTransport transport =
        new FakeTransport(List.of(new HttpResponseSpec(502, "<html>bad gateway</html>", Map.of())));
    InternalServerException error =
        assertThrows(
            InternalServerException.class,
            () ->
                client(transport, 0)
                    .request("GET", "/things", Map.of(), null, null, "application/json"));
    assertEquals(502, error.statusCode());
    assertNull(error.body());
  }
}
