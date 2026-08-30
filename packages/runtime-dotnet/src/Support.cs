using System.Globalization;

namespace Graft.Runtime;

/// <summary>
/// Helpers generated models call.
/// </summary>
/// <remarks>
/// In the runtime rather than emitted per SDK, because they are identical for every spec and hand-written code
/// is where this project puts quality (<c>AGENTS.md</c>). Generated decoders stay a list of narrowing
/// assignments, which is the part that genuinely differs per model.
/// </remarks>
public static class Support
{
  /// <summary>
  /// A required field was absent or the wrong type.
  /// </summary>
  /// <remarks>
  /// Returns <c>T</c> rather than void so it can be the else-branch of a conditional expression, which is what
  /// lets a generated decoder narrow in one statement per field.
  /// </remarks>
  public static T Fail<T>(string owner, string field, string expected) =>
      throw new DecodeException($"{owner}: expected {expected} for `{field}`");

  /// <summary>The object at a key, or null.</summary>
  public static object? Get(object? data, string key) =>
      data is IDictionary<string, object?> map && map.TryGetValue(key, out var value) ? value : null;

  /// <summary>
  /// Parse an RFC 3339 timestamp.
  /// </summary>
  /// <remarks>
  /// Returns null on an unparseable value rather than throwing, so the caller decides whether that is fatal —
  /// which depends on whether the field was required. <c>RoundtripKind</c> keeps an explicit offset rather
  /// than silently converting to local time, which is the default and is wrong for a wire value.
  /// </remarks>
  public static DateTimeOffset? Instant(object? value)
  {
    if (value is DateTimeOffset already)
    {
      return already;
    }

    if (value is not string text || string.IsNullOrWhiteSpace(text))
    {
      return null;
    }

    return DateTimeOffset.TryParse(
        text,
        CultureInfo.InvariantCulture,
        DateTimeStyles.RoundtripKind,
        out var parsed)
        ? parsed
        : null;
  }

  /// <summary>Decode a JSON array, keeping nulls: a JSON array is allowed to contain them.</summary>
  public static IReadOnlyList<T> List<T>(object? value, Func<object?, T> decode)
  {
    if (value is not IList<object?> items)
    {
      return Array.Empty<T>();
    }

    var result = new List<T>(items.Count);
    foreach (var item in items)
    {
      result.Add(decode(item));
    }

    return result;
  }

  /// <summary>Decode a JSON object as a map.</summary>
  public static IReadOnlyDictionary<string, T> Map<T>(object? value, Func<object?, T> decode)
  {
    // An empty map arrives as `[]` from a PHP backend, which is the artifact SPEC.md §3.1.2 names.
    if (value is IList<object?> { Count: 0 })
    {
      return new Dictionary<string, T>();
    }

    if (value is not IDictionary<string, object?> map)
    {
      return new Dictionary<string, T>();
    }

    var result = new Dictionary<string, T>(map.Count);
    foreach (var (key, item) in map)
    {
      result[key] = decode(item);
    }

    return result;
  }

  /// <summary>
  /// A paginated method's base query, plus the parameters the paginator advances.
  /// </summary>
  /// <remarks>
  /// The paginator's parameters win, because they are the ones that change per page — a base <c>offset</c>
  /// would otherwise pin every request to the first page.
  /// </remarks>
  public static IReadOnlyDictionary<string, object?> Merged(
      IReadOnlyDictionary<string, object?> baseQuery,
      IReadOnlyDictionary<string, object?> advancing)
  {
    var result = new Dictionary<string, object?>(baseQuery);
    foreach (var (key, value) in advancing)
    {
      result[key] = value;
    }

    return result;
  }
}
