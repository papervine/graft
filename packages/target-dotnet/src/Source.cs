using System.Text;

namespace Graft.Target.Dotnet;

/// <summary>
/// A C# source file under construction.
/// </summary>
/// <remarks>
/// <para>
/// Not Roslyn's <c>SyntaxFactory</c>, and this is the fourth target to reach the same conclusion (SPEC.md §3.3.4
/// states it as a rule). Roslyn <i>is</i> designed for synthesis, unlike Java's and Go's ASTs — but its output is
/// then normalised by <c>dotnet format</c> anyway, so the AST buys layout this project does not keep, at the cost
/// of a builder call per token. What it would genuinely buy — managed usings — is a dozen lines here.
/// </para>
/// <para>
/// The property that matters is preserved: layout is decided by the canonical formatter, so output matches what a
/// .NET developer's IDE produces.
/// </para>
/// </remarks>
internal sealed class Source
{
  private readonly string _namespace;
  private readonly string? _notice;
  private readonly SortedSet<string> _usings = new(StringComparer.Ordinal);
  private readonly List<string> _declarations = new();

  /// <summary>
  /// A new file in the given namespace.
  /// </summary>
  /// <remarks>
  /// The generated notice is a plain <c>//</c> comment above the usings, not part of the type's doc comment.
  /// Putting it in <c>summary</c> made "Code generated. DO NOT EDIT." the text IntelliSense showed for every
  /// model — burying the description the spec actually provided.
  /// </remarks>
  public Source(string namespaceName, string? notice = null)
  {
    _namespace = namespaceName;
    _notice = notice;
  }

  /// <summary>Register a <c>using</c>. Anything implicit or in this file's own namespace is dropped.</summary>
  public void AddUsing(string name)
  {
    if (string.IsNullOrEmpty(name) || name == _namespace)
    {
      return;
    }

    // `ImplicitUsings` already covers these, and a redundant using is a warning — which is an error here.
    if (name is "System" or "System.Collections.Generic" or "System.Linq" or "System.Threading"
        or "System.Threading.Tasks")
    {
      return;
    }

    _usings.Add(name);
  }

  public void AddUsings(IEnumerable<string> names)
  {
    foreach (var name in names)
    {
      AddUsing(name);
    }
  }

  public void Add(string declaration) => _declarations.Add(declaration.TrimEnd());

  public string Render()
  {
    var builder = new StringBuilder();
    if (_notice is not null)
    {
      builder.Append("// ").Append(_notice).Append("\n\n");
    }

    foreach (var name in _usings)
    {
      builder.Append("using ").Append(name).Append(";\n");
    }

    if (_usings.Count > 0)
    {
      builder.Append('\n');
    }

    // A file-scoped namespace, which is the modern default and removes a level of indentation from every line
    // of every generated file.
    builder.Append("namespace ").Append(_namespace).Append(";\n");

    foreach (var declaration in _declarations)
    {
      builder.Append('\n').Append(declaration).Append('\n');
    }

    return builder.ToString();
  }

  /// <summary>
  /// Render lines as an XML doc comment at the given indentation.
  /// </summary>
  /// <remarks>
  /// An empty line separates paragraphs. The first paragraph becomes the <c>summary</c> and the rest become
  /// <c>remarks</c> with each wrapped in <c>para</c> — which is both the idiomatic shape and the only valid one:
  /// emitting a bare <c>&lt;para&gt;</c> on the blank line left it unclosed, and a doc comment is XML, so
  /// <c>CS1570</c> failed the build. Caught by the generated project's own compiler gate.
  /// </remarks>
  public static string Doc(IReadOnlyList<string> lines, int indent)
  {
    if (lines.Count == 0)
    {
      return string.Empty;
    }

    var blocks = new List<List<string>> { new() };
    foreach (var line in lines)
    {
      if (line.Length == 0)
      {
        blocks.Add(new List<string>());
        continue;
      }

      blocks[^1].Add(line);
    }

    blocks.RemoveAll(block => block.Count == 0);
    if (blocks.Count == 0)
    {
      return string.Empty;
    }

    var pad = new string(' ', indent);
    var builder = new StringBuilder();
    builder.Append(pad).Append("/// <summary>\n");
    foreach (var line in blocks[0])
    {
      builder.Append(pad).Append("/// ").Append(line).Append('\n');
    }

    builder.Append(pad).Append("/// </summary>\n");

    if (blocks.Count > 1)
    {
      builder.Append(pad).Append("/// <remarks>\n");
      foreach (var block in blocks.Skip(1))
      {
        builder.Append(pad).Append("/// <para>\n");
        foreach (var line in block)
        {
          builder.Append(pad).Append("/// ").Append(line).Append('\n');
        }

        builder.Append(pad).Append("/// </para>\n");
      }

      builder.Append(pad).Append("/// </remarks>\n");
    }

    return builder.ToString();
  }

  /// <summary>
  /// Collapse prose from a spec into doc-comment lines.
  /// </summary>
  /// <remarks>
  /// XML-escaped, because a doc comment is XML and an unescaped <c>&lt;</c> makes the build fail under
  /// warnings-as-errors. Specs are careless with whitespace, so text is normalised rather than passed through.
  /// </remarks>
  public static List<string> Prose(string? summary, string? description)
  {
    var lines = new List<string>();
    var parts = new List<string>();
    if (!string.IsNullOrWhiteSpace(summary))
    {
      parts.Add(summary.Trim());
    }

    if (!string.IsNullOrWhiteSpace(description) && description.Trim() != summary?.Trim())
    {
      parts.Add(description.Trim());
    }

    foreach (var part in parts)
    {
      if (lines.Count > 0)
      {
        lines.Add(string.Empty);
      }

      lines.AddRange(Wrapped(part));
    }

    return lines;
  }

  private static List<string> Wrapped(string text)
  {
    var clean = System.Text.RegularExpressions.Regex.Replace(
        text.Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal),
        @"\s+",
        " ").Trim();

    var result = new List<string>();
    var line = new StringBuilder();
    foreach (var word in clean.Split(' '))
    {
      if (line.Length > 0 && line.Length + word.Length + 1 > 96)
      {
        result.Add(line.ToString());
        line.Clear();
      }

      if (line.Length > 0)
      {
        line.Append(' ');
      }

      line.Append(word);
    }

    if (line.Length > 0)
    {
      result.Add(line.ToString());
    }

    return result.Count == 0 ? new List<string> { clean } : result;
  }

  /// <summary>A C# string literal, escaped.</summary>
  public static string Quote(string value)
  {
    var builder = new StringBuilder("\"");
    foreach (var c in value)
    {
      builder.Append(c switch
      {
        '"' => "\\\"",
        '\\' => "\\\\",
        '\n' => "\\n",
        '\r' => "\\r",
        '\t' => "\\t",
        _ => c.ToString(),
      });
    }

    return builder.Append('"').ToString();
  }
}
