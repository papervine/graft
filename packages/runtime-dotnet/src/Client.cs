using System.Globalization;

namespace Graft.Runtime;

/// <summary>
/// The transport every generated resource calls into.
/// </summary>
/// <remarks>
/// Hand-written, and the reason generated code stays thin (<c>AGENTS.md</c>). Everything here is shared by
/// every operation in every SDK this target produces, so it is worth reading rather than generating.
/// </remarks>
public class Client
{
  /// <summary>
  /// Methods safe to replay without an idempotency key, per HTTP's own definition.
  /// </summary>
  /// <remarks>
  /// <c>DELETE</c> is included deliberately: a second delete returning 404 is a <i>correct</i> outcome, not a
  /// failure. <c>POST</c> and <c>PATCH</c> are absent — see the replayability rule below (SPEC.md §3.4.0.1).
  /// </remarks>
  private static readonly HashSet<string> IdempotentMethods =
      new(StringComparer.Ordinal) { "GET", "HEAD", "PUT", "DELETE", "OPTIONS" };

  /// <summary>Not standardised — <c>X-Idempotency-Key</c> and <c>Idempotency-Token</c> are also in real use.</summary>
  public const string DefaultIdempotencyHeader = "Idempotency-Key";

  private readonly ITransport _transport;
  private readonly int _maxRetries;
  private readonly Func<TimeSpan, CancellationToken, Task> _delay;

  public Client(ClientOptions options)
  {
    BaseUrl = options.BaseUrl;
    Auth = options.Auth ?? NoAuth.Instance;
    Timeout = options.Timeout ?? TimeSpan.FromSeconds(60);
    // Clamped rather than trusted: a negative value made the Python retry loop run zero times, so every
    // request failed with "no recorded error" (SPEC.md §3.3.3).
    _maxRetries = Math.Max(0, options.MaxRetries);
    DefaultHeaders = options.DefaultHeaders;
    _transport = options.Transport ?? new HttpClientTransport();
    UserAgent = options.UserAgent;
    ValidationMode = options.Validation;
    IdempotencyHeader = options.IdempotencyHeader ?? DefaultIdempotencyHeader;
    _delay = options.Delay ?? ((duration, token) => Task.Delay(duration, token));
  }

  public string BaseUrl { get; }

  public IAuth Auth { get; }

  public TimeSpan Timeout { get; }

  public IReadOnlyDictionary<string, string> DefaultHeaders { get; }

  public string UserAgent { get; }

  public ValidationMode ValidationMode { get; }

  public string IdempotencyHeader { get; }

  /// <summary>Send a request, retrying what is safe to retry.</summary>
  public async Task<HttpResponseSpec> RequestAsync(
      string method,
      string path,
      IReadOnlyDictionary<string, object?> query,
      string? body,
      RequestOptions? options,
      string contentType = "application/json",
      CancellationToken cancellationToken = default,
      byte[]? bodyBytes = null)
  {
    var verb = method.ToUpperInvariant();
    // `HeadersFor` decides whether to set a content type from whether there *is* a body, so it has to see
    // the byte form too — otherwise a multipart request went out with no content type at all.
    var bodyForHeaders = body ?? (bodyBytes is not null ? string.Empty : null);
    var applied = await Auth
        .ApplyAsync(
            HeadersFor(bodyForHeaders, options, contentType), Query.Flatten(query), cancellationToken)
        .ConfigureAwait(false);
    var url = Query.Url(BaseUrl, path, applied.Query);
    var spec = new HttpRequestSpec(verb, url, applied.Headers, body, applied.Query)
    {
      BodyBytes = bodyBytes,
    };

    var attempts = (options?.MaxRetries ?? _maxRetries) + 1;
    var perAttempt = options?.Timeout ?? Timeout;
    var refreshed = false;
    SdkException? lastError = null;

    for (var attempt = 1; attempt <= attempts; attempt++)
    {
      // Checked here rather than left to the transport. A cancelled request must abort immediately even if
      // a transport ignores the token — and, more importantly, cancellation must not burn retries: without
      // this, a caller who cancelled would wait through the whole backoff schedule first.
      cancellationToken.ThrowIfCancellationRequested();

      HttpResponseSpec response;
      try
      {
        response = await _transport.SendAsync(spec, perAttempt, cancellationToken).ConfigureAwait(false);
      }
      catch (ConnectionException error)
      {
        // A request that never completed left no side effect, so replaying it is safe regardless of
        // method — the one retry case idempotency does not gate.
        lastError = error;
        if (attempt == attempts)
        {
          throw;
        }

        await BackoffAsync(attempt, null, cancellationToken).ConfigureAwait(false);
        continue;
      }

      if (response.StatusCode < 400)
      {
        return response;
      }

      var apiError = ErrorFor(response);

      // A 401 buys one forced refresh and one retry: clocks disagree and servers revoke tokens early, so
      // a token this client believes is valid may not be (SPEC.md §3.1.6).
      if (response.StatusCode == 401 && Auth is OAuth2Auth oauth && !refreshed)
      {
        refreshed = true;
        oauth.Invalidate();
        var retryAuth = await Auth
            .ApplyAsync(HeadersFor(body, options, contentType), Query.Flatten(query), cancellationToken)
            .ConfigureAwait(false);
        spec = new HttpRequestSpec(verb, url, retryAuth.Headers, body, retryAuth.Query)
        {
          BodyBytes = bodyBytes,
        };
        continue;
      }

      if (attempt == attempts || !ShouldRetry(response.StatusCode, verb, options))
      {
        throw apiError;
      }

      lastError = apiError;
      var retryAfter = apiError is RateLimitException rate ? rate.RetryAfter : null;
      await BackoffAsync(attempt, retryAfter, cancellationToken).ConfigureAwait(false);
    }

    // Unreachable: every path above returns or throws. Present because the compiler cannot prove it, and an
    // implicit null return would be a worse failure than an explicit one.
    throw lastError ?? new ConnectionException("request failed with no recorded error");
  }

