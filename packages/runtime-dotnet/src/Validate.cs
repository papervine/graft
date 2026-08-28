namespace Besdk.Runtime;

/// <summary>
/// Walks a response against its declared shape (SPEC.md §3.4.1.1).
/// </summary>
/// <remarks>
/// Two things this deliberately never checks:
/// <list type="bullet">
/// <item><description>
/// <b>Unknown fields.</b> A server adding a field must not break a client. That is the whole point of an
/// evolving API.
/// </description></item>
/// <item><description>
/// <b>Enum membership.</b> Servers add enum values without warning, and the open-enum rule (§3.3.1) exists
/// precisely so that does not break a client — checking membership here would reintroduce it.
/// </description></item>
/// </list>
/// </remarks>
public static class Validate
{
  /// <summary>Collect the ways a value fails to match a schema.</summary>
  public static IReadOnlyList<string> Check(
      object? value,
      Schema schema,
      IReadOnlyDictionary<string, Schema> table)
  {
    var problems = new List<string>();
    Walk(value, schema, table, string.Empty, problems);
    return problems;
  }

  /// <summary>Throw when validation fails, honouring the mode.</summary>
  public static void Enforce(
      object? value,
      Schema schema,
      IReadOnlyDictionary<string, Schema> table,
      string operation,
      ValidationMode mode)
  {
    if (mode == ValidationMode.Off)
    {
      return;
    }

    var problems = Check(value, schema, table);
    if (problems.Count == 0)
    {
      return;
    }

    if (mode == ValidationMode.Warn)
    {
      // `Trace` rather than `Console`: a library writing to stdout corrupts anything parsing a host's
      // output, and .NET's diagnostic plumbing is what a host is already listening to.
      System.Diagnostics.Trace.TraceWarning(
          "{0}: response did not match the declared shape — {1}", operation, problems[0]);
      return;
    }

    throw new ResponseValidationException(operation, problems);
  }

  private static void Walk(
      object? value,
      Schema schema,
      IReadOnlyDictionary<string, Schema> table,
      string path,
      List<string> problems)
  {
    var where = path.Length == 0 ? "the response" : path;
    switch (schema)
    {
      case Schema.Any:
        break;
      case Schema.Str:
      case Schema.Date:
        Expect(value is string, where, "a string", value, problems);
        break;
      case Schema.Num:
        Expect(value is long or double or int or decimal, where, "a number", value, problems);
        break;
      case Schema.Int:
        // A JSON integer may arrive as a whole double from a serialiser with no integer type; rejecting
        // that would fail on data that is correct.
        Expect(IsInteger(value), where, "an integer", value, problems);
        break;
      case Schema.Bool:
        Expect(value is bool, where, "a boolean", value, problems);
        break;
      case Schema.Nullable nullable:
        if (value is not null)
        {
          Walk(value, nullable.Inner, table, path, problems);
        }

        break;
      case Schema.Arr array:
        WalkArray(value, array, table, path, where, problems);
        break;
      case Schema.MapOf mapOf:
        WalkMap(value, mapOf, table, path, where, problems);
        break;
      case Schema.Obj obj:
        WalkObject(value, obj, table, path, where, problems);
        break;
      case Schema.Or union:
        foreach (var branch in union.Branches)
        {
          if (Check(value, branch, table).Count == 0)
          {
            return;
          }
        }

        // One message rather than every branch's failure: a union of five reporting five problems buries
        // the actual one.
        Expect(false, where, "one of the declared shapes", value, problems);
        break;
      case Schema.Ref reference:
        // A missing entry is treated as `any`: an incomplete table must not reject correct data. A cycle
        // terminates here, through the table, rather than through recursion.
        if (table.TryGetValue(reference.Name, out var target))
        {
          Walk(value, target, table, path, problems);
        }

        break;
      default:
        break;
    }
  }

  private static void WalkArray(
      object? value,
      Schema.Arr array,
      IReadOnlyDictionary<string, Schema> table,
      string path,
      string where,
      List<string> problems)
  {
    if (value is not IList<object?> items)
    {
      Expect(false, where, "an array", value, problems);
      return;
    }

    for (var index = 0; index < items.Count; index++)
    {
      Walk(items[index], array.Items, table, $"{path}[{index}]", problems);
    }
  }

  private static void WalkMap(
      object? value,
      Schema.MapOf mapOf,
      IReadOnlyDictionary<string, Schema> table,
      string path,
      string where,
      List<string> problems)
  {
    // An empty map arrives as `[]` from a PHP backend, which is the artifact §3.1.2 names. A valid empty
    // map, not a wrong type.
    if (value is IList<object?> { Count: 0 })
    {
      return;
    }

    if (value is not IDictionary<string, object?> map)
    {
      Expect(false, where, "an object", value, problems);
      return;
    }

    foreach (var (key, item) in map)
    {
      Walk(item, mapOf.Values, table, Join(path, key), problems);
    }
  }

  private static void WalkObject(
      object? value,
      Schema.Obj obj,
      IReadOnlyDictionary<string, Schema> table,
      string path,
      string where,
      List<string> problems)
  {
    if (value is IList<object?> { Count: 0 })
    {
      return;
    }

    if (value is not IDictionary<string, object?> map)
    {
      Expect(false, where, "an object", value, problems);
      return;
    }

    foreach (var field in obj.Fields)
    {
      if (!map.TryGetValue(field.WireName, out var item))
      {
        if (field.Required)
        {
          problems.Add(Join(path, field.WireName) + " is missing");
        }

        continue;
      }

      Walk(item, field.Schema, table, Join(path, field.WireName), problems);
    }

    if (obj.Additional is not null)
    {
      var known = obj.Fields.Select(field => field.WireName).ToHashSet(StringComparer.Ordinal);
      foreach (var (key, item) in map)
      {
        if (!known.Contains(key))
        {
          Walk(item, obj.Additional, table, Join(path, key), problems);
        }
      }
    }
  }

  private static bool IsInteger(object? value) => value switch
  {
    long or int or short => true,
    double number => Math.Abs(number % 1) < double.Epsilon && !double.IsInfinity(number),
    _ => false,
  };

  private static void Expect(
      bool ok,
      string where,
      string expected,
      object? actual,
      List<string> problems)
  {
    if (!ok)
    {
      problems.Add($"{where} should be {expected} but was {Describe(actual)}");
    }
  }

  /// <summary>What arrived, named the way JSON names it rather than the way .NET does.</summary>
  private static string Describe(object? value) => value switch
  {
    null => "null",
    bool => "a boolean",
    long or int or short => "an integer",
    double or float or decimal => "a number",
    string => "a string",
    IList<object?> => "an array",
    IDictionary<string, object?> => "an object",
    _ => "something else",
  };

  private static string Join(string path, string segment) =>
      path.Length == 0 ? segment : path + "." + segment;
}
