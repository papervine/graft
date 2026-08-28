using Besdk.Runtime;

namespace Besdk.Target.Dotnet;

/// <summary>
/// The target protocol entry point (SPEC.md §3.5).
/// </summary>
/// <remarks>
/// <para>
/// <c>besdk-target-dotnet --sdk-target-protocol</c> prints a handshake; with no flag it reads IR JSON on stdin and
/// writes a manifest on stdout.
/// </para>
/// <para>
/// Nothing here imports anything from besdk's core: the contract is the JSON, which is what makes a target in
/// <i>any</i> language possible. The one thing it shares with the runtime is the JSON layer, which is a build
/// dependency of the generator rather than a runtime dependency of generated SDKs.
/// </para>
/// </remarks>
internal static class Program
{
  public static int Main(string[] args)
  {
    // stdout is the protocol channel, so every diagnostic goes to stderr. A stray write would corrupt the
    // manifest in a way that reads as "the target produced invalid JSON".
    if (args.Contains(Handshake.Flag, StringComparer.Ordinal))
    {
      Console.Out.WriteLine(Json.Write(Handshake.Describe()));
      return 0;
    }

    var stdin = Console.In.ReadToEnd();
    if (string.IsNullOrWhiteSpace(stdin))
    {
      Console.Error.WriteLine("besdk-target-dotnet: expected IR JSON on stdin");
      return 2;
    }

    IDictionary<string, object?> payload;
    try
    {
      payload = Ir.Obj(Json.Parse(stdin));
    }
    catch (DecodeException error)
    {
      Console.Error.WriteLine("besdk-target-dotnet: stdin was not valid JSON: " + error.Message);
      return 2;
    }

    var ir = Ir.Obj(Ir.Get(payload, "ir"));
    if (ir.Count == 0)
    {
      Console.Error.WriteLine("besdk-target-dotnet: payload had no `ir` object");
      return 2;
    }

    var brand = Ir.Obj(Ir.Get(payload, "brand"));
    if (Ir.StrOrNull(Ir.Get(brand, "generatedNotice")) is null)
    {
      // Required rather than defaulted: a hardcoded fallback would put this project's name in files a
      // consumer commits, which is the one place it must never appear (SPEC.md §1.2).
      Console.Error.WriteLine("besdk-target-dotnet: payload had no `brand.generatedNotice`");
      return 2;
    }

    var emitter = new Emitter(ir, Ir.Obj(Ir.Get(payload, "options")), brand);
    List<EmittedFile> files;
    try
    {
      files = emitter.Emit(LoadRuntime());
    }
    catch (Exception error) when (error is InvalidOperationException or IOException)
    {
      Console.Error.WriteLine("besdk-target-dotnet: " + error.Message);
      return 70;
    }

    var manifest = files
        .Select(file => (object?)new Dictionary<string, object?>
        {
          ["path"] = file.Path,
          ["contents"] = file.Contents,
        })
        .ToList();

    Console.Out.WriteLine(Json.Write(new Dictionary<string, object?>
    {
      ["files"] = manifest,
      ["warnings"] = emitter.Warnings.Select(warning => (object?)warning).ToList(),
    }));
    return 0;
  }

  /// <summary>
  /// The hand-written runtime's sources, for vendoring into the output.
  /// </summary>
  /// <remarks>
  /// Read from disk rather than inlined as string constants, so the runtime stays a normal reviewable library that
  /// its own test suite exercises (SPEC.md §3.3).
  /// </remarks>
  private static Dictionary<string, string> LoadRuntime()
  {
    var candidates = new List<string?>
        {
            Environment.GetEnvironmentVariable("SDK_DOTNET_RUNTIME"),
            "packages/runtime-dotnet/src",
            "../runtime-dotnet/src",
        };

    foreach (var candidate in candidates)
    {
      if (candidate is null || !Directory.Exists(candidate))
      {
        continue;
      }

      var files = new Dictionary<string, string>(StringComparer.Ordinal);
      foreach (var path in Directory.EnumerateFiles(candidate, "*.cs").OrderBy(p => p, StringComparer.Ordinal))
      {
        files[Path.GetFileName(path)] = File.ReadAllText(path);
      }

      if (files.Count > 0)
      {
        return files;
      }
    }

    throw new InvalidOperationException(
        "no runtime sources found; set SDK_DOTNET_RUNTIME to the runtime-dotnet src directory");
  }
}
