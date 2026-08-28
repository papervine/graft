using Besdk.Runtime;
using Xunit;

namespace Besdk.Runtime.Tests;

public sealed class PaginatorTests
{
  /// <summary>Records the parameters each page request was made with.</summary>
  private sealed class Recorder
  {
    private readonly List<RawPage> _pages;
    private int _index;

    public Recorder(params RawPage[] pages) => _pages = new List<RawPage>(pages);

    public List<IReadOnlyDictionary<string, object?>> Calls { get; } = new();

    public Task<RawPage> Fetch(IReadOnlyDictionary<string, object?> parameters, CancellationToken token)
    {
      Calls.Add(parameters);
      var page = _index < _pages.Count
          ? _pages[_index++]
          : Raw(new List<object?>());
      return Task.FromResult(page);
    }
  }

  private static RawPage Raw(object? body, params (string Name, string Value)[] headers)
  {
    var map = new Dictionary<string, string>();
    foreach (var (name, value) in headers)
    {
      map[name] = value;
    }

    return new RawPage(body, new HttpResponseSpec(200, string.Empty, map));
  }

  private static Dictionary<string, object?> Dict(params (string Key, object? Value)[] entries)
  {
    var result = new Dictionary<string, object?>();
    foreach (var (key, value) in entries)
    {
      result[key] = value;
    }

    return result;
  }

  [Fact]
  public async Task WalksEveryItemAcrossOffsetPages()
  {
    var recorder = new Recorder(
        Raw(new List<object?> { Dict(("id", 1L)), Dict(("id", 2L)) }),
        Raw(new List<object?> { Dict(("id", 3L)) }),
        Raw(new List<object?>()));
    var scheme = new PaginationScheme
    {
      Style = PaginationStyle.Offset,
      LimitParam = "limit",
      OffsetParam = "offset",
    };
    var paginator = new Paginator<object?>(scheme, recorder.Fetch, Dict(("limit", 2)));

    Assert.Equal(3, (await paginator.AllAsync()).Count);
    // The offset advances by the number of items actually returned, not the requested limit: a server
    // returning a short page must not cause items to be skipped.
    Assert.Equal(2L, recorder.Calls[1]["offset"]);
    Assert.Equal(3L, recorder.Calls[2]["offset"]);
  }

  [Fact]
  public async Task StopsOnAnEmptyPage()
  {
    var recorder = new Recorder(Raw(new List<object?>()), Raw(new List<object?> { Dict(("id", 1L)) }));
    var paginator = new Paginator<object?>(
        new PaginationScheme { Style = PaginationStyle.Offset }, recorder.Fetch);
    Assert.Empty(await paginator.AllAsync());
    Assert.Single(recorder.Calls);
  }

  [Fact]
  public async Task FollowsACursorAndStopsWhenItIsAbsent()
  {
    var recorder = new Recorder(
        Raw(Dict(("items", new List<object?> { Dict(("id", 1L)) }), ("next", "c2"))),
        Raw(Dict(("items", new List<object?> { Dict(("id", 2L)) }))));
    var scheme = new PaginationScheme
    {
      Style = PaginationStyle.Cursor,
      ItemsPath = new[] { "items" },
      CursorParam = "cursor",
      CursorPath = new[] { "next" },
    };
    var paginator = new Paginator<object?>(scheme, recorder.Fetch);
    Assert.Equal(2, (await paginator.AllAsync()).Count);
    Assert.Equal("c2", recorder.Calls[1]["cursor"]);
  }

  [Fact]
  public async Task StopsWhenAServerRepeatsACursor()
  {
    // A server echoing the same cursor is its bug, but the infinite loop would be ours.
    var recorder = new Recorder(
        Raw(Dict(("items", new List<object?> { Dict(("id", 1L)) }), ("next", "same"))),
        Raw(Dict(("items", new List<object?> { Dict(("id", 2L)) }), ("next", "same"))),
        Raw(Dict(("items", new List<object?> { Dict(("id", 3L)) }), ("next", "same"))));
    var scheme = new PaginationScheme
    {
      Style = PaginationStyle.Cursor,
      ItemsPath = new[] { "items" },
      CursorParam = "cursor",
      CursorPath = new[] { "next" },
    };
    Assert.Equal(2, (await new Paginator<object?>(scheme, recorder.Fetch).AllAsync()).Count);
  }

