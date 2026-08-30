using System.Net;
using System.Net.Http.Headers;

namespace Graft.Runtime;

/// <summary>One HTTP exchange, as this runtime models it.</summary>
/// <remarks>
/// <c>Query</c> is already flattened to repeated values by <c>Query.Flatten</c>. Documented in prose rather
/// than with a single <c>param</c> tag, because C# requires that documenting one parameter means documenting
/// all of them — a rule the generated code has to respect too, so the emitter documents every parameter or
/// none.
/// </remarks>
public sealed record HttpRequestSpec(
    string Method,
    string Url,
    IReadOnlyDictionary<string, string> Headers,
    string? Body,
    IReadOnlyDictionary<string, IReadOnlyList<string>> Query)
{
  /// <summary>
  /// The request body as bytes, for a multipart payload. Null for every other request.
  /// </summary>
  /// <remarks>
  /// An init-only property rather than a positional component, so existing construction sites and any
  /// transport a user wrote keep compiling. A multipart body cannot travel through <see cref="Body"/>:
  /// file content is not text, and a round trip through a .NET string corrupts anything that is not
  /// valid UTF-8 — which is most of what anyone uploads.
  /// </remarks>
  public byte[]? BodyBytes { get; init; }
}

/// <summary>A response, with header names lowercased on the way in.</summary>
public sealed record HttpResponseSpec(
    int StatusCode,
    string Body,
    IReadOnlyDictionary<string, string> Headers)
{
  /// <summary>A header by name, case-insensitively. Null when absent.</summary>
  public string? Header(string name) =>
      Headers.TryGetValue(name.ToLowerInvariant(), out var value) ? value : null;
}

/// <summary>
/// How a request is actually sent.
/// </summary>
/// <remarks>
/// An interface so a caller can inject their own — without it, testing code that uses a generated SDK means
/// making real network calls, which is not a nicety (SPEC.md §3.3.2).
/// </remarks>
public interface ITransport
{
  Task<HttpResponseSpec> SendAsync(
      HttpRequestSpec request,
      TimeSpan timeout,
      CancellationToken cancellationToken = default);
}

/// <summary>
/// <see cref="HttpClient"/>, which ships with .NET.
/// </summary>
/// <remarks>
/// <para>
/// The client is shared across requests and never disposed per call. That is not an oversight: a
/// <c>using</c> per request exhausts sockets under load, which is among the most-reported .NET bugs, and the
/// handler pool is what makes keep-alive work.
/// </para>
/// <para>
/// The whole surface is async because <see cref="HttpClient"/> has no synchronous API worth using —
/// <c>.Result</c> on a <see cref="Task"/> deadlocks in several hosting models (SPEC.md §3.3.11).
/// </para>
/// </remarks>
public sealed class HttpClientTransport : ITransport
{
  private readonly HttpClient _client;

  public HttpClientTransport()
      : this(new HttpClient(new HttpClientHandler
      {
        // A redirect on an API call is a misconfiguration worth seeing, and following one silently can
        // replay an authenticated request to another host.
        AllowAutoRedirect = false,
      }))
  {
  }

  public HttpClientTransport(HttpClient client)
  {
    _client = client;
    // Timeouts are per-request here, applied through a linked CancellationToken, so the client-wide one is
    // disabled. Leaving both would make the shorter of the two win in a way no caller asked for.
    _client.Timeout = System.Threading.Timeout.InfiniteTimeSpan;
  }

  public async Task<HttpResponseSpec> SendAsync(
      HttpRequestSpec request,
      TimeSpan timeout,
      CancellationToken cancellationToken = default)
  {
    using var message = new HttpRequestMessage(new HttpMethod(request.Method), request.Url);
    if (request.BodyBytes is not null)
    {
      // Bytes, not text: see `HttpRequestSpec.BodyBytes`.
      message.Content = new ByteArrayContent(request.BodyBytes);
      message.Content.Headers.ContentType = null;
    }
    else if (request.Body is not null)
    {
      message.Content = new StringContent(request.Body);
      // Set on the content, not the request: `Content-Type` is a content header and .NET rejects it on
      // the request itself.
      message.Content.Headers.ContentType = null;
    }

    foreach (var (name, value) in request.Headers)
    {
      if (string.Equals(name, "Content-Type", StringComparison.OrdinalIgnoreCase))
      {
        if (message.Content is not null)
        {
          message.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(value);
        }

        continue;
      }

      if (!message.Headers.TryAddWithoutValidation(name, value) && message.Content is not null)
      {
        message.Content.Headers.TryAddWithoutValidation(name, value);
      }
    }

    using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
    timeoutSource.CancelAfter(timeout);

    try
    {
      using var response = await _client
          .SendAsync(message, HttpCompletionOption.ResponseContentRead, timeoutSource.Token)
          .ConfigureAwait(false);

      var body = await response.Content.ReadAsStringAsync(timeoutSource.Token).ConfigureAwait(false);
      var headers = new Dictionary<string, string>();
      foreach (var (name, values) in response.Headers)
      {
        var first = values.FirstOrDefault();
        if (first is not null)
        {
          headers[name.ToLowerInvariant()] = first;
        }
      }

      foreach (var (name, values) in response.Content.Headers)
      {
        var first = values.FirstOrDefault();
        if (first is not null)
        {
          headers[name.ToLowerInvariant()] = first;
        }
      }

      return new HttpResponseSpec((int)response.StatusCode, body, headers);
    }
    catch (OperationCanceledException error) when (!cancellationToken.IsCancellationRequested)
    {
      // Distinguished from a caller's own cancellation by checking *their* token: .NET reports both as
      // OperationCanceledException, and conflating them would report a user's abort as a timeout.
      throw new TimeoutException($"request timed out after {timeout}", error);
    }
    catch (HttpRequestException error)
    {
      throw new ConnectionException(error.Message, error);
    }
  }
}
