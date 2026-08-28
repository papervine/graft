using System.Globalization;
using Besdk.Runtime;
using Xunit;

namespace Besdk.Runtime.Tests;

public sealed class JsonAndQueryTests
{
  /// <summary>A generated enum, which carries a wire value distinct from its .NET name.</summary>
  private sealed record Kind(string WireValue) : IWireValued
  {
    public static readonly Kind Member = new("member");
  }

  [Fact]
  public void AnIntegerBecomesALongAndAFractionBecomesADouble()
  {
    // The distinction matters downstream: a descriptor declaring an integer accepts a long, and a model
    // property typed long cannot take a double without a cast that would truncate.
    Assert.IsType<long>(Json.Parse("42"));
    Assert.IsType<double>(Json.Parse("42.5"));
  }

  [Fact]
  public void PreservesFieldOrder()
  {
    // Round-tripping a body through a proxy should not reorder it.
    Assert.Equal("{\"b\":1,\"a\":2}", Json.Write(Json.Parse("{\"b\":1,\"a\":2}")));
  }

  [Fact]
  public void WritesUnicodeAndSlashesWithoutAggressiveEscaping()
  {
    // The default encoder escapes `+`, `&`, and non-ASCII for HTML safety. A JSON request body is not HTML,
    // and the escaping makes bodies unreadable in logs for no gain.
    Assert.Equal("{\"a\":\"café\"}", Json.Write(new Dictionary<string, object?> { ["a"] = "café" }));
    Assert.Equal("{\"a\":\"x&y\"}", Json.Write(new Dictionary<string, object?> { ["a"] = "x&y" }));
  }

  [Fact]
  public void WritesAnEnumAsItsWireValueAndATimestampAsRfc3339()
  {
    Assert.Equal("{\"k\":\"member\"}", Json.Write(new Dictionary<string, object?> { ["k"] = Kind.Member }));
    var moment = DateTimeOffset.Parse("2026-01-02T03:04:05Z", CultureInfo.InvariantCulture);
    Assert.Contains("2026-01-02T03:04:05", Json.Write(new Dictionary<string, object?> { ["t"] = moment }), StringComparison.Ordinal);
  }

  [Fact]
  public void ReportsInvalidJsonAsADecodeException()
  {
    Assert.Throws<DecodeException>(() => Json.Parse("not json"));
  }

  [Fact]
  public void OmitsNullButKeepsFalse()
  {
    // `?active=false` is a meaningful filter; omitting the parameter is a different request.
    var flattened = Query.Flatten(new Dictionary<string, object?> { ["active"] = false, ["other"] = null });
    Assert.Equal(new[] { "false" }, flattened["active"]);
    Assert.False(flattened.ContainsKey("other"));
  }

  [Fact]
  public void RepeatsTheKeyForACollectionButNotForAString()
  {
    // A string is IEnumerable<char>, so it has to be handled before the collection branch or `?q=hello`
    // becomes five separate values.
    var list = Query.Flatten(new Dictionary<string, object?> { ["tag"] = new[] { "a", "b" } });
    Assert.Equal(new[] { "a", "b" }, list["tag"]);
    var text = Query.Flatten(new Dictionary<string, object?> { ["q"] = "hello" });
    Assert.Equal(new[] { "hello" }, text["q"]);
  }

  [Fact]
  public void SendsNothingForAnEmptyCollection()
  {
    Assert.Empty(Query.Flatten(new Dictionary<string, object?> { ["tag"] = Array.Empty<string>() }));
  }

  [Fact]
  public void AnEnumSendsItsWireValue()
  {
    // The bug this pins came from PHP, where an enum fell through to a JSON encoder and arrived as
    // `"member"` with literal quotes while every other language sent `member`.
    var flattened = Query.Flatten(new Dictionary<string, object?> { ["kind"] = Kind.Member });
    Assert.Equal(new[] { "member" }, flattened["kind"]);
  }

  [Fact]
  public void ANumberUsesTheInvariantCulture()
  {
    // A German locale renders 1.5 as "1,5", which no API accepts. This is the kind of bug that only appears
    // on someone else's machine.
    var previous = Thread.CurrentThread.CurrentCulture;
    try
    {
      Thread.CurrentThread.CurrentCulture = new CultureInfo("de-DE");
      var flattened = Query.Flatten(new Dictionary<string, object?> { ["ratio"] = 1.5 });
      Assert.Equal(new[] { "1.5" }, flattened["ratio"]);
    }
    finally
    {
      Thread.CurrentThread.CurrentCulture = previous;
    }
  }

  [Fact]
  public void PathParametersArePercentEncoded()
  {
    // An id containing a slash must not escape its segment and reach a different endpoint.
    Assert.Equal(
        "/orgs/a%2Fb/invoices/i1",
        Query.Path("/orgs/{org}/invoices/{id}", new Dictionary<string, object?> { ["org"] = "a/b", ["id"] = "i1" }));
    // `EscapeDataString`, not `UrlEncode`: the latter renders a space as `+`, correct in a query string and
    // wrong in a path.
    Assert.Equal("/x/a%20b", Query.Path("/x/{k}", new Dictionary<string, object?> { ["k"] = "a b" }));
  }
}
