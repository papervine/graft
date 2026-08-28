package besdk.runtime;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;

/**
 * The transport every generated resource calls into.
 *
 * <p>Hand-written, and the reason generated code stays thin ({@code AGENTS.md}). Everything here is
 * shared by every operation in every SDK this target produces, so it is worth reading rather than
 * generating.
 */
public class Client {

  /**
   * Methods safe to replay without an idempotency key, per HTTP's own definition.
   *
   * <p>{@code DELETE} is included deliberately: a second delete returning 404 is a <em>correct</em>
   * outcome, not a failure. {@code POST} and {@code PATCH} are absent — see {@link #replayable}
   * (SPEC.md §3.4.0.1).
   */
  private static final Set<String> IDEMPOTENT_METHODS =
      Set.of("GET", "HEAD", "PUT", "DELETE", "OPTIONS");

  /**
   * Not standardised — {@code X-Idempotency-Key} and {@code Idempotency-Token} are also in real
   * use.
   */
  public static final String DEFAULT_IDEMPOTENCY_HEADER = "Idempotency-Key";

  private final String baseUrl;
  private final Auth auth;
  private final Duration timeout;
  private final int maxRetries;
  private final Map<String, String> defaultHeaders;
  private final Transport transport;
  private final String userAgent;
  private final ValidationMode validation;
  private final String idempotencyHeader;
  private final Sleeper sleeper;

  Client(Builder builder) {
    this.baseUrl = builder.baseUrl;
    this.auth = builder.auth == null ? Auth.NONE : builder.auth;
    this.timeout = builder.timeout == null ? Duration.ofSeconds(60) : builder.timeout;
    // Clamped rather than trusted: a negative value made the Python retry loop run zero times, so
    // every
    // request failed with "no recorded error" (SPEC.md §3.3.3).
    this.maxRetries = Math.max(0, builder.maxRetries);
    this.defaultHeaders = Map.copyOf(builder.defaultHeaders);
    this.transport = builder.transport == null ? new JdkTransport() : builder.transport;
    // Role-named, not brand-named: this string reaches every request's User-Agent header, so a
    // generator
    // name here would be visible to every server every SDK ever talks to (SPEC.md §1.2). A
    // generated client
    // always supplies its own, derived from the service; this is only the fallback.
    this.userAgent = builder.userAgent == null ? "sdk-java" : builder.userAgent;
    this.validation = builder.validation == null ? ValidationMode.STRICT : builder.validation;
    this.idempotencyHeader =
        builder.idempotencyHeader == null ? DEFAULT_IDEMPOTENCY_HEADER : builder.idempotencyHeader;
    this.sleeper = builder.sleeper == null ? Client::sleepFor : builder.sleeper;
  }

  public static Builder builder() {
    return new Builder();
  }

  public ValidationMode validationMode() {
    return validation;
  }

  public String baseUrl() {
    return baseUrl;
  }

  /** Send a request, retrying what is safe to retry. */
  public HttpResponseSpec request(
      String method,
      String path,
      Map<String, ?> query,
      String body,
      RequestOptions options,
      String contentType) {
    return request(method, path, query, body, null, options, contentType);
  }

  /**
   * Send a request whose body is bytes rather than text.
   *
   * <p>For a multipart payload only. A file's content is not text, so routing it through the {@code
   * String} body would corrupt anything that is not valid UTF-8 — most of what anyone uploads.
   */
  public HttpResponseSpec request(
      String method,
      String path,
      Map<String, ?> query,
      String body,
      byte[] bodyBytes,
      RequestOptions options,
      String contentType) {
    String verb = method.toUpperCase(java.util.Locale.ROOT);
    // `headersFor` decides whether to set a content type from whether there *is* a body, so it
    // needs to
    // see the byte form too — otherwise a multipart request went out with no content type at all.
    String bodyForHeaders = body != null ? body : (bodyBytes != null ? "" : null);
    Auth.Applied applied =
        auth.apply(headersFor(bodyForHeaders, options, contentType), Query.flatten(query));
    String url = Query.url(baseUrl, path, applied.query());
    HttpRequestSpec spec =
        new HttpRequestSpec(verb, url, applied.headers(), body, bodyBytes, applied.query());

    int attempts =
        (options != null && options.maxRetries() != null ? options.maxRetries() : maxRetries) + 1;
    Duration perAttempt =
        options != null && options.timeout() != null ? options.timeout() : timeout;
    boolean refreshed = false;
    SdkException lastError = null;

    for (int attempt = 1; attempt <= attempts; attempt++) {
      HttpResponseSpec response;
      try {
        response = transport.send(spec, perAttempt);
      } catch (ConnectionException error) {
        // A request that never completed left no side effect, so replaying it is safe regardless of
        // method
        // — the one retry case idempotency does not gate.
        lastError = error;
        if (attempt == attempts) {
          throw error;
        }
        backoff(attempt, null);
        continue;
      }

      if (response.statusCode() < 400) {
        return response;
      }

      ApiException error = errorFor(response);

      // A 401 buys one forced refresh and one retry: clocks disagree and servers revoke tokens
      // early, so a
      // token this client believes is valid may not be (SPEC.md §3.1.6).
      if (response.statusCode() == 401 && auth instanceof OAuth2Auth oauth && !refreshed) {
        refreshed = true;
        oauth.invalidate();
        Auth.Applied retryAuth =
            auth.apply(headersFor(body, options, contentType), Query.flatten(query));
        spec =
            new HttpRequestSpec(verb, url, retryAuth.headers(), body, bodyBytes, retryAuth.query());
        continue;
      }

      if (attempt == attempts || !shouldRetry(response.statusCode(), verb, options)) {
        throw error;
      }
      lastError = error;
      backoff(attempt, error instanceof RateLimitException rate ? rate.retryAfter() : null);
    }

    // Unreachable: every path above returns or throws. Present because the compiler cannot prove
    // it, and an
    // implicit null return would be a worse failure than an explicit one.
    throw lastError == null
        ? new ConnectionException("request failed with no recorded error")
        : lastError;
  }

