namespace Besdk.Target.Dotnet;

/// <summary>
/// What this target tells the core about itself (SPEC.md §3.5).
/// </summary>
/// <remarks>
/// The flag the core probes with carries no project name on purpose: a target hardcodes it because it cannot import
/// the constant that owns it, which makes it a promise to third-party target authors rather than an internal
/// detail (§1.2).
/// </remarks>
internal static class Handshake
{
  public const string Flag = "--sdk-target-protocol";

  public static Dictionary<string, object?> Describe() => new()
  {
    ["name"] = "dotnet",
    ["displayName"] = ".NET",
    ["version"] = "0.0.0",
    // Kept in step with `packages/protocol/src/branding.ts`. A mismatch is a hard error in the core rather than
    // a warning, because a target reading an IR it does not understand produces a subtly wrong SDK.
    ["irVersions"] = new List<object?> { "1.x" },
    // What this target actually emits — no more, and no less. `binary-responses` because a binary or textual
    // body is returned as the raw string. Absent on purpose: `streaming`, because a streaming method is skipped
    // with a warning rather than emitted as something that cannot work; `sync-and-async`, because there is one
    // async surface and that is deliberate — a synchronous overload would ship a `.Result` deadlock
    // (SPEC.md §3.3.11).
    ["capabilities"] = new List<object?>
    {
      "pagination", "binary-responses", "multipart-requests", "read-write-split",
    },
    ["lineComment"] = "//",
    ["gates"] = Gates(),
  };

  /// <summary>
  /// Verification gates for generated C#.
  /// </summary>
  /// <remarks>
  /// <para>
  /// <c>dotnet format</c> first: a formatting diff is cheap to report and would otherwise be buried under build
  /// output. Then <c>dotnet build</c>, which carries the generated project's own <c>Nullable</c> setting —
  /// nullable-reference warnings are what make <c>T?</c> load-bearing rather than documentation.
  /// </para>
  /// <para>
  /// <c>dotnet</c> is resolved from this process's own environment as an absolute path, which the protocol
  /// explicitly asks for: a target knows where its own tools are and the core does not.
  /// </para>
  /// </remarks>
  private static List<object?> Gates()
  {
    var gates = new List<object?>();
    var dotnet = DotnetPath();
    if (dotnet is null)
    {
      // No gate at all rather than one that fails for the wrong reason. `optional` cannot save a command
      // invoked through a launcher, which is the lesson the PHP target paid for.
      return gates;
    }

    gates.Add(new Dictionary<string, object?>
    {
      ["name"] = "dotnet format",
      ["command"] = new List<object?> { dotnet, "format", "--verbosity", "quiet" },
      // A formatter's exit code is not a verdict on the output; see `Handshake.gates.kind`.
      ["kind"] = "fix",
      ["optional"] = true,
    });

    gates.Add(new Dictionary<string, object?>
    {
      ["name"] = "dotnet build (nullable, warnings as errors)",
      ["command"] = new List<object?>
            {
                dotnet, "build", "--nologo", "--verbosity", "quiet", "-warnaserror",
            },
      // Never optional. Skipping the compiler removes the guarantee the whole pipeline is premised on.
      ["kind"] = "verify",
    });

    gates.Add(new Dictionary<string, object?>
    {
      ["name"] = "generated tests",
      // Pointed at the test project explicitly: `dotnet test` with no argument in the package root finds
      // the *library*, which has no tests, and reports that as an error.
      ["command"] = new List<object?>
            {
                dotnet, "test", "tests", "--nologo", "--verbosity", "quiet",
            },
      ["kind"] = "verify",
      // Optional, unlike the build: the test project references xUnit from NuGet, and a first generation on
      // a machine that cannot restore it should not fail. Failing generation over an absent dev dependency
      // would make the feature a liability (SPEC.md §3.11).
      ["optional"] = true,
    });

    return gates;
  }

  /// <summary>
  /// The <c>dotnet</c> this process is running under, or one on <c>PATH</c>.
  /// </summary>
  /// <remarks>
  /// The running process's own host is preferred: it is guaranteed to be the SDK version that produced this
  /// target, where a <c>PATH</c> lookup may find an older one.
  /// </remarks>
  private static string? DotnetPath()
  {
    var host = Environment.ProcessPath;
    if (host is not null && Path.GetFileNameWithoutExtension(host) == "dotnet" && File.Exists(host))
    {
      return host;
    }

    var pathVariable = Environment.GetEnvironmentVariable("PATH");
    if (pathVariable is null)
    {
      return null;
    }

    foreach (var directory in pathVariable.Split(Path.PathSeparator))
    {
      var candidate = Path.Combine(directory, "dotnet");
      if (File.Exists(candidate))
      {
        return candidate;
      }
    }

    return null;
  }
}
