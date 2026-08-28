namespace Besdk.Runtime;

/// <summary>How strictly a response is checked against the shape the spec declared (SPEC.md §3.4.1.1).</summary>
public enum ValidationMode
{
  /// <summary>Throw a <see cref="ResponseValidationException"/> naming the offending field. The default.</summary>
  Strict,

  /// <summary>Log and continue.</summary>
  Warn,

  /// <summary>Skip the check.</summary>
  Off,
}

/// <summary>
/// One validation descriptor.
/// </summary>
/// <remarks>
/// <para>
/// An abstract record hierarchy, which C# pattern-matches exhaustively in a <c>switch</c> expression the same
/// way Java's sealed interface does. Generated code builds these from the compact descriptor table it ships;
/// the table is data, and this hand-written walker interprets it — one reviewed interpreter beats a validator
/// generated per type.
/// </para>
/// </remarks>
public abstract record Schema
{
  /// <summary>Accepts anything. What an unmodelled or unreachable type degrades to.</summary>
  public sealed record Any : Schema;

  /// <inheritdoc cref="Schema"/>
  public sealed record Str : Schema;

  /// <summary>An RFC 3339 timestamp. Validated as a string; the model decodes it.</summary>
  public sealed record Date : Schema;

  /// <inheritdoc cref="Schema"/>
  public sealed record Num : Schema;

  /// <inheritdoc cref="Schema"/>
  public sealed record Int : Schema;

  /// <inheritdoc cref="Schema"/>
  public sealed record Bool : Schema;

  /// <inheritdoc cref="Schema"/>
  public sealed record Arr(Schema Items) : Schema;

  /// <inheritdoc cref="Schema"/>
  public sealed record MapOf(Schema Values) : Schema;

  /// <summary>Null is permitted in addition to the inner shape.</summary>
  public sealed record Nullable(Schema Inner) : Schema;

  /// <summary>Any one branch matching is enough. <c>anyOf</c> and <c>oneOf</c> validate identically (§3.1.7).</summary>
  public sealed record Or(IReadOnlyList<Schema> Branches) : Schema;

  /// <summary>A reference into the table, which is how a cycle terminates without recursing forever.</summary>
  public sealed record Ref(string Name) : Schema;

  /// <inheritdoc cref="Schema"/>
  public sealed record Obj(IReadOnlyList<Field> Fields, Schema? Additional) : Schema;

  /// <summary>One field of an object.</summary>
  public sealed record Field(string WireName, Schema Schema, bool Required);

  /// <summary>Parse the compact JSON form the generated table ships in.</summary>
  public static IReadOnlyDictionary<string, Schema> Table(string json)
  {
    if (Json.Parse(json) is not IDictionary<string, object?> map)
    {
      throw new DecodeException("schema table was not an object");
    }

    var result = new Dictionary<string, Schema>();
    foreach (var (name, descriptor) in map)
    {
      result[name] = Node(descriptor);
    }

    return result;
  }

  /// <summary>Parse one compact descriptor.</summary>
  public static Schema Of(string json) => Node(Json.Parse(json));

  private static Schema Node(object? value)
  {
    if (value is not IDictionary<string, object?> map)
    {
      return new Any();
    }

    var kind = map.TryGetValue("k", out var k) && k is string text ? text : "any";
    return kind switch
    {
      "str" => new Str(),
      "date" => new Date(),
      "num" => new Num(),
      "int" => new Int(),
      "bool" => new Bool(),
      "arr" => new Arr(Node(Get(map, "i"))),
      "map" => new MapOf(Node(Get(map, "v"))),
      "null" => new Nullable(Node(Get(map, "i"))),
      "or" => new Or(ParseBranches(Get(map, "o"))),
      "ref" => new Ref(Get(map, "n") as string ?? string.Empty),
      "obj" => new Obj(ParseFields(Get(map, "f")), map.ContainsKey("a") ? Node(Get(map, "a")) : null),
      _ => new Any(),
    };
  }

  private static object? Get(IDictionary<string, object?> map, string key) =>
      map.TryGetValue(key, out var value) ? value : null;

  // Named `Parse*` rather than `Branches`/`Fields`: a positional record parameter creates a property of
  // that name on the nested type, and an inherited static method with the same name on the enclosing class
  // is a compile error.
  private static List<Schema> ParseBranches(object? value)
  {
    var result = new List<Schema>();
    if (value is System.Collections.IEnumerable items and not string)
    {
      foreach (var item in items)
      {
        result.Add(Node(item));
      }
    }

    return result;
  }

  private static List<Field> ParseFields(object? value)
  {
    var result = new List<Field>();
    if (value is not System.Collections.IEnumerable items || value is string)
    {
      return result;
    }

    foreach (var item in items)
    {
      if (item is not IList<object?> triple || triple.Count == 0)
      {
        continue;
      }

      var name = triple[0] as string ?? string.Empty;
      var schema = triple.Count > 1 ? Node(triple[1]) : new Any();
      // A third element, present and equal to 1, marks the field required. Absent means optional, which
      // keeps the common case one element shorter across thousands of entries.
      var required = triple.Count > 2 && triple[2] is long flag && flag == 1;
      result.Add(new Field(name, schema, required));
    }

    return result;
  }
}
