using Graft.Runtime;
using Xunit;

namespace Graft.Runtime.Tests;

public sealed class ClientTests
{
  /// <summary>No waiting: the backoff is exercised, the wall clock is not.</summary>
  private static Client Build(FakeTransport transport, int maxRetries = 2) =>
      new(new ClientOptions
      {
        BaseUrl = "https://api.test",
        Auth = new BearerAuth("t"),
        MaxRetries = maxRetries,
        Transport = transport,
        Delay = (_, _) => Task.CompletedTask,
      });

  private static readonly Dictionary<string, object?> NoQuery = new();

  [Fact]
  public async Task SendsAuthAndDefaultHeaders()
  {
    var transport = new FakeTransport(FakeTransport.Json(200, "{\"ok\":true}"));
    await Build(transport).RequestAsync("GET", "/things", NoQuery, null, null);

    var request = transport.Requests[0];
    Assert.Equal("Bearer t", request.Headers["Authorization"]);
    Assert.Equal("application/json", request.Headers["Accept"]);
    Assert.Equal("https://api.test/things", request.Url);
  }

  [Fact]
  public async Task MapsStatusesToTypedExceptions()
  {
    var transport = new FakeTransport(FakeTransport.Json(404, "{\"message\":\"no such thing\"}"));
    var error = await Assert.ThrowsAsync<NotFoundException>(
        () => Build(transport).RequestAsync("GET", "/things/x", NoQuery, null, null));
    Assert.Equal(404, error.StatusCode);
    // The server's own words, with no status prefix — the cross-language suite pins this.
    Assert.Equal("no such thing", error.Message);
  }

  [Fact]
  public async Task ReadsRetryAfterOnRateLimit()
  {
    var transport = new FakeTransport(
        FakeTransport.Json(429, "{\"message\":\"slow\"}", ("retry-after", "2")));
    var error = await Assert.ThrowsAsync<RateLimitException>(
        () => Build(transport, 0).RequestAsync("GET", "/things", NoQuery, null, null));
    Assert.Equal(TimeSpan.FromSeconds(2), error.RetryAfter);
  }

  [Fact]
  public async Task LeavesRetryAfterNullWhenItIsAnHttpDate()
  {
    // Unparsed rather than guessed: the backoff already has a sensible default, and a wrong parse would be
    // worse than none.
    var transport = new FakeTransport(
        FakeTransport.Json(429, "{}", ("retry-after", "Wed, 21 Oct 2026 07:28:00 GMT")));
    var error = await Assert.ThrowsAsync<RateLimitException>(
        () => Build(transport, 0).RequestAsync("GET", "/things", NoQuery, null, null));
    Assert.Null(error.RetryAfter);
  }

  // -- retry safety by method (SPEC.md §3.4.0.1) -----------------------------

  [Theory]
  [InlineData("GET")]
  [InlineData("HEAD")]
  [InlineData("PUT")]
  [InlineData("DELETE")]
  [InlineData("OPTIONS")]
  public async Task RetriesMethodsHttpDefinesAsIdempotent(string method)
  {
    var transport = new FakeTransport(FakeTransport.Json(503, "{}"));
    await Assert.ThrowsAsync<InternalServerException>(
        () => Build(transport).RequestAsync(method, "/things", NoQuery, null, null));
    Assert.Equal(3, transport.Requests.Count);
  }

  [Fact]
  public async Task DoesNotRetryPostWithoutAnIdempotencyKey()
  {
    // The bug this pins: a `POST /charges` returning 503 was sent three times, and whether the server
    // processed the first is unknowable from here. The plausible outcome was three charges.
    var transport = new FakeTransport(FakeTransport.Json(503, "{}"));
    await Assert.ThrowsAsync<InternalServerException>(
        () => Build(transport).RequestAsync("POST", "/charges", NoQuery, "{}", null));
    Assert.Single(transport.Requests);
  }

