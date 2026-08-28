using System.Globalization;
using System.Text;

namespace Besdk.Target.Dotnet;

/// <summary>
/// Turning IR token sequences into C# identifiers.
/// </summary>
/// <remarks>
/// <para>
/// .NET is the only target here that capitalises <i>members</i>: methods, properties, and events are all
/// <c>PascalCase</c>, where every other language uses <c>camelCase</c> for at least some of them. Parameters and
/// locals stay <c>camelCase</c>.
/// </para>
/// <para>
/// That makes this the clearest payoff of names-as-token-sequences: the same IR name becomes <c>UserId</c> here,
/// <c>UserID</c> in Go, <c>userId</c> in Java and TypeScript, and <c>user_id</c> in Python — with no coordination
/// between the targets.
/// </para>
/// </remarks>
internal static class Naming
{
  /// <summary>
  /// C#'s reserved words.
  /// </summary>
  /// <remarks>
  /// Contextual keywords — <c>record</c>, <c>async</c>, <c>value</c>, <c>required</c> — are deliberately absent:
  /// they are legal identifiers, and renaming a property the spec called <c>value</c> would be gratuitous.
  /// </remarks>
  private static readonly HashSet<string> Reserved = new(StringComparer.Ordinal)
    {
        "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked", "class", "const",
        "continue", "decimal", "default", "delegate", "do", "double", "else", "enum", "event", "explicit",
        "extern", "false", "finally", "fixed", "float", "for", "foreach", "goto", "if", "implicit", "in", "int",
        "interface", "internal", "is", "lock", "long", "namespace", "new", "null", "object", "operator", "out",
        "override", "params", "private", "protected", "public", "readonly", "ref", "return", "sbyte", "sealed",
        "short", "sizeof", "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true", "try",
        "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "virtual", "void", "volatile",
        "while",
    };

  /// <summary>A type or member name: <c>PascalCase</c>.</summary>
  public static string Pascal(IReadOnlyList<string> tokens)
  {
    var builder = new StringBuilder();
    foreach (var token in tokens)
    {
      builder.Append(Capitalise(token));
    }

    var name = builder.ToString();
    if (name.Length == 0)
    {
      return "Value";
    }

    if (char.IsDigit(name[0]))
    {
      // `2FactorAuth` is not an identifier. Prefixed rather than stripped, because the digit is usually
      // meaningful.
      return "N" + name;
    }

    // A PascalCase name can only collide with a keyword if the keyword is capitalised, which none are — but a
    // single-token name like `class` becomes `Class`, which is fine. Kept as a guard for the tokenless case.
    return name;
  }

  /// <summary>A parameter or local: <c>camelCase</c>, escaped when it collides with a keyword.</summary>
  public static string Camel(IReadOnlyList<string> tokens)
  {
    var pascal = Pascal(tokens);
    var name = char.ToLowerInvariant(pascal[0]) + pascal[1..];
    if (char.IsDigit(name[0]))
    {
      return "n" + pascal;
    }

    // `@` rather than a rename: C# has a verbatim-identifier escape precisely for this, and `@class` reads
    // better than `classValue` while keeping the spec's own word.
    return Reserved.Contains(name) ? "@" + name : name;
  }

  /// <summary>
  /// A namespace from a package name.
  /// </summary>
  /// <remarks>
  /// <c>Acme.Sdk</c> from <c>Acme.Sdk</c>, and <c>Acme.WidgetSdk</c> from <c>acme-widget-sdk</c>. Each segment is
  /// PascalCased, because .NET namespaces are PascalCase by convention — unlike Java's all-lowercase.
  /// </remarks>
  public static string Namespace(string value)
  {
    var parts = new List<string>();
    foreach (var segment in value.Split('.', '/', ':'))
    {
      var words = segment.Split('-', '_', ' ');
      var joined = new StringBuilder();
      foreach (var word in words)
      {
        joined.Append(Capitalise(word));
      }

      if (joined.Length > 0)
      {
        parts.Add(char.IsDigit(joined[0]) ? "N" + joined : joined.ToString());
      }
    }

    return parts.Count == 0 ? "Sdk" : string.Join('.', parts);
  }

  /// <summary>An enum member: <c>PascalCase</c>, which is .NET's convention rather than SCREAMING_SNAKE.</summary>
  public static string EnumMember(IReadOnlyList<string> tokens) => Pascal(tokens);

  private static string Capitalise(string token)
  {
    var clean = new string(token.Where(char.IsLetterOrDigit).ToArray());
    if (clean.Length == 0)
    {
      return string.Empty;
    }

    return char.ToUpperInvariant(clean[0]) + clean[1..].ToLowerInvariant() is var lowered && clean.Length > 1
        // Preserve interior capitals when the token already has them (`OpenAI` stays `OpenAI`), but
        // lowercase an all-caps token so `API` becomes `Api` — which is .NET's own convention for
        // initialisms longer than two letters.
        ? char.ToUpperInvariant(clean[0]) + (clean[1..].All(char.IsUpper) ? clean[1..].ToLowerInvariant() : clean[1..])
        : lowered;
  }

  /// <summary>Uppercase for an environment variable: <c>ACME_TOKEN</c>.</summary>
  public static string ScreamingSnake(IReadOnlyList<string> tokens) =>
      string.Join('_', tokens.Select(token => token.ToUpperInvariant()));
}