  /** Send a request and decode JSON. */
  public Object requestJson(
      String method, String path, Map<String, ?> query, String body, RequestOptions options) {
    return requestJson(method, path, query, body, options, "application/json");
  }

  /**
   * Send a request whose body carries a declared content type, and decode a JSON response.
   *
   * <p>The overload exists for {@code application/x-www-form-urlencoded}, which a spec asks for on
   * plenty of write operations and which was previously sent as JSON — a request the server
   * rejects. The response is still JSON; only the request body differs.
   */
  public Object requestJson(
      String method,
      String path,
      Map<String, ?> query,
      String body,
      RequestOptions options,
      String contentType) {
    HttpResponseSpec response = request(method, path, query, body, options, contentType);
    if (response.body() == null || response.body().isBlank()) {
      return null;
    }
    return Json.parse(response.body());
  }

  /** As {@link #requestJson} with a byte body, for a multipart upload. */
  public Object requestJson(
      String method,
      String path,
      Map<String, ?> query,
      byte[] bodyBytes,
      RequestOptions options,
      String contentType) {
    HttpResponseSpec response = request(method, path, query, null, bodyBytes, options, contentType);
    if (response.body() == null || response.body().isBlank()) {
      return null;
    }
    return Json.parse(response.body());
  }

  /**
   * Send a request and return both the decoded body and the raw response.
   *
   * <p>The paginator needs both: items come from the body, and a total count may arrive in a header
   * ({@code X-Content-Range}), which returning only the body would make unreachable.
   */
  public Page.Raw requestPage(
      String method, String path, Map<String, ?> query, RequestOptions options) {
    HttpResponseSpec response = request(method, path, query, null, options, "application/json");
    Object body =
        response.body() == null || response.body().isBlank() ? null : Json.parse(response.body());
    return new Page.Raw(body, response);
  }

  /**
   * Whether a failed request may be sent again.
   *
   * <p>Two conditions, and both matter. The status must be one where retrying could plausibly help,
   * <em>and</em> the request must be replayable — a {@code POST} that returned 503 may well have
   * been processed before the failure, so resending it blind is how one call becomes three charges
   * (SPEC.md §3.4.0.1).
   */
  private boolean shouldRetry(int status, String method, RequestOptions options) {
    return retryableStatus(status) && replayable(method, options);
  }

  private static boolean retryableStatus(int status) {
    // 501 excluded: an unimplemented method stays unimplemented.
    return status == 408 || status == 409 || status == 429 || (status >= 500 && status != 501);
  }

  /**
   * {@code POST} and {@code PATCH} are replayable only with an idempotency key, because
   * deduplication has to happen on the server — a client cannot make a replay safe by itself.
   */
  private static boolean replayable(String method, RequestOptions options) {
    if (IDEMPOTENT_METHODS.contains(method)) {
      return true;
    }
    return options != null && options.idempotencyKey() != null;
  }

  private Map<String, String> headersFor(String body, RequestOptions options, String contentType) {
    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("Accept", "application/json");
    headers.put("User-Agent", userAgent);
    headers.putAll(defaultHeaders);
    if (body != null) {
      headers.put("Content-Type", contentType);
    }
    if (options != null) {
      headers.putAll(options.headers());
      if (options.idempotencyKey() != null) {
        headers.put(idempotencyHeader, options.idempotencyKey());
      }
    }
    return headers;
  }