  /// <summary>Send a request and decode JSON.</summary>
  /// <remarks>
  /// <para>
  /// <paramref name="contentType"/> describes the *request* body; the response is decoded as JSON either
  /// way. It exists for <c>application/x-www-form-urlencoded</c>, which a spec asks for on plenty of write
  /// operations and which was previously sent as JSON — a request the server rejects.
  /// </para>
  /// </remarks>
  public async Task<object?> RequestJsonAsync(
      string method,
      string path,
      IReadOnlyDictionary<string, object?> query,
      string? body,
      RequestOptions? options,
      CancellationToken cancellationToken = default,
      string contentType = "application/json")
  {
    var response = await RequestAsync(method, path, query, body, options, contentType, cancellationToken)
        .ConfigureAwait(false);
    return string.IsNullOrWhiteSpace(response.Body) ? null : Json.Parse(response.Body);
  }

  /// <summary>As <see cref="RequestJsonAsync(string, string, IReadOnlyDictionary{string, object}, string, RequestOptions, CancellationToken, string)"/> with a byte body, for a multipart upload.</summary>
  public async Task<object?> RequestJsonAsync(
      string method,
      string path,
      IReadOnlyDictionary<string, object?> query,
      byte[] bodyBytes,
      RequestOptions? options,
      string contentType,
      CancellationToken cancellationToken = default)
  {
    var response = await RequestAsync(
            method, path, query, null, options, contentType, cancellationToken, bodyBytes)
        .ConfigureAwait(false);
    return string.IsNullOrWhiteSpace(response.Body) ? null : Json.Parse(response.Body);
  }

  /// <summary>
  /// Send a request and return both the decoded body and the raw response.
  /// </summary>
  /// <remarks>
  /// The paginator needs both: items come from the body, and a total count may arrive in a header
  /// (<c>X-Content-Range</c>), which returning only the body would make unreachable.
  /// </remarks>
  public async Task<RawPage> RequestPageAsync(
      string method,
      string path,
      IReadOnlyDictionary<string, object?> query,
      RequestOptions? options,
      CancellationToken cancellationToken = default)
  {
    var response = await RequestAsync(method, path, query, null, options, "application/json", cancellationToken)
        .ConfigureAwait(false);
    var body = string.IsNullOrWhiteSpace(response.Body) ? null : Json.Parse(response.Body);
    return new RawPage(body, response);
  }

  /// <summary>
  /// Whether a failed request may be sent again.
  /// </summary>
  /// <remarks>
  /// Two conditions, and both matter. The status must be one where retrying could plausibly help, <i>and</i>
  /// the request must be replayable — a <c>POST</c> that returned 503 may well have been processed before the
  /// failure, so resending it blind is how one call becomes three charges (SPEC.md §3.4.0.1).
  /// </remarks>
  private static bool ShouldRetry(int status, string method, RequestOptions? options) =>
      RetryableStatus(status) && Replayable(method, options);

  private static bool RetryableStatus(int status) =>
      // 501 excluded: an unimplemented method stays unimplemented.
      status is 408 or 409 or 429 || (status >= 500 && status != 501);

  /// <summary>
  /// <c>POST</c> and <c>PATCH</c> are replayable only with an idempotency key, because deduplication has to
  /// happen on the server — a client cannot make a replay safe by itself.
  /// </summary>
  private static bool Replayable(string method, RequestOptions? options) =>
      IdempotentMethods.Contains(method) || options?.IdempotencyKey is not null;

