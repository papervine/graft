using System.Text;

namespace Graft.Runtime;

/// <summary>Configuration for an OAuth2 token source (SPEC.md §3.1.6).</summary>
public sealed record OAuth2Config
{
  public required string TokenUrl { get; init; }

  public string? ClientId { get; init; }

  public string? ClientSecret { get; init; }

  public string? RefreshToken { get; init; }

  public IReadOnlyList<string> Scopes { get; init; } = Array.Empty<string>();
}

/// <summary>
/// Fetches and refreshes an access token.
/// </summary>
/// <remarks>
/// <para>
/// <b>Single-flight, under a <see cref="SemaphoreSlim"/>.</b> A client is shared across requests and .NET has
/// real concurrency, so two callers discovering an expired token at once would both refresh — spending two token
/// requests and, with providers that invalidate the previous token, breaking one of them. The cache is
/// re-checked <i>inside</i> the lock, because a caller that waited must not refresh on the basis of what it saw
/// before waiting.
/// </para>
/// <para>
/// <see cref="SemaphoreSlim"/> rather than <c>lock</c>, because the critical section awaits: <c>lock</c> cannot
/// span an <c>await</c> in C#, and the language enforces that rather than leaving it as a subtle bug.
/// </para>
/// </remarks>
public sealed class TokenSource
{
  /// <summary>Refresh this far before expiry, because clocks disagree and a token in flight can expire.</summary>
  private static readonly TimeSpan ExpirySkew = TimeSpan.FromSeconds(30);

  /// <summary>What a provider that omits <c>expires_in</c> gets. Treating it as "never" would cache a dead token.</summary>
  private static readonly TimeSpan DefaultLifetime = TimeSpan.FromHours(1);

  private readonly OAuth2Config _config;
  private readonly ITransport _transport;
  private readonly TimeSpan _timeout;
  private readonly Func<DateTimeOffset> _clock;
  private readonly SemaphoreSlim _gate = new(1, 1);

  private string? _accessToken;
  private DateTimeOffset? _expiresAt;

  public TokenSource(
      OAuth2Config config,
      ITransport transport,
      TimeSpan? timeout = null,
      Func<DateTimeOffset>? clock = null)
  {
    _config = config;
    _transport = transport;
    _timeout = timeout ?? TimeSpan.FromSeconds(30);
    _clock = clock ?? (() => DateTimeOffset.UtcNow);
  }

  public async Task<string> TokenAsync(CancellationToken cancellationToken = default)
  {
    await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
    try
    {
      var now = _clock();
      if (_accessToken is not null && _expiresAt is not null && now < _expiresAt.Value - ExpirySkew)
      {
        return _accessToken;
      }

      return await FetchAsync(cancellationToken).ConfigureAwait(false);
    }
    finally
    {
      _gate.Release();
    }
  }

  /// <summary>Drop the cached token, so the next call fetches a fresh one. Used by the 401-retry path.</summary>
  public void Invalidate()
  {
    _accessToken = null;
    _expiresAt = null;
  }

  private async Task<string> FetchAsync(CancellationToken cancellationToken)
  {
    var form = new Dictionary<string, string>();
    if (_config.RefreshToken is not null)
    {
      form["grant_type"] = "refresh_token";
      form["refresh_token"] = _config.RefreshToken;
    }
    else
    {
      form["grant_type"] = "client_credentials";
    }

    if (_config.Scopes.Count > 0)
    {
      form["scope"] = string.Join(" ", _config.Scopes);
    }

    var headers = new Dictionary<string, string>
    {
      ["Content-Type"] = "application/x-www-form-urlencoded",
      ["Accept"] = "application/json",
    };

    // Credentials in the Authorization header when both are present: that is the form every provider
    // accepts, where in-body credentials are optional in the spec and unevenly implemented.
    if (_config.ClientId is not null && _config.ClientSecret is not null)
    {
      var credentials = Convert.ToBase64String(
          Encoding.UTF8.GetBytes($"{_config.ClientId}:{_config.ClientSecret}"));
      headers["Authorization"] = "Basic " + credentials;
    }
    else if (_config.ClientId is not null)
    {
      form["client_id"] = _config.ClientId;
    }

    var encoded = string.Join(
        "&",
        form.Select(pair => $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}"));

    var response = await _transport
        .SendAsync(
            new HttpRequestSpec(
                "POST",
                _config.TokenUrl,
                headers,
                encoded,
                new Dictionary<string, IReadOnlyList<string>>()),
            _timeout,
            cancellationToken)
        .ConfigureAwait(false);

    if (response.StatusCode is < 200 or >= 300)
    {
      // Never retried: a 400 from a token endpoint means the credentials are wrong, and retrying wrong
      // credentials is how an account gets locked.
      var detail = response.Body.Length > 500 ? response.Body[..500] : response.Body;
      throw new OAuth2Exception($"token request failed with {response.StatusCode}: {detail}");
    }

    if (Json.Parse(response.Body) is not IDictionary<string, object?> map
        || !map.TryGetValue("access_token", out var raw)
        || raw is not string token)
    {
      throw new OAuth2Exception("token response had no string access_token");
    }

    _accessToken = token;
    map.TryGetValue("expires_in", out var expiresIn);
    var lifetime = expiresIn switch
    {
      long seconds => TimeSpan.FromSeconds(seconds),
      double seconds => TimeSpan.FromSeconds(seconds),
      _ => DefaultLifetime,
    };
    _expiresAt = _clock() + lifetime;
    return token;
  }
}

/// <summary>OAuth2, holding a token source that refreshes itself.</summary>
public sealed class OAuth2Auth : IAuth
{
  private readonly TokenSource _source;

  public OAuth2Auth(TokenSource source) => _source = source;

  public async Task<AuthApplied> ApplyAsync(
      IReadOnlyDictionary<string, string> headers,
      IReadOnlyDictionary<string, IReadOnlyList<string>> query,
      CancellationToken cancellationToken = default)
  {
    var token = await _source.TokenAsync(cancellationToken).ConfigureAwait(false);
    var result = new Dictionary<string, string>(headers) { ["Authorization"] = "Bearer " + token };
    return new AuthApplied(result, query);
  }

  /// <summary>Drop the cached token. The 401-retry path calls this before its one retry.</summary>
  public void Invalidate() => _source.Invalidate();
}
