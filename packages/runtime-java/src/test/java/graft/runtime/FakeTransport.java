package graft.runtime;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * A transport that replays scripted responses and records what it was asked to send.
 *
 * <p>The existence of this class is the point of {@link Transport} being an interface: without it,
 * testing code that uses a generated SDK means making real network calls.
 */
final class FakeTransport implements Transport {

  final List<HttpRequestSpec> requests = new ArrayList<>();
  private final List<Object> script;

  /**
   * Entries are consumed in order; the last one repeats. A {@code SdkException} entry is thrown.
   */
  FakeTransport(List<Object> script) {
    this.script = new ArrayList<>(script);
  }

  @Override
  public HttpResponseSpec send(HttpRequestSpec request, Duration timeout) {
    requests.add(request);
    Object next = script.size() > 1 ? script.remove(0) : script.get(0);
    if (next instanceof SdkException error) {
      throw error;
    }
    if (next instanceof HttpResponseSpec response) {
      return response;
    }
    throw new IllegalStateException("FakeTransport ran out of scripted responses");
  }

  static HttpResponseSpec json(int status, String body) {
    return new HttpResponseSpec(status, body, Map.of("content-type", "application/json"));
  }

  static HttpResponseSpec json(int status, String body, Map<String, String> headers) {
    Map<String, String> all = new java.util.LinkedHashMap<>(headers);
    all.put("content-type", "application/json");
    return new HttpResponseSpec(status, body, all);
  }
}
