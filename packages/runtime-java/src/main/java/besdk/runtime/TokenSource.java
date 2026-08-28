package besdk.runtime;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

/**
 * Fetches and refreshes an access token.
 *
 * <p><b>Single-flight, under a lock.</b> Java has real threads and a client is shared across them,
 * so two threads discovering an expired token at once would both refresh — spending two token
 * requests and, with providers that invalidate the previous token, breaking one of them. The cache
 * is re-checked <em>inside</em> the lock for the same reason: a thread that waited must not refresh
 * again on the basis of what it saw before waiting. This is the same shape as the TypeScript,
 * Python, and Go runtimes; PHP is the exception, because its execution model makes the race
 * impossible (SPEC.md §3.3.7).
 *
 * <p>Refreshing is proactive rather than on failure: waiting for a 401 spends a real request to
 * discover something the expiry time already said.
 */
public final class TokenSource {

  /** Refresh this far before expiry, because clocks disagree and a token in flight can expire. */
  private static final Duration EXPIRY_SKEW = Duration.ofSeconds(30);

  /**
   * What a provider that omits {@code expires_in} gets. Treating an absent expiry as "never" would
   * cache a dead token.
   */
  private static final Duration DEFAULT_LIFETIME = Duration.ofHours(1);

  private final OAuth2Config config;
  private final Transport transport;
  private final Duration timeout;
  private final Supplier<Instant> clock;
  private final Object lock = new Object();

  private String accessToken;
  private Instant expiresAt;

  public TokenSource(OAuth2Config config, Transport transport) {
    this(config, transport, Duration.ofSeconds(30), Instant::now);
  }

  /** {@code clock} is injected so a test can advance time without sleeping. */
  public TokenSource(
      OAuth2Config config, Transport transport, Duration timeout, Supplier<Instant> clock) {
    this.config = config;
    this.transport = transport;
    this.timeout = timeout;
    this.clock = clock;
  }

  public String token() {
    synchronized (lock) {
      Instant now = clock.get();
      if (accessToken != null && expiresAt != null && now.isBefore(expiresAt.minus(EXPIRY_SKEW))) {
        return accessToken;
      }
      return fetch();
    }
  }

  /** Drop the cached token, so the next call fetches a fresh one. Used by the 401-retry path. */
  public void invalidate() {
    synchronized (lock) {
      accessToken = null;
      expiresAt = null;
    }
  }

  private String fetch() {
    Map<String, String> form = new LinkedHashMap<>();
    if (config.refreshToken() != null) {
      form.put("grant_type", "refresh_token");
      form.put("refresh_token", config.refreshToken());
    } else {
      form.put("grant_type", "client_credentials");
    }
    if (!config.scopes().isEmpty()) {
      form.put("scope", String.join(" ", config.scopes()));
    }

    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("Content-Type", "application/x-www-form-urlencoded");
    headers.put("Accept", "application/json");
    // Credentials in the Authorization header when both are present: that is the form every
    // provider
    // accepts, where in-body credentials are optional in the spec and unevenly implemented.
    if (config.clientId() != null && config.clientSecret() != null) {
      String credentials = config.clientId() + ":" + config.clientSecret();
      headers.put(
          "Authorization",
          "Basic "
              + java.util.Base64.getEncoder()
                  .encodeToString(credentials.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    } else if (config.clientId() != null) {
      form.put("client_id", config.clientId());
    }

    StringBuilder encoded = new StringBuilder();
    for (Map.Entry<String, String> entry : form.entrySet()) {
      if (encoded.length() > 0) {
        encoded.append('&');
      }
      encoded
          .append(
              java.net.URLEncoder.encode(entry.getKey(), java.nio.charset.StandardCharsets.UTF_8))
          .append('=')
          .append(
              java.net.URLEncoder.encode(
                  entry.getValue(), java.nio.charset.StandardCharsets.UTF_8));
    }

    HttpResponseSpec response =
        transport.send(
            new HttpRequestSpec("POST", config.tokenUrl(), headers, encoded.toString(), Map.of()),
            timeout);

    if (response.statusCode() < 200 || response.statusCode() >= 300) {
      // Never retried: a 400 from a token endpoint means the credentials are wrong, and retrying
      // wrong
      // credentials is how an account gets locked.
      String detail = response.body() == null ? "" : response.body();
      throw new OAuth2Exception(
          "token request failed with "
              + response.statusCode()
              + ": "
              + detail.substring(0, Math.min(500, detail.length())));
    }

    Object decoded = Json.parse(response.body());
    if (!(decoded instanceof Map<?, ?> map) || !(map.get("access_token") instanceof String token)) {
      throw new OAuth2Exception("token response had no string access_token");
    }
    accessToken = token;
    Object expiresIn = map.get("expires_in");
    Duration lifetime =
        expiresIn instanceof Number number
            ? Duration.ofSeconds(number.longValue())
            : DEFAULT_LIFETIME;
    expiresAt = clock.get().plus(lifetime);
    return token;
  }
}
