using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;

namespace Graft.Runtime;

/// <summary>
/// Encoding a request body as <c>application/x-www-form-urlencoded</c>.
/// </summary>
/// <remarks>
/// <para>
/// Its own type because the rules are shared with nothing else and getting them wrong is invisible: a
/// server receiving JSON where it expected a form rejects the request, and nothing on the client side can
/// tell. Every write operation of every form-based API was sent as JSON before this existed.
/// </para>
/// <para>
/// Takes the body's JSON tree rather than the record, so the wire names and the omit-when-null rules are
/// exactly the ones the JSON path already gets right. Reflecting over the record separately would be a
/// second implementation of field naming, and the two would disagree the first time a model changed.
/// </para>
/// </remarks>
public static class Form
{
  /// <summary>Encode a JSON tree as a form-encoded string.</summary>
  /// <remarks>
  /// A list becomes a repeated key, which is what every form-encoded API this project has seen expects;
  /// <c>key[]=</c> is a PHP convention and <c>key=a,b</c> is a third. A nested object is JSON-encoded,
  /// matching the multipart path — form encoding has no canonical nesting, so inventing one would send
  /// something no server asked for.
  /// </remarks>
  public static string Encode(object? tree)
  {
    if (tree is not IReadOnlyDictionary<string, object?> fields)
    {
      return string.Empty;
    }

    var pairs = new List<string>();
    foreach (var (key, value) in fields)
    {
      // Null is omitted rather than sent as an empty value, which a server reads as a real one — the same
      // rule Query follows.
      if (value is null)
      {
        continue;
      }

      var name = WebUtility.UrlEncode(key);
      if (value is IReadOnlyList<object?> items)
      {
        pairs.AddRange(
            items.Where(item => item is not null)
                 .Select(item => $"{name}={WebUtility.UrlEncode(Scalar(item))}"));
        continue;
      }

      pairs.Add($"{name}={WebUtility.UrlEncode(Scalar(value))}");
    }

    return string.Join("&", pairs);
  }

  /// <summary>One value as a form field.</summary>
  /// <remarks>
  /// Shared with <see cref="Multipart"/> so a boolean is <c>true</c> in both encodings and an integral
  /// double is an integer in both. Two copies would disagree, and only against a strict server.
  /// </remarks>
  public static string ScalarFor(object? value) => Scalar(value);

  /// <summary>One value as a form field.</summary>
  private static string Scalar(object? value) => value switch
  {
    string text => text,
    bool flag => flag ? "true" : "false",
    // An integral double is written as an integer: an id sent as `1` and not `1.0` is what a server
    // expects, and the JSON parser hands back a double for both.
    double number when number == System.Math.Floor(number) && System.Math.Abs(number) < 1e15 =>
        ((long)number).ToString(CultureInfo.InvariantCulture),
    double number => number.ToString(CultureInfo.InvariantCulture),
    long number => number.ToString(CultureInfo.InvariantCulture),
    int number => number.ToString(CultureInfo.InvariantCulture),
    IReadOnlyDictionary<string, object?> or IReadOnlyList<object?> => Json.Write(value),
    null => string.Empty,
    _ => System.Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty,
  };
}
