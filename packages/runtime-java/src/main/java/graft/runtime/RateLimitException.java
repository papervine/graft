package graft.runtime;

import java.time.Duration;
import java.util.Map;

/** A 429. Carries {@code retryAfter} when the server said how long to wait. */
public final class RateLimitException extends ApiException {

  private static final long serialVersionUID = 1L;

  private final Duration retryAfter;

  public RateLimitException(
      int statusCode,
      String message,
      String requestId,
      Object body,
      Map<String, String> headers,
      Duration retryAfter) {
    super(statusCode, message, requestId, body, headers);
    this.retryAfter = retryAfter;
  }

  /** How long the server asked us to wait, or null when it did not say. */
  public Duration retryAfter() {
    return retryAfter;
  }
}
