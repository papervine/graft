namespace Graft.Target.Dotnet;

/// <summary>
/// IR type references to C# types.
/// </summary>
/// <remarks>
/// <para>
/// Nullability is expressed with <c>?</c> under <c>#nullable enable</c>, which is the analogue of a strict
/// typechecker elsewhere: a nullability warning is an error in generated packages, so <c>T?</c> is enforced rather
/// than documented (SPEC.md §3.3.11).
/// </para>
/// <para>
/// Unlike Java, boxing is not a concern — a nullable value type is <c>long?</c>, a distinct type the compiler
/// understands, rather than a boxed <c>Long</c> that loses the distinction.
/// </para>
/// </remarks>
internal sealed class TypeMapper
{
  private readonly Dictionary<string, IDictionary<string, object?>> _byId = new(StringComparer.Ordinal);
  private readonly Dictionary<string, string> _names = new(StringComparer.Ordinal);

  public TypeMapper(IDictionary<string, object?> ir)
  {
    var taken = new HashSet<string>(StringComparer.Ordinal);
    foreach (var type in Ir.Objects(Ir.Get(ir, "types")))
    {
      var id = Ir.StrOrNull(Ir.Get(type, "id"));
      if (id is null)
      {
        continue;
      }

      _byId[id] = type;
      var candidate = Naming.Pascal(Ir.Tokens(Ir.Get(type, "name")));
      // A collision would produce two types with one name in one namespace, which does not compile.
      var unique = candidate;
      var suffix = 2;
      while (!taken.Add(unique))
      {
        unique = candidate + suffix++;
      }

      _names[id] = unique;
    }
  }

  public IReadOnlyDictionary<string, IDictionary<string, object?>> Types => _byId;

  public string NameOf(string id) => _names.TryGetValue(id, out var name) ? name : "object";

  public bool IsEnum(string id) =>
      _byId.TryGetValue(id, out var type) && Ir.Str(Ir.Get(type, "kind")) == "enum";

  public bool IsObject(string id) =>
      _byId.TryGetValue(id, out var type) && Ir.Str(Ir.Get(type, "kind")) == "object";

  /// <summary>The C# type for a reference, with <c>?</c> when the value may be absent or null.</summary>
  public string Render(IDictionary<string, object?> reference, bool required)
  {
    var rendered = Inner(reference);
    if (required || rendered.EndsWith('?'))
    {
      return rendered;
    }

    // `object` is *not* exempt, though it looks like it should be: a JSON value can genuinely be null, so an
    // optional one is `object?`. Exempting it produced `IReadOnlyList<object>` declared against a decoder
    // yielding `IReadOnlyList<object?>`, which nullable analysis rejects — CS8619, and correctly.
    return rendered + "?";
  }

  private string Inner(IDictionary<string, object?> reference)
  {
    var kind = Ir.Str(Ir.Get(reference, "kind"), "unknown");
    return kind switch
    {
      "primitive" => Primitive(reference),
      "array" => $"IReadOnlyList<{Render(Sub(reference, "items"), false)}>",
      "map" => $"IReadOnlyDictionary<string, {Render(Sub(reference, "values"), false)}>",
      "nullable" => Render(Sub(reference, "inner"), false),
      "named" => Named(reference),
      "binary" or "text" => "string",
      "literal" => Literal(reference),
      // C# has no anonymous union. `object` matches what Go and Java do with the same input.
      "union" or "null" => "object",
      _ => "object",
    };
  }

  private static string Primitive(IDictionary<string, object?> reference)
  {
    var type = Ir.Str(Ir.Get(reference, "type"));
    var format = Ir.Str(Ir.Get(reference, "format"));
    return type switch
    {
      // `DateTimeOffset`, not `DateTime`: a wire timestamp carries an offset, and `DateTime` silently
      // discards it — which is among the most common sources of off-by-hours bugs in .NET.
      "string" => format == "date-time" ? "DateTimeOffset" : "string",
      "integer" => format == "int32" ? "int" : "long",
      "number" => "double",
      "boolean" => "bool",
      _ => "object",
    };
  }

  private string Named(IDictionary<string, object?> reference)
  {
    var id = Ir.Str(Ir.Get(reference, "id"));
    if (!_byId.TryGetValue(id, out var type))
    {
      return "object";
    }

    // An alias resolves to its target: it has no type of its own, so a reference to it would name nothing.
    if (Ir.Str(Ir.Get(type, "kind")) == "alias")
    {
      return Render(Ir.Obj(Ir.Get(type, "target")), true);
    }

    return NameOf(id);
  }

  private static string Literal(IDictionary<string, object?> reference) => Ir.Get(reference, "value") switch
  {
    string => "string",
    bool => "bool",
    not null => "long",
    _ => "object",
  };

  /// <summary>Which namespaces a rendered type needs.</summary>
  public static IEnumerable<string> UsingsFor(string rendered)
  {
    // `System` and `System.Collections.Generic` are implicit, so `DateTimeOffset` and `IReadOnlyList` need
    // nothing — which is why this returns almost always empty and exists for the cases that do not.
    yield break;
  }

  private IDictionary<string, object?> Sub(IDictionary<string, object?> reference, string key)
  {
    var value = Ir.Obj(Ir.Get(reference, key));
    return value.Count == 0 ? new Dictionary<string, object?> { ["kind"] = "unknown" } : value;
  }
}
