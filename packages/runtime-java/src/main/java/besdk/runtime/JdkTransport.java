package besdk.runtime;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The JDK's own HTTP client.
 *
 * <p>{@code java.net.http} has been in the JDK since 11, so a generated SDK needs no HTTP
 * dependency — which is the same reasoning that keeps JSON hand-written here (SPEC.md §3.3.9).
 *
 * <p>The client is shared across requests and never closed. That is correct for a connection pool:
 * closing it per request would defeat keep-alive, and the JDK client holds no resources that
 * require explicit release.
 */
public final class JdkTransport implements Transport {

  private final HttpClient client;

  public JdkTransport() {
    this(
        HttpClient.newBuilder()
            // Redirects are not followed: a redirect on an API call is a misconfiguration worth
            // seeing,
            // and following one silently can replay an authenticated request to another host.
            .followRedirects(HttpClient.Redirect.NEVER)
            .connectTimeout(Duration.ofSeconds(10))
            .build());
  }

  public JdkTransport(HttpClient client) {
    this.client = client;
  }

  @Override
  public HttpResponseSpec send(HttpRequestSpec request, Duration timeout) {
    HttpRequest.Builder builder =
        HttpRequest.newBuilder(URI.create(request.url())).timeout(timeout);

    // A body of null means "no body"; `noBody()` rather than an empty publisher, so a GET does not
    // acquire
    // a `Content-Length: 0` header that some servers reject.
    HttpRequest.BodyPublisher publisher;
    if (request.bodyBytes() != null) {
      // Bytes, not text: a multipart payload carries file content, and a round trip through a Java
      // String would corrupt anything that is not valid UTF-8.
      publisher = HttpRequest.BodyPublishers.ofByteArray(request.bodyBytes());
    } else if (request.body() == null) {
      publisher = HttpRequest.BodyPublishers.noBody();
    } else {
      publisher = HttpRequest.BodyPublishers.ofString(request.body());
    }
    builder.method(request.method().toUpperCase(java.util.Locale.ROOT), publisher);

    for (Map.Entry<String, String> header : request.headers().entrySet()) {
      // `Content-Length` and `Host` are restricted by the JDK and set by it; passing them through
      // throws.
      String name = header.getKey().toLowerCase(java.util.Locale.ROOT);
      if (name.equals("content-length") || name.equals("host") || name.equals("connection")) {
        continue;
      }
      builder.header(header.getKey(), header.getValue());
    }

    try {
      HttpResponse<String> response =
          client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
      Map<String, String> headers = new LinkedHashMap<>();
      response
          .headers()
          .map()
          .forEach(
              (name, values) -> {
                if (!values.isEmpty()) {
                  headers.put(name.toLowerCase(java.util.Locale.ROOT), values.get(0));
                }
              });
      return new HttpResponseSpec(response.statusCode(), response.body(), headers);
    } catch (java.net.http.HttpTimeoutException error) {
      throw new TimeoutException("request timed out after " + timeout, error);
    } catch (IOException error) {
      throw new ConnectionException(
          error.getMessage() == null ? "request failed" : error.getMessage(), error);
    } catch (InterruptedException error) {
      // Restoring the flag is not optional: swallowing it strands any caller waiting on this
      // thread's
      // interruption, and it is the one thing every reviewer looks for here.
      Thread.currentThread().interrupt();
      throw new ConnectionException("request interrupted", error);
    }
  }
}