  [Fact]
  public async Task ReadsATotalFromAContentRangeHeader()
  {
    var recorder = new Recorder(
        Raw(new List<object?> { Dict(("id", 1L)) }, ("x-content-range", "items 0-0/227")));
    var scheme = new PaginationScheme { Style = PaginationStyle.Offset, TotalHeader = "X-Content-Range" };
    var page = await new Paginator<object?>(scheme, recorder.Fetch).FirstPageAsync();
    Assert.Equal(227, page.Total);
  }

  [Fact]
  public async Task ReadsABareIntegerTotalHeader()
  {
    var recorder = new Recorder(Raw(new List<object?> { Dict(("id", 1L)) }, ("x-total-count", "42")));
    var scheme = new PaginationScheme { Style = PaginationStyle.Offset, TotalHeader = "X-Total-Count" };
    Assert.Equal(42, (await new Paginator<object?>(scheme, recorder.Fetch).FirstPageAsync()).Total);
  }

  [Fact]
  public async Task FirstPageIsMemoised()
  {
    var recorder = new Recorder(Raw(new List<object?> { Dict(("id", 1L)) }), Raw(new List<object?>()));
    var paginator = new Paginator<object?>(
        new PaginationScheme { Style = PaginationStyle.Offset }, recorder.Fetch);
    await paginator.FirstPageAsync();
    await paginator.FirstPageAsync();
    Assert.Single(recorder.Calls);
  }

  [Fact]
  public async Task IsAwaitForeachable()
  {
    // `await foreach (var w in client.Widgets.ListAsync())` is the language's own answer, and the only target
    // where laziness and async compose natively.
    var recorder = new Recorder(Raw(new List<object?> { "a", "b" }), Raw(new List<object?>()));
    var paginator = new Paginator<object?>(
        new PaginationScheme { Style = PaginationStyle.Offset }, recorder.Fetch);
    var seen = new List<object?>();
    await foreach (var item in paginator)
    {
      seen.Add(item);
    }

    Assert.Equal(new object?[] { "a", "b" }, seen);
  }

  [Fact]
  public async Task EnumeratingTwiceStartsOver()
  {
    // The advancing parameters are a copy, not the caller's map — otherwise a second enumeration would
    // continue from where the first stopped.
    var recorder = new Recorder(
        Raw(new List<object?> { "a" }),
        Raw(new List<object?>()),
        Raw(new List<object?> { "a" }),
        Raw(new List<object?>()));
    var initial = Dict(("offset", 0));
    var paginator = new Paginator<object?>(
        new PaginationScheme { Style = PaginationStyle.Offset, OffsetParam = "offset" },
        recorder.Fetch,
        initial);
    await paginator.AllAsync();
    var callsAfterFirst = recorder.Calls.Count;
    await paginator.AllAsync();

    // The second enumeration re-requests from the beginning rather than continuing where the first stopped.
    Assert.True(recorder.Calls.Count > callsAfterFirst, "the second enumeration made no requests");
    Assert.Equal(0, recorder.Calls[callsAfterFirst]["offset"]);
  }

  [Fact]
  public async Task AppliesADecoderToEachItem()
  {
    var recorder = new Recorder(Raw(new List<object?> { Dict(("id", "w_1")) }), Raw(new List<object?>()));
    var paginator = new Paginator<string>(
        new PaginationScheme { Style = PaginationStyle.Offset },
        recorder.Fetch,
        null,
        items => items
            .Select(item => item is IDictionary<string, object?> map ? map["id"] as string ?? string.Empty : string.Empty)
            .ToList());
    Assert.Equal(new[] { "w_1" }, await paginator.AllAsync());
  }
}