  [Fact]
  public async Task RetriesPostWithAnIdempotencyKeyAndResendsItUnchanged()
  {
    var transport = new FakeTransport(FakeTransport.Json(503, "{}"));
    var options = new RequestOptions { IdempotencyKey = "req_1" };
    await Assert.ThrowsAsync<InternalServerException>(
        () => Build(transport).RequestAsync("POST", "/charges", NoQuery, "{}", options));
    Assert.Equal(3, transport.Requests.Count);
    foreach (var request in transport.Requests)
    {
      // Deduplication happens on the server, so the key must be identical on every attempt.
      Assert.Equal("req_1", request.Headers[Client.DefaultIdempotencyHeader]);
      Assert.Equal("{}", request.Body);
    }
  }

  [Fact]
  public async Task DoesNotRetryA400EvenWithAKey()
  {
    // A 400 was understood and rejected. Resending it is pure load on someone else's service.
    var transport = new FakeTransport(FakeTransport.Json(400, "{}"));
    var options = new RequestOptions { IdempotencyKey = "k" };
    await Assert.ThrowsAsync<BadRequestException>(
        () => Build(transport).RequestAsync("POST", "/things", NoQuery, "{}", options));
    Assert.Single(transport.Requests);
  }

  [Fact]
  public async Task RetriesAConnectionFailureRegardlessOfMethod()
  {
    // A request that never completed left no side effect, so replaying it is safe even for POST — the one
    // retry case an idempotency key does not gate.
    var transport = new FakeTransport(new ConnectionException("reset"));
    await Assert.ThrowsAsync<ConnectionException>(
        () => Build(transport).RequestAsync("POST", "/things", NoQuery, "{}", null));
    Assert.Equal(3, transport.Requests.Count);
  }

  [Fact]
  public async Task HonoursAConfiguredIdempotencyHeader()
  {
    var transport = new FakeTransport(FakeTransport.Json(200, "{}"));
    var client = new Client(new ClientOptions
    {
      BaseUrl = "https://api.test",
      Transport = transport,
      IdempotencyHeader = "X-Idempotency-Key",
      Delay = (_, _) => Task.CompletedTask,
    });
    await client.RequestAsync("POST", "/things", NoQuery, "{}", new RequestOptions { IdempotencyKey = "k" });
    Assert.Equal("k", transport.Requests[0].Headers["X-Idempotency-Key"]);
  }

  [Fact]
  public async Task ClampsANegativeRetryCount()
  {
    // -1 made the Python retry loop run zero times, so every request failed with "no recorded error".
    var transport = new FakeTransport(FakeTransport.Json(200, "{}"));
    var client = new Client(new ClientOptions
    {
      BaseUrl = "https://api.test",
      MaxRetries = -1,
      Transport = transport,
    });
    await client.RequestAsync("GET", "/things", NoQuery, null, null);
    Assert.Single(transport.Requests);
  }

  [Fact]
  public async Task TreatsAnEmptyBodyAsNull()
  {
    var transport = new FakeTransport(new HttpResponseSpec(204, string.Empty, new Dictionary<string, string>()));
    Assert.Null(await Build(transport, 0).RequestJsonAsync("DELETE", "/things/x", NoQuery, null, null));
  }

  [Fact]
  public async Task ClassifiesANonJsonErrorBodyByStatusAlone()
  {
    // An HTML 502 from a proxy is common. The status still classifies it; the body is simply absent.
    var transport = new FakeTransport(
        new HttpResponseSpec(502, "<html>bad gateway</html>", new Dictionary<string, string>()));
    var error = await Assert.ThrowsAsync<InternalServerException>(
        () => Build(transport, 0).RequestAsync("GET", "/things", NoQuery, null, null));
    Assert.Equal(502, error.StatusCode);
    Assert.Null(error.Body);
  }

  [Fact]
  public async Task ACallersOwnCancellationIsNotReportedAsATimeout()
  {
    // .NET reports both as OperationCanceledException, and conflating them would tell a caller their own
    // abort was the server being slow.
    using var source = new CancellationTokenSource();
    await source.CancelAsync();
    var transport = new FakeTransport(FakeTransport.Json(200, "{}"));
    await Assert.ThrowsAnyAsync<OperationCanceledException>(
        () => Build(transport).RequestAsync("GET", "/x", NoQuery, null, null, "application/json", source.Token));
  }
}
