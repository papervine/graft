using System.Globalization;
using System.Text;
using System.Web;

namespace Besdk.Runtime;

/// <summary>Something with a wire representation distinct from its .NET name. Generated enums use this.</summary>
public interface IWireValued
{
  string WireValue { get; }
}

/// <summary>
/// Building query strings and URLs.
/// </summary>
/// <remarks>
/// Its own class because the rules are shared and fiddly: every generated method funnels through them, and
/// getting <c>null</c> versus <c>false</c> versus an empty list wrong is the kind of bug that only shows up
/// against a real server.
/// </remarks>
public static class Query
{
  /// <summary>
  /// Flatten user-supplied query parameters into repeated string values.
  /// </summary>
  /// <remarks>
  /// Three rules, each of which cost a real bug in another target:
  /// <list type="bullet">
  /// <item><description>
  /// <c>null</c> is omitted, <c>false</c> is not. <c>?active=false</c> is a meaningful filter, and omitting
  /// the parameter is a different request.
  /// </description></item>
  /// <item><description>A collection repeats the key: <c>?tag=a&amp;tag=b</c>, which is what servers expect.</description></item>
  /// <item><description>An empty collection sends nothing, rather than an empty key.</description></item>
  /// </list>
  /// </remarks>
  public static IReadOnlyDictionary<string, IReadOnlyList<string>> Flatten(
      IReadOnlyDictionary<string, object?> parameters)
  {
    var result = new Dictionary<string, IReadOnlyList<string>>();
    foreach (var (key, value) in parameters)
    {
      if (value is null)
      {
        continue;
      }

      var rendered = new List<string>();
      // A string is an IEnumerable of char, so it has to be handled before the collection branch or
      // `?q=hello` becomes five separate values.
      if (value is not string && value is System.Collections.IEnumerable items)
      {
        foreach (var item in items)
        {
          if (item is not null)
          {
            rendered.Add(Scalar(item));
          }
        }
      }
      else
      {
        rendered.Add(Scalar(value));
      }

      if (rendered.Count > 0)
      {
        result[key] = rendered;
      }
    }

    return result;
  }

  /// <summary>
  /// One query value as a string.
  /// </summary>
  /// <remarks>
  /// An enum sends its wire value, not its .NET name. That distinction cost a cross-language conformance
  /// failure in PHP, where an enum fell through to a JSON encoder and arrived quoted — so it is handled
  /// explicitly and first here.
  /// </remarks>
  private static string Scalar(object value) => value switch
  {
    // The words, not 1/0: a server reading a boolean query parameter expects `true`.
    bool flag => flag ? "true" : "false",
    IWireValued wired => wired.WireValue,
    DateTimeOffset moment => moment.ToString("o", CultureInfo.InvariantCulture),
    DateTime moment => moment.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture),
    // `InvariantCulture` matters: a German locale renders 1.5 as "1,5", which no API accepts.
    IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
    _ => value.ToString() ?? string.Empty,
  };

  /// <summary>Join a base URL, a path, and query parameters.</summary>
  public static string Url(
      string baseUrl,
      string path,
      IReadOnlyDictionary<string, IReadOnlyList<string>> query)
  {
    var url = new StringBuilder(baseUrl.TrimEnd('/'));
    url.Append(path.StartsWith('/') ? path : "/" + path);
    if (query.Count == 0)
    {
      return url.ToString();
    }

    url.Append(url.ToString().Contains('?') ? '&' : '?');
    var first = true;
    foreach (var (key, values) in query)
    {
      foreach (var value in values)
      {
        if (!first)
        {
          url.Append('&');
        }

        first = false;
        url.Append(Uri.EscapeDataString(key)).Append('=').Append(Uri.EscapeDataString(value));
      }
    }

    return url.ToString();
  }

  /// <summary>
  /// Substitute <c>{name}</c> path parameters.
  /// </summary>
  /// <remarks>
  /// Each value is percent-encoded, so an id containing a slash cannot escape its segment and reach a
  /// different endpoint. <see cref="Uri.EscapeDataString"/> rather than
  /// <see cref="HttpUtility.UrlEncode(string)"/>: the latter renders a space as <c>+</c>, which is correct in
  /// a query string and wrong in a path.
  /// </remarks>
  public static string Path(string template, IReadOnlyDictionary<string, object?> parameters)
  {
    var result = template;
    foreach (var (name, value) in parameters)
    {
      var rendered = value is null ? string.Empty : Scalar(value);
      result = result.Replace("{" + name + "}", Uri.EscapeDataString(rendered), StringComparison.Ordinal);
    }

    return result;
  }
}
