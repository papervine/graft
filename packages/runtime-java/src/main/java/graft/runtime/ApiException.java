package graft.runtime;

import java.util.Map;

/**
 * The server responded, and said no.
 *
 * <p>Always carries a status. Connection failures live on their own branch precisely so that stays
 * true — otherwise every caller reading {@code statusCode()} would need a check for a case that
 * never has one.
 *
 * <p><b>Serialisation.</b> {@code Throwable} is {@code Serializable}, so {@code -Xlint:serial}
 * warns about every field whose declared type is an interface. These exceptions are never
 * serialised: Java exception serialisation exists for RMI, which no SDK path uses, and a serialised
 * API error is meaningless without the client that produced it. Suppressed narrowly rather than
 * making the fields {@code transient} — which would imply the data is deliberately discarded — or
 * narrowing the accessors to {@code LinkedHashMap}, which would leak an implementation choice into
 * a public API.
 */
@SuppressWarnings("serial")
public class ApiException extends SdkException {

  private static final long serialVersionUID = 1L;

  private final int statusCode;
  private final String requestId;
  private final Object body;
  private final Map<String, String> headers;

  public ApiException(
      int statusCode, String message, String requestId, Object body, Map<String, String> headers) {
    super(message);
    this.statusCode = statusCode;
    this.requestId = requestId;
    this.body = body;
    this.headers = headers == null ? Map.of() : Map.copyOf(headers);
  }

  public int statusCode() {
    return statusCode;
  }

  /** The server's request id, when it sent one. Null otherwise — the caller cannot invent it. */
  public String requestId() {
    return requestId;
  }

  /** The decoded error body, as a tree. Null when the response had none. */
  public Object body() {
    return body;
  }

  public Map<String, String> headers() {
    return headers;
  }
}
