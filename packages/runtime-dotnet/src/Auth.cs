using System.Text;

namespace Graft.Runtime;

/// <summary>How a request proves who is making it.</summary>
public interface IAuth
{
  /// <summary>
  /// Apply credentials, returning what to send.
  /// </summary>
  /// <remarks>
  /// Async because OAuth2 may need to fetch a token, and a synchronous wrapper around that would be a
  /// <c>.Result</c> deadlock waiting to happen (SPEC.md §3.3.11). Every other scheme completes immediately.
  /// </remarks>
  Task<AuthApplied> ApplyAsync(
      IReadOnlyDictionary<string, string> headers,
      IReadOnlyDictionary<string, IReadOnlyList<string>> query,
      CancellationToken cancellationToken = default);
}

/// <summary>The result of applying credentials.</summary>
public sealed record AuthApplied(
    IReadOnlyDictionary<string, string> Headers,
    IReadOnlyDictionary<string, IReadOnlyList<string>> Query);

/// <summary>No credentials at all — a public API, or one authenticated by something the SDK does not model.</summary>
public sealed class NoAuth : IAuth
{
  public static readonly NoAuth Instance = new();

  public Task<AuthApplied> ApplyAsync(
      IReadOnlyDictionary<string, string> headers,
      IReadOnlyDictionary<string, IReadOnlyList<string>> query,
      CancellationToken cancellationToken = default) =>
      Task.FromResult(new AuthApplied(headers, query));
}

/// <summary>HTTP Bearer.</summary>
public sealed class BearerAuth : IAuth
{
  private readonly string _token;

  public BearerAuth(string token) => _token = token;

  public Task<AuthApplied> ApplyAsync(
      IReadOnlyDictionary<string, string> headers,
      IReadOnlyDictionary<string, IReadOnlyList<string>> query,
      CancellationToken cancellationToken = default)
  {
    var result = new Dictionary<string, string>(headers) { ["Authorization"] = "Bearer " + _token };
    return Task.FromResult(new AuthApplied(result, query));
  }
}

/// <summary>HTTP Basic.</summary>
public sealed class BasicAuth : IAuth
{
  private readonly string _username;
  private readonly string _password;

  public BasicAuth(string username, string password)
  {
    _username = username;
    _password = password;
  }

  public Task<AuthApplied> ApplyAsync(
      IReadOnlyDictionary<string, string> headers,
      IReadOnlyDictionary<string, IReadOnlyList<string>> query,
      CancellationToken cancellationToken = default)
  {
    var credentials = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{_username}:{_password}"));
    var result = new Dictionary<string, string>(headers) { ["Authorization"] = "Basic " + credentials };
    return Task.FromResult(new AuthApplied(result, query));
  }
}

/// <summary>
/// An API key, in a header or the query string.
/// </summary>
/// <remarks>
/// The query variant exists because specs declare it, not because it is a good idea — a key in a URL lands in
/// access logs and browser history. graft honours what the spec says and does not editorialise.
/// </remarks>
public sealed class ApiKeyAuth : IAuth
{
  private readonly string _key;
  private readonly string _name;
  private readonly bool _inQuery;

  public ApiKeyAuth(string key, string name, bool inQuery)
  {
    _key = key;
    _name = name;
    _inQuery = inQuery;
  }

  public Task<AuthApplied> ApplyAsync(
      IReadOnlyDictionary<string, string> headers,
      IReadOnlyDictionary<string, IReadOnlyList<string>> query,
      CancellationToken cancellationToken = default)
  {
    if (_inQuery)
    {
      var updated = new Dictionary<string, IReadOnlyList<string>>(query)
      {
        [_name] = new[] { _key },
      };
      return Task.FromResult(new AuthApplied(headers, updated));
    }

    var result = new Dictionary<string, string>(headers) { [_name] = _key };
    return Task.FromResult(new AuthApplied(result, query));
  }
}
