namespace Besdk.Target.Dotnet;

/// <summary>
/// Reading the IR without lying about its type.
/// </summary>
/// <remarks>
/// The IR arrives from a JSON parser, so every value is <c>object?</c> and every collection is untyped. These are
/// <b>normalisers, not casts</b>: each returns a well-formed value of the declared type for any input, so a
/// malformed IR produces a degraded SDK rather than an <c>InvalidCastException</c> inside the emitter.
///
/// <para>
/// The field names here are checked against <c>packages/protocol/src/ir.ts</c> rather than remembered. The PHP
/// target read <c>http.method</c> where the IR has <c>http.verb</c>, and every generated method came out as a
/// GET — silently.
/// </para>
/// </remarks>
internal static class Ir
{
  /// <summary>
  /// A string-keyed object, or an empty one.
  /// </summary>
  /// <remarks>
  /// Typed <c>IDictionary</c> rather than <c>IReadOnlyDictionary</c>, because C#'s two dictionary interfaces do
  /// not inherit from each other — <c>Dictionary</c> implements both, but a value typed as one cannot be passed
  /// where the other is expected without a cast.
  /// </remarks>
  public static IDictionary<string, object?> Obj(object? value) =>
      value is IDictionary<string, object?> map ? map : new Dictionary<string, object?>();

  /// <summary>A list of objects, dropping anything that is not one.</summary>
  public static List<IDictionary<string, object?>> Objects(object? value)
  {
    var result = new List<IDictionary<string, object?>>();
    if (value is IList<object?> items)
    {
      foreach (var item in items)
      {
        if (item is IDictionary<string, object?> map)
        {
          result.Add(map);
        }
      }
    }

    return result;
  }

  /// <summary>A string, or the fallback.</summary>
  public static string Str(object? value, string fallback = "") =>
      value is string text && text.Length > 0 ? text : fallback;

  /// <summary>A string, or null — for the cases where absence is meaningful.</summary>
  public static string? StrOrNull(object? value) => value is string text && text.Length > 0 ? text : null;

  public static List<string> Strings(object? value)
  {
    var result = new List<string>();
    if (value is IList<object?> items)
    {
      foreach (var item in items)
      {
        if (item is string text)
        {
          result.Add(text);
        }
      }
    }

    return result;
  }

  public static bool Flag(object? value) => value is bool flag && flag;

  /// <summary>The <c>name.tokens</c> of a node, or a placeholder.</summary>
  public static List<string> Tokens(object? node)
  {
    var tokens = Strings(Get(Obj(node), "tokens"));
    return tokens.Count == 0 ? new List<string> { "value" } : tokens;
  }

  public static object? Get(IDictionary<string, object?> map, string key) =>
      map.TryGetValue(key, out var value) ? value : null;
}
