namespace Besdk.Runtime;

/// <summary>
/// Per-call overrides.
/// </summary>
/// <remarks>
/// A record with <c>init</c> properties rather than a builder: C# gives named assignment for free, which is
/// exactly why this target needs no builders anywhere (SPEC.md §3.3.11).
/// <code>
/// RequestOptions options = new() { Timeout = TimeSpan.FromSeconds(5), IdempotencyKey = "req_1" };
/// </code>
/// </remarks>
public sealed record RequestOptions
{
  public TimeSpan? Timeout { get; init; }

  public int? MaxRetries { get; init; }

  public IReadOnlyDictionary<string, string> Headers { get; init; } = new Dictionary<string, string>();

  /// <summary>
  /// Makes a <c>POST</c> or <c>PATCH</c> safe to retry.
  /// </summary>
  /// <remarks>Deduplication happens on the server; a client cannot make a replay safe by itself.</remarks>
  public string? IdempotencyKey { get; init; }
}
