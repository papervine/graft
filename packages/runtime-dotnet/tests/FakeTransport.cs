using Besdk.Runtime;

namespace Besdk.Runtime.Tests;

/// <summary>
/// A transport that replays scripted responses and records what it was asked to send.
/// </summary>
/// <remarks>
/// The existence of this class is the point of <see cref="ITransport"/> being an interface: without it, testing
/// code that uses a generated SDK means making real network calls.
/// </remarks>
internal sealed class FakeTransport : ITransport
{
  private readonly List<object> _script;

  /// <summary>Entries are consumed in order; the last one repeats. An exception entry is thrown.</summary>
  public FakeTransport(params object[] script) => _script = new List<object>(script);

  public List<HttpRequestSpec> Requests { get; } = new();

  public Task<HttpResponseSpec> SendAsync(
      HttpRequestSpec request,
      TimeSpan timeout,
      CancellationToken cancellationToken = default)
  {
    Requests.Add(request);
    var next = _script.Count > 1 ? _script[0] : _script[^1];
    if (_script.Count > 1)
    {
      _script.RemoveAt(0);
    }

    return next switch
    {
      Exception error => Task.FromException<HttpResponseSpec>(error),
      HttpResponseSpec response => Task.FromResult(response),
      _ => throw new InvalidOperationException("FakeTransport ran out of scripted responses"),
    };
  }

  public static HttpResponseSpec Json(int status, string body, params (string Name, string Value)[] headers)
  {
    var all = new Dictionary<string, string> { ["content-type"] = "application/json" };
    foreach (var (name, value) in headers)
    {
      all[name] = value;
    }

    return new HttpResponseSpec(status, body, all);
  }
}
