using Acme.KitchenSink;
using Acme.KitchenSink.Core;

/// <summary>
/// The .NET conformance driver.
/// </summary>
/// <remarks>
/// <para>
/// Runs every shared scenario against the mock server using the <i>generated</i> SDK, and prints what it observed
/// as JSON on stdout. The runner compares that against the scenario expectations and against the other languages'
/// drivers.
/// </para>
/// <para>
/// Calls are written natively — <c>await client.Orgs.ListMembers("o1", limit: 2)</c> — because the point is that
/// idiomatic code in each language produces identical wire behaviour. A data-driven driver dispatching on operation
/// names would prove nothing about idiom.
/// </para>
/// </remarks>
internal static class Driver
{
    private static string _baseUrl = string.Empty;

    /// <summary>A client pinned to one scenario, so the server knows which script to replay.</summary>
    private static KitchenSinkClient Client(string scenario, int maxRetries = 0) =>
        new(
            apiKey: "key_conformance",
            baseUrl: _baseUrl,
            maxRetries: maxRetries,
            defaultHeaders: new Dictionary<string, string> { ["X-Scenario"] = scenario });

    /// <summary>
    /// The first path a validation failure reports.
    /// </summary>
    /// <remarks>
    /// Each runtime words its message differently; the <i>path</i> is the part that must agree across languages, so
    /// the comparison is about behaviour rather than each library's formatting.
    /// </remarks>
    private static string FirstPath(ResponseValidationException error)
    {
        var problem = error.Problems.Count == 0 ? string.Empty : error.Problems[0];
        var space = problem.IndexOf(' ', StringComparison.Ordinal);
        return space < 0 ? problem : problem[..space];
    }

