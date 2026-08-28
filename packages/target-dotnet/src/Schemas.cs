namespace Besdk.Target.Dotnet;

/// <summary>
/// Planning the validation descriptor table (SPEC.md §3.4.1.1).
/// </summary>
/// <remarks>
/// Emits the same compact JSON form every other target does, so the shape is reviewed once and the runtime walkers
/// agree by construction. Only types reachable from a response are emitted — a spec's type graph is much larger
/// than its response graph — and cycles terminate through the table rather than through recursion.
/// </remarks>
internal sealed class Schemas
{
  private readonly TypeMapper _types;
  private readonly SortedDictionary<string, string> _table = new(StringComparer.Ordinal);
  private readonly HashSet<string> _started = new(StringComparer.Ordinal);

  public Schemas(TypeMapper types) => _types = types;

  /// <summary>Sorted, so output is byte-stable and a regeneration is not a spurious diff.</summary>
  public IReadOnlyDictionary<string, string> Table => _table;

  public string Describe(IDictionary<string, object?>? reference)
  {
    if (reference is null || reference.Count == 0)
    {
      return "{\"k\":\"any\"}";
    }

    var kind = Ir.Str(Ir.Get(reference, "kind"), "unknown");
    return kind switch
    {
      "primitive" => Primitive(reference),
      "array" => "{\"k\":\"arr\",\"i\":" + Describe(Ir.Obj(Ir.Get(reference, "items"))) + "}",
      "map" => "{\"k\":\"map\",\"v\":" + Describe(Ir.Obj(Ir.Get(reference, "values"))) + "}",
      "nullable" => "{\"k\":\"null\",\"i\":" + Describe(Ir.Obj(Ir.Get(reference, "inner"))) + "}",
      "named" => Named(reference),
      "union" => Union(reference),
      // Binary never reaches the JSON validator; a binary inside a JSON body is a base64 string.
      "binary" or "text" => "{\"k\":\"str\"}",
      "literal" => Literal(reference),
      _ => "{\"k\":\"any\"}",
    };
  }

  private static string Primitive(IDictionary<string, object?> reference) =>
      Ir.Str(Ir.Get(reference, "type")) switch
      {
        // Only `date-time` is a date; a `date` stays a string, matching how the model decodes it.
        "string" => Ir.Str(Ir.Get(reference, "format")) == "date-time" ? "{\"k\":\"date\"}" : "{\"k\":\"str\"}",
        "integer" => "{\"k\":\"int\"}",
        "number" => "{\"k\":\"num\"}",
        "boolean" => "{\"k\":\"bool\"}",
        _ => "{\"k\":\"any\"}",
      };

  private static string Literal(IDictionary<string, object?> reference) =>
      // Validated as its base type, for the same reason an enum is: a server widening it must not become a
      // decode failure.
      Ir.Get(reference, "value") switch
      {
        string => "{\"k\":\"str\"}",
        bool => "{\"k\":\"bool\"}",
        _ => "{\"k\":\"num\"}",
      };

  private string Union(IDictionary<string, object?> reference)
  {
    var branches = Ir.Objects(Ir.Get(reference, "variants")).Select(Describe);
    return "{\"k\":\"or\",\"o\":[" + string.Join(",", branches) + "]}";
  }

  private string Named(IDictionary<string, object?> reference)
  {
    var id = Ir.Str(Ir.Get(reference, "id"));
    if (!_types.Types.TryGetValue(id, out var type))
    {
      return "{\"k\":\"any\"}";
    }

    // An alias is inlined: it has no type of its own, so a `ref` would point at nothing.
    if (Ir.Str(Ir.Get(type, "kind")) == "alias")
    {
      return Describe(Ir.Obj(Ir.Get(type, "target")));
    }

    var name = _types.NameOf(id);
    if (_started.Add(id))
    {
      // Reserved before recursing, so a self-reference finds the key present and emits a `ref`.
      _table[name] = "{\"k\":\"any\"}";
      _table[name] = DescribeNamed(type);
    }

    return "{\"k\":\"ref\",\"n\":\"" + name + "\"}";
  }

  private string DescribeNamed(IDictionary<string, object?> type) => Ir.Str(Ir.Get(type, "kind")) switch
  {
    // Base type only, never membership. Servers add enum values without warning, and the open-enum rule
    // (§3.3.1) exists precisely so that does not break a client.
    "enum" => EnumBase(type),
    "object" => DescribeObject(type),
    _ => "{\"k\":\"any\"}",
  };

  private static string EnumBase(IDictionary<string, object?> type)
  {
    foreach (var member in Ir.Objects(Ir.Get(type, "members")))
    {
      if (Ir.Get(member, "wireValue") is long or double)
      {
        return "{\"k\":\"num\"}";
      }
    }

    return "{\"k\":\"str\"}";
  }

  private string DescribeObject(IDictionary<string, object?> type)
  {
    var fields = new List<string>();
    foreach (var field in Ir.Objects(Ir.Get(type, "fields")))
    {
      var wire = Ir.Str(Ir.Get(field, "wireName"));
      var descriptor = Describe(Ir.Obj(Ir.Get(field, "type")));
      fields.Add(Ir.Flag(Ir.Get(field, "required"))
          ? $"[\"{wire}\",{descriptor},1]"
          : $"[\"{wire}\",{descriptor}]");
    }

    var result = "{\"k\":\"obj\",\"f\":[" + string.Join(",", fields) + "]";
    var additional = Ir.Obj(Ir.Get(type, "additional"));
    if (additional.Count > 0)
    {
      result += ",\"a\":" + Describe(additional);
    }

    return result + "}";
  }
}
