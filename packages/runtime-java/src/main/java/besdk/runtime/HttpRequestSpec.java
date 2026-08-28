package besdk.runtime;

import java.util.List;
import java.util.Map;

/**
 * One HTTP exchange, as this runtime models it.
 *
 * <p>A record rather than a builder: every field is required at the point of construction, and the
 * runtime is the only thing that builds these.
 *
 * @param body the request body as text, or null when there is none or when {@code bodyBytes}
 *     carries it
 * @param bodyBytes the request body as bytes, for a multipart payload; null otherwise
 * @param query already flattened to repeated values; see {@link Query#flatten}
 */
public record HttpRequestSpec(
    String method,
    String url,
    Map<String, String> headers,
    String body,
    byte[] bodyBytes,
    Map<String, List<String>> query) {

  /**
   * A text body, which is every request except a multipart upload.
   *
   * <p>The overload exists so the multipart path is the *only* caller that has to think about
   * bytes. A multipart body cannot go through {@code body}: encoding arbitrary file content as a
   * Java {@code String} and back is lossy, so an uploaded PNG would arrive corrupted with nothing
   * to indicate it.
   */
  public HttpRequestSpec(
      String method,
      String url,
      Map<String, String> headers,
      String body,
      Map<String, List<String>> query) {
    this(method, url, headers, body, null, query);
  }

  /** Whether this request carries a body at all, in either form. */
  public boolean hasBody() {
    return body != null || bodyBytes != null;
  }
}