    private static async Task<int> Main(string[] args)
    {
        if (args.Length < 1)
        {
            await Console.Error.WriteLineAsync("usage: dotnet-driver <baseURL>");
            return 2;
        }

        _baseUrl = args[0];

        var scenarios = new Dictionary<string, Func<Task<Dictionary<string, object?>>>>
        {
            ["list_categories"] = async () =>
            {
                var categories = await Client("list_categories").Categories.ListAsync();
                return new Dictionary<string, object?>
                {
                    ["count"] = categories.Count.ToString(),
                    ["first_slug"] = categories[0].Slug,
                    ["second_name"] = categories[1].Name,
                };
            },
            ["paginate_members"] = async () =>
            {
                var emails = new List<string>();
                await foreach (var member in Client("paginate_members").Orgs.ListMembers("o1", limit: 2))
                {
                    emails.Add(member.Email);
                }

                return new Dictionary<string, object?>
                {
                    ["emails"] = string.Join(',', emails),
                    ["count"] = emails.Count.ToString(),
                };
            },
            ["query_serialization"] = async () =>
            {
                // `since` is deliberately omitted: an absent optional parameter must not reach the wire at all.
                var results = await Client("query_serialization").Search.QueryAsync("sprocket", QueryKind.Member);
                return new Dictionary<string, object?> { ["count"] = results.Count.ToString() };
            },
            ["path_escaping"] = async () =>
            {
                var pdf = await Client("path_escaping").Orgs.Invoices.DownloadPdfAsync("a/b", "i1");
                return new Dictionary<string, object?> { ["byte_length"] = pdf.Length.ToString() };
            },
            ["error_404"] = async () =>
            {
                try
                {
                    // Draining is required: the paginator is lazy, so the request happens on enumeration.
                    await Client("error_404").Orgs.ListMembers("missing").AllAsync();
                }
                catch (NotFoundException error)
                {
                    return new Dictionary<string, object?>
                    {
                        ["error_kind"] = "not_found",
                        ["status"] = error.StatusCode.ToString(),
                        ["message"] = error.Message,
                        ["request_id"] = error.RequestId,
                    };
                }
                catch (SdkException error)
                {
                    return Wrong(error);
                }

                return None();
            },
            ["retry_then_success"] = async () =>
            {
                // An idempotency key, because a POST without one is no longer retried.
                var receipt = await Client("retry_then_success", 2).Events.PublishAsync(
                    new Dictionary<string, object?> { ["type"] = "widget.created" },
                    new RequestOptions { IdempotencyKey = "conformance_1" });
                return new Dictionary<string, object?>
                {
                    ["accepted"] = receipt.Accepted.ToString().ToLowerInvariant(),
                    ["event_id"] = receipt.EventId,
                };
            },
            ["no_retry_without_idempotency_key"] = async () =>
            {
                try
                {
                    await Client("no_retry_without_idempotency_key", 2).Events.PublishAsync(
                        new Dictionary<string, object?> { ["type"] = "widget.created" });
                }
                catch (InternalServerException)
                {
                    return new Dictionary<string, object?> { ["error_kind"] = "server_error" };
                }
                catch (SdkException error)
                {
                    return Wrong(error);
                }

                return None();
            },
            ["no_retry_on_400"] = async () =>
            {
                try
                {
                    await Client("no_retry_on_400", 2).Events.PublishAsync(
                        new Dictionary<string, object?> { ["type"] = "widget.created" });
                }
                catch (BadRequestException)
                {
                    return new Dictionary<string, object?> { ["error_kind"] = "bad_request" };
                }
                catch (SdkException error)
                {
                    return Wrong(error);
                }

                return None();
            },
            ["validation_catches_a_broken_contract"] = async () =>
            {
                try
                {
                    await Client("validation_catches_a_broken_contract").Categories.ListAsync();
                }
                catch (ResponseValidationException error)
                {
                    return new Dictionary<string, object?>
                    {
                        ["error_kind"] = "validation",
                        ["path"] = FirstPath(error),
                    };
                }
                catch (SdkException error)
                {
                    return Wrong(error);
                }

                return None();
            },
            ["validation_on_a_paginated_response"] = async () =>
            {
                try
                {
                    await Client("validation_on_a_paginated_response").Orgs.ListMembers("o1").AllAsync();
                }
                catch (ResponseValidationException error)
                {
                    // The field, not the full path: each language indexes the enclosing list differently, and the
                    // field is what the comparison is about.
                    var path = FirstPath(error);
                    var dot = path.LastIndexOf('.');
                    return new Dictionary<string, object?>
                    {
                        ["error_kind"] = "validation",
                        ["path"] = dot < 0 ? path : path[(dot + 1)..],
                    };
                }
                catch (SdkException error)
                {
                    return Wrong(error);
                }

                return None();
            },
            ["validation_allows_an_additive_field"] = async () =>
            {
                var categories = await Client("validation_allows_an_additive_field").Categories.ListAsync();
                return new Dictionary<string, object?>
                {
                    ["count"] = categories.Count.ToString(),
                    ["first_slug"] = categories[0].Slug,
                };
            },
            ["text_response"] = async () =>
            {
                var csv = await Client("text_response").Reports.ExportUsageAsync();
                var lines = csv.TrimEnd('\n').Split('\n');
                return new Dictionary<string, object?>
                {
                    ["text_starts_with"] = lines[0],
                    ["line_count"] = lines.Length.ToString(),
                };
            },
        };

        var observed = new Dictionary<string, object?>();
        foreach (var (name, run) in scenarios)
        {
            try
            {
                observed[name] = await run();
            }
            catch (Exception error)
            {
                // A driver reports failures, never raises: one broken scenario must not hide the other eleven.
                observed[name] = new Dictionary<string, object?>
                {
                    ["_error"] = error.GetType().Name + ": " + error.Message,
                };
            }
        }

        Console.Out.WriteLine(Json.Write(new Dictionary<string, object?>
        {
            ["language"] = "dotnet",
            ["observed"] = observed,
        }));
        return 0;
    }

    private static Dictionary<string, object?> Wrong(Exception error) =>
        new() { ["error_kind"] = "wrong:" + error.GetType().Name };

    private static Dictionary<string, object?> None() => new() { ["error_kind"] = "none" };
}