  private Dictionary<string, string> HeadersFor(string? body, RequestOptions? options, string contentType)
  {
    var headers = new Dictionary<string, string>
    {
      ["Accept"] = "application/json",
      ["User-Agent"] = UserAgent,
    };

    foreach (var (name, value) in DefaultHeaders)
    {
      headers[name] = value;
    }

    if (body is not null)
    {
      headers["Content-Type"] = contentType;
    }

    if (options is not null)
    {
      foreach (var (name, value) in options.Headers)
      {
        headers[name] = value;
      }

      if (options.IdempotencyKey is not null)
      {
        headers[IdempotencyHeader] = options.IdempotencyKey;
      }
    }

    return headers;
  }

  /// <summary>Full jitter exponential backoff, capped. Prevents synchronised retry storms across clients.</summary>
  private Task BackoffAsync(int attempt, TimeSpan? retryAfter, CancellationToken cancellationToken)
  {
    if (retryAfter is not null)
    {
      return _delay(retryAfter.Value, cancellationToken);
    }

    var capped = Math.Min(8000d, 500d * Math.Pow(2, attempt - 1));
    var jittered = Random.Shared.NextDouble() * capped;
    return _delay(TimeSpan.FromMilliseconds(jittered), cancellationToken);
  }

  private static ApiException ErrorFor(HttpResponseSpec response)
  {
    object? body = null;
    if (!string.IsNullOrWhiteSpace(response.Body))
    {
      try
      {
        body = Json.Parse(response.Body);
      }
      catch (DecodeException)
      {
        // A non-JSON error body is common — an HTML 502 from a proxy. The status still classifies it.
        body = null;
      }
    }

    var message = "request failed";
    if (body is IDictionary<string, object?> map)
    {
      foreach (var key in new[] { "message", "error", "detail", "error_description" })
      {
        if (map.TryGetValue(key, out var candidate) && candidate is string text && text.Length > 0)
        {
          message = text;
          break;
        }
      }
    }

    // The server's own words, with no status prefix. Prefixing made the same failure read differently in
    // each language, which the cross-language suite caught (SPEC.md §3.4.2).
    var requestId = response.Header("x-request-id") ?? response.Header("request-id");
    var status = response.StatusCode;
    var headers = response.Headers;

    return status switch
    {
      400 => new BadRequestException(status, message, requestId, body, headers),
      401 => new AuthenticationException(status, message, requestId, body, headers),
      403 => new PermissionDeniedException(status, message, requestId, body, headers),
      404 => new NotFoundException(status, message, requestId, body, headers),
      409 => new ConflictException(status, message, requestId, body, headers),
      422 => new UnprocessableEntityException(status, message, requestId, body, headers),
      429 => new RateLimitException(status, message, requestId, body, headers, RetryAfter(response)),
      _ => status >= 500
          ? new InternalServerException(status, message, requestId, body, headers)
          : new ApiException(status, message, requestId, body, headers),
    };
  }

  private static TimeSpan? RetryAfter(HttpResponseSpec response)
  {
    var header = response.Header("retry-after");
    if (header is null)
    {
      return null;
    }

    // `Retry-After` may also be an HTTP date. Unparsed rather than guessed: the backoff already has a
    // sensible default, and a wrong parse would be worse than none.
    return double.TryParse(header.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds)
        ? TimeSpan.FromSeconds(seconds)
        : null;
  }
}

/// <summary>
/// How a <see cref="Client"/> is configured.
/// </summary>
/// <remarks>
/// <c>init</c> properties rather than a builder, and a required <c>BaseUrl</c> so the one value with no sensible
/// default cannot be forgotten.
/// </remarks>
public sealed record ClientOptions
{
  public required string BaseUrl { get; init; }

  public IAuth? Auth { get; init; }

  public TimeSpan? Timeout { get; init; }

  public int MaxRetries { get; init; } = 2;

  public IReadOnlyDictionary<string, string> DefaultHeaders { get; init; } = new Dictionary<string, string>();

  /// <summary>Inject one to test without real network calls.</summary>
  public ITransport? Transport { get; init; }

  /// <summary>Role-named default: this string reaches every request's User-Agent header (SPEC.md §1.2).</summary>
  public string UserAgent { get; init; } = "sdk-dotnet";

  public ValidationMode Validation { get; init; } = ValidationMode.Strict;

  public string? IdempotencyHeader { get; init; }

  /// <summary>How the client waits between retries. Injected so a test does not actually sleep.</summary>
  public Func<TimeSpan, CancellationToken, Task>? Delay { get; init; }
}
