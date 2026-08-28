package besdk.runtime;

import java.time.Duration;
import java.util.Map;

/**
 * Per-call overrides.
 *
 * <p>A builder rather than a constructor, for the reason that governs this whole target: Java has
 * neither keyword nor default arguments, so four optional fields would mean either a telescoping
 * constructor set or a call site of positional nulls (SPEC.md §3.3.9).
 */
public final class RequestOptions {

  private final Duration timeout;
  private final Integer maxRetries;
  private final Map<String, String> headers;
  private final String idempotencyKey;

  private RequestOptions(Builder builder) {
    this.timeout = builder.timeout;
    this.maxRetries = builder.maxRetries;
    this.headers = Map.copyOf(builder.headers);
    this.idempotencyKey = builder.idempotencyKey;
  }

  public static Builder builder() {
    return new Builder();
  }

  public Duration timeout() {
    return timeout;
  }

  public Integer maxRetries() {
    return maxRetries;
  }

  public Map<String, String> headers() {
    return headers;
  }

  /** Makes a POST or PATCH safe to retry. See {@code Client}'s replayability rules. */
  public String idempotencyKey() {
    return idempotencyKey;
  }

  /** Fluent builder. */
  public static final class Builder {

    private Duration timeout;
    private Integer maxRetries;
    private Map<String, String> headers = Map.of();
    private String idempotencyKey;

    private Builder() {}

    public Builder timeout(Duration value) {
      this.timeout = value;
      return this;
    }

    public Builder maxRetries(int value) {
      this.maxRetries = value;
      return this;
    }

    public Builder headers(Map<String, String> value) {
      this.headers = value == null ? Map.of() : value;
      return this;
    }

    /**
     * Supply an idempotency key, which is what makes a {@code POST} or {@code PATCH} retryable.
     *
     * <p>Deduplication happens on the server; a client cannot make a replay safe by itself.
     */
    public Builder idempotencyKey(String value) {
      this.idempotencyKey = value;
      return this;
    }

    public RequestOptions build() {
      return new RequestOptions(this);
    }
  }
}
