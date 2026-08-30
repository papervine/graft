using System.Text.Json;
using System.Text.Json.Nodes;

namespace Graft.Runtime;

/// <summary>
/// Parsing and writing JSON.
/// </summary>
/// <remarks>
/// <para>
/// A thin layer over <see cref="System.Text.Json"/>, which ships in the BCL. This is the opposite call to the
/// Java target, and the difference is not taste: there is no dependency to conflict with, because the parser is
/// part of the platform the consumer already has (SPEC.md §3.3.11).
/// </para>
/// <para>
/// Parsed into a tree of <see cref="IDictionary{TKey,TValue}"/>, <see cref="IList{T}"/>, <see cref="string"/>,
/// <see cref="long"/>, <see cref="double"/>, <see cref="bool"/>, and null — the same shape every other target's
/// runtime produces, so the descriptor walker and the generated decoders are the same design everywhere.
/// </para>
/// </remarks>
public static class Json
{
  private static readonly JsonSerializerOptions WriteOptions = new()
  {
    // Compact: a request body is not read by a human, and whitespace is bytes on every request.
    WriteIndented = false,
    // The default escapes `+`, `&`, and non-ASCII aggressively for HTML safety. A JSON request body is not
    // HTML, and the escaping makes bodies unreadable in logs for no gain.
    Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
  };

  /// <summary>Parse a JSON document into a tree.</summary>
  public static object? Parse(string text)
  {
    try
    {
      using var document = JsonDocument.Parse(text);
      return FromElement(document.RootElement);
    }
    catch (JsonException error)
    {
      throw new DecodeException("response was not valid JSON: " + error.Message, error);
    }
  }

  /// <summary>Write a tree as JSON.</summary>
  public static string Write(object? value) => JsonSerializer.Serialize(Normalise(value), WriteOptions);

  private static object? FromElement(JsonElement element) => element.ValueKind switch
  {
    JsonValueKind.Object => ObjectFrom(element),
    JsonValueKind.Array => ArrayFrom(element),
    JsonValueKind.String => element.GetString(),
    JsonValueKind.Number => NumberFrom(element),
    JsonValueKind.True => true,
    JsonValueKind.False => false,
    _ => null,
  };

  private static Dictionary<string, object?> ObjectFrom(JsonElement element)
  {
    // Insertion-ordered by construction, so a re-serialised document keeps the server's field order.
    var result = new Dictionary<string, object?>();
    foreach (var property in element.EnumerateObject())
    {
      result[property.Name] = FromElement(property.Value);
    }

    return result;
  }

  private static List<object?> ArrayFrom(JsonElement element)
  {
    var result = new List<object?>();
    foreach (var item in element.EnumerateArray())
    {
      result.Add(FromElement(item));
    }

    return result;
  }

  /// <summary>
  /// A JSON number as the narrowest .NET type that holds it exactly.
  /// </summary>
  /// <remarks>
  /// <c>long</c> when it fits, otherwise <c>double</c>. The distinction matters downstream: a descriptor
  /// declaring an integer accepts a <c>long</c>, and a model property typed <c>long</c> cannot take a
  /// <c>double</c> without a cast that would truncate.
  /// </remarks>
  private static object NumberFrom(JsonElement element)
  {
    // Written as a statement, not a ternary. `cond ? longValue : doubleValue` unifies both branches to
    // `double` — so *every* integer boxed as a double, and the descriptor parser's `is long` check for the
    // required-field flag silently stopped matching. One C# type-inference trap, two failures, and neither
    // was where it looked.
    if (element.TryGetInt64(out var integer))
    {
      return integer;
    }

    return element.GetDouble();
  }

  /// <summary>
  /// Prepare a value for serialisation.
  /// </summary>
  /// <remarks>
  /// Enums become their wire value and timestamps become RFC 3339 here rather than through a converter,
  /// because the tree may contain values a converter registered for a specific type would never see — a
  /// <c>Dictionary&lt;string, object?&gt;</c> holding an enum, for instance.
  /// </remarks>
  private static object? Normalise(object? value) => value switch
  {
    null => null,
    IWireValued wired => wired.WireValue,
    DateTimeOffset moment => moment.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
    DateTime moment => moment.ToUniversalTime().ToString("o", System.Globalization.CultureInfo.InvariantCulture),
    IDictionary<string, object?> map => NormaliseMap(map),
    string text => text,
    System.Collections.IEnumerable items => NormaliseList(items),
    _ => value,
  };

  private static Dictionary<string, object?> NormaliseMap(IDictionary<string, object?> map)
  {
    var result = new Dictionary<string, object?>();
    foreach (var (key, item) in map)
    {
      result[key] = Normalise(item);
    }

    return result;
  }

  private static List<object?> NormaliseList(System.Collections.IEnumerable items)
  {
    var result = new List<object?>();
    foreach (var item in items)
    {
      result.Add(Normalise(item));
    }

    return result;
  }
}
