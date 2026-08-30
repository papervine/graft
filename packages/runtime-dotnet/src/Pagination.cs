using System.Runtime.CompilerServices;

namespace Graft.Runtime;

/// <summary>A page before decoding: the raw body plus the response it came in.</summary>
/// <remarks>Both are needed — items come from the body, and a total may arrive in a header.</remarks>
public sealed record RawPage(object? Body, HttpResponseSpec Response);

/// <summary>One page of results.</summary>
public sealed record Page<T>(IReadOnlyList<T> Items, int? Total, bool HasNextPage);

/// <summary>Which parameter advances, and where the next value comes from.</summary>
public enum PaginationStyle
{
  Offset,
  Page,
  Cursor,
}

/// <summary>
/// How a paginated operation advances.
/// </summary>
/// <remarks>
/// Data rather than three subclasses: the differences between offset, page, and cursor paging are entirely in
/// which parameter changes and where the next value comes from. <c>init</c> properties because which fields
/// apply depends on the style.
/// </remarks>
public sealed record PaginationScheme
{
  public required PaginationStyle Style { get; init; }

  /// <summary>Dotted path to the items, or null for a bare array response.</summary>
  public IReadOnlyList<string>? ItemsPath { get; init; }

  public string? LimitParam { get; init; }

  public string? OffsetParam { get; init; }

  public string? PageParam { get; init; }

  public string? CursorParam { get; init; }

  public IReadOnlyList<string>? CursorPath { get; init; }

  public string? TotalHeader { get; init; }

  public IReadOnlyList<string>? TotalPath { get; init; }
}

/// <summary>
/// Walks every page of a paginated operation.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="IAsyncEnumerable{T}"/> so <c>await foreach</c> works, which is the language's own answer and the
/// only target where laziness and async compose natively (SPEC.md §3.3.11). <see cref="PagesAsync"/> exists for
/// per-page access and <see cref="FirstPageAsync"/> for the case where one page is all the caller wants.
/// </para>
/// <para>
/// Lazy: no request happens until enumeration begins. That matters for the error path — a 404 surfaces where the
/// caller enumerates, not where they built the paginator.
/// </para>
/// </remarks>
public sealed class Paginator<T> : IAsyncEnumerable<T>
{
  private readonly PaginationScheme _scheme;
  private readonly Func<IReadOnlyDictionary<string, object?>, CancellationToken, Task<RawPage>> _fetch;
  private readonly IReadOnlyDictionary<string, object?> _initialParams;
  private readonly Func<IReadOnlyList<object?>, IReadOnlyList<T>>? _decode;
  private Page<T>? _memoisedFirst;

  public Paginator(
      PaginationScheme scheme,
      Func<IReadOnlyDictionary<string, object?>, CancellationToken, Task<RawPage>> fetch,
      IReadOnlyDictionary<string, object?>? initialParams = null,
      Func<IReadOnlyList<object?>, IReadOnlyList<T>>? decode = null)
  {
    _scheme = scheme;
    _fetch = fetch;
    _initialParams = initialParams ?? new Dictionary<string, object?>();
    _decode = decode;
  }

  public async IAsyncEnumerator<T> GetAsyncEnumerator(CancellationToken cancellationToken = default)
  {
    await foreach (var page in PagesAsync(cancellationToken).ConfigureAwait(false))
    {
      foreach (var item in page.Items)
      {
        yield return item;
      }
    }
  }