  /** Full jitter exponential backoff, capped. Prevents synchronised retry storms across clients. */
  private void backoff(int attempt, Duration retryAfter) {
    if (retryAfter != null) {
      sleeper.sleep(retryAfter);
      return;
    }
    long capped = Math.min(8000L, (long) (500 * Math.pow(2, attempt - 1)));
    long jittered = ThreadLocalRandom.current().nextLong(capped + 1);
    sleeper.sleep(Duration.ofMillis(jittered));
  }

  private static void sleepFor(Duration duration) {
    try {
      Thread.sleep(duration.toMillis());
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new ConnectionException("retry wait interrupted", error);
    }
  }

  private ApiException errorFor(HttpResponseSpec response) {
    Object body = null;
    if (response.body() != null && !response.body().isBlank()) {
      try {
        body = Json.parse(response.body());
      } catch (DecodeException ignored) {
        // A non-JSON error body is common — an HTML 502 from a proxy. The status still classifies
        // it.
        body = null;
      }
    }
    String message = "request failed";
    if (body instanceof Map<?, ?> map) {
      for (String key : List.of("message", "error", "detail", "error_description")) {
        if (map.get(key) instanceof String candidate && !candidate.isBlank()) {
          message = candidate;
          break;
        }
      }
    }
    // The server's own words, with no status prefix. Prefixing made the same failure read
    // differently in
    // each language, which the cross-language suite caught (SPEC.md §3.4.2).
    String requestId = response.header("x-request-id");
    if (requestId == null) {
      requestId = response.header("request-id");
    }
    int status = response.statusCode();
    Map<String, String> headers = response.headers();
    return switch (status) {
      case 400 -> new BadRequestException(status, message, requestId, body, headers);
      case 401 -> new AuthenticationException(status, message, requestId, body, headers);
      case 403 -> new PermissionDeniedException(status, message, requestId, body, headers);
      case 404 -> new NotFoundException(status, message, requestId, body, headers);
      case 409 -> new ConflictException(status, message, requestId, body, headers);
      case 422 -> new UnprocessableEntityException(status, message, requestId, body, headers);
      case 429 ->
          new RateLimitException(status, message, requestId, body, headers, retryAfter(response));
      default ->
          status >= 500
              ? new InternalServerException(status, message, requestId, body, headers)
              : new ApiException(status, message, requestId, body, headers);
    };
  }

  private static Duration retryAfter(HttpResponseSpec response) {
    String header = response.header("retry-after");
    if (header == null) {
      return null;
    }
    try {
      return Duration.ofMillis((long) (Double.parseDouble(header.trim()) * 1000));
    } catch (NumberFormatException ignored) {
      // `Retry-After` may also be an HTTP date. Unparsed rather than guessed: the backoff already
      // has a
      // sensible default, and a wrong parse would be worse than none.
      return null;
    }
  }

  /** How the client waits between retries. Injected so a test does not actually sleep. */
  public interface Sleeper {
    void sleep(Duration duration);
  }

  /** Builder for a {@link Client}. Generated clients construct one and keep it private. */
  public static final class Builder {

    private String baseUrl = "";
    private Auth auth;
    private Duration timeout;
    private int maxRetries = 2;
    private Map<String, String> defaultHeaders = Map.of();
    private Transport transport;
    private String userAgent;
    private ValidationMode validation;
    private String idempotencyHeader;
    private Sleeper sleeper;

    private Builder() {}

    public Builder baseUrl(String value) {
      this.baseUrl = value;
      return this;
    }

    public Builder auth(Auth value) {
      this.auth = value;
      return this;
    }

    public Builder timeout(Duration value) {
      this.timeout = value;
      return this;
    }

    public Builder maxRetries(int value) {
      this.maxRetries = value;
      return this;
    }

    public Builder defaultHeaders(Map<String, String> value) {
      this.defaultHeaders = value == null ? Map.of() : value;
      return this;
    }

    public Builder transport(Transport value) {
      this.transport = value;
      return this;
    }

    public Builder userAgent(String value) {
      this.userAgent = value;
      return this;
    }

    public Builder validation(ValidationMode value) {
      this.validation = value;
      return this;
    }

    public Builder idempotencyHeader(String value) {
      this.idempotencyHeader = value;
      return this;
    }

    public Builder sleeper(Sleeper value) {
      this.sleeper = value;
      return this;
    }

    public Client build() {
      return new Client(this);
    }
  }
}