  /// <summary>Page by page, rather than item by item.</summary>
  public async IAsyncEnumerable<Page<T>> PagesAsync(
      [EnumeratorCancellation] CancellationToken cancellationToken = default)
  {
    // A copy, not the caller's map: advancing mutates it, and a paginator enumerated twice must start over
    // rather than continue from where the last enumeration stopped.
    var parameters = new Dictionary<string, object?>(_initialParams);
    var seenCursors = new HashSet<string>(StringComparer.Ordinal);

    while (true)
    {
      var raw = await _fetch(new Dictionary<string, object?>(parameters), cancellationToken)
          .ConfigureAwait(false);
      var page = PageFrom(raw);
      yield return page;

      // An empty page ends the walk regardless of what the scheme says. A server that keeps answering with
      // `[]` and a next cursor would otherwise loop forever.
      if (page.Items.Count == 0)
      {
        yield break;
      }

      switch (_scheme.Style)
      {
        case PaginationStyle.Cursor:
          {
            if (PathValue(raw.Body, _scheme.CursorPath) is not string cursor || cursor.Length == 0)
            {
              yield break;
            }

            // A server echoing the same cursor is its bug, but the infinite loop would be ours.
            if (!seenCursors.Add(cursor))
            {
              yield break;
            }

            parameters[_scheme.CursorParam ?? "cursor"] = cursor;
            break;
          }

        case PaginationStyle.Page:
          {
            var key = _scheme.PageParam ?? "page";
            var current = parameters.TryGetValue(key, out var value) && value is not null
                ? Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture)
                : 1;
            parameters[key] = current + 1;
            break;
          }

        default:
          {
            var key = _scheme.OffsetParam ?? "offset";
            var current = parameters.TryGetValue(key, out var value) && value is not null
                ? Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture)
                : 0;
            // Advances by the number of items actually returned, not the requested limit: a server
            // returning a short page must not cause items to be skipped.
            parameters[key] = current + page.Items.Count;
            break;
          }
      }
    }
  }

  /// <summary>
  /// The first page, without walking the rest.
  /// </summary>
  /// <remarks>Memoised, so calling it twice does not re-request.</remarks>
  public async Task<Page<T>> FirstPageAsync(CancellationToken cancellationToken = default)
  {
    if (_memoisedFirst is not null)
    {
      return _memoisedFirst;
    }

    await foreach (var page in PagesAsync(cancellationToken).ConfigureAwait(false))
    {
      _memoisedFirst = page;
      return page;
    }

    _memoisedFirst = new Page<T>(Array.Empty<T>(), null, false);
    return _memoisedFirst;
  }

  /// <summary>Every item, materialised.</summary>
  public async Task<List<T>> AllAsync(CancellationToken cancellationToken = default)
  {
    var result = new List<T>();
    await foreach (var item in this.WithCancellation(cancellationToken).ConfigureAwait(false))
    {
      result.Add(item);
    }

    return result;
  }

  private Page<T> PageFrom(RawPage raw)
  {
    var source = _scheme.ItemsPath is null ? raw.Body : PathValue(raw.Body, _scheme.ItemsPath);
    var items = source is IList<object?> list ? new List<object?>(list) : new List<object?>();
    var decoded = _decode is null ? CastRaw(items) : _decode(items);

    int? total = null;
    if (_scheme.TotalHeader is not null)
    {
      var header = raw.Response.Header(_scheme.TotalHeader);
      if (header is not null)
      {
        // `X-Content-Range: items 0-49/227` — the total is after the slash, and a bare integer is also
        // in use. Both are read rather than one being declared correct.
        var slash = header.LastIndexOf('/');
        var candidate = slash >= 0 ? header[(slash + 1)..] : header;
        total = int.TryParse(candidate.Trim(), out var parsed) ? parsed : null;
      }
    }
    else if (_scheme.TotalPath is not null)
    {
      total = PathValue(raw.Body, _scheme.TotalPath) is long value ? (int)value : null;
    }

    var hasNext = _scheme.Style == PaginationStyle.Cursor
        ? PathValue(raw.Body, _scheme.CursorPath) is string
        : items.Count > 0;

    return new Page<T>(decoded, total, hasNext);
  }

  /// <summary>
  /// Items with no decoder are handed back as-is.
  /// </summary>
  /// <remarks>
  /// Unchecked, and unavoidable: a paginated response of scalars has nothing to decode, so <c>T</c> is whatever
  /// the JSON contained. The generated method's declared type is the one that has been checked, by the
  /// validator, before this runs.
  /// </remarks>
  private static IReadOnlyList<T> CastRaw(List<object?> items)
  {
    var result = new List<T>(items.Count);
    foreach (var item in items)
    {
      result.Add((T)item!);
    }

    return result;
  }

  private static object? PathValue(object? body, IReadOnlyList<string>? path)
  {
    if (path is null)
    {
      return null;
    }

    var node = body;
    foreach (var segment in path)
    {
      if (node is not IDictionary<string, object?> map || !map.TryGetValue(segment, out node))
      {
        return null;
      }
    }

    return node;
  }
}
