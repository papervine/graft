using System.Text;

namespace Graft.Target.Dotnet;

/// <summary>
/// Generating the expressions that turn a decoded JSON value into a typed property.
/// </summary>
/// <remarks>
/// Its own class because the rules are per-type and there are enough of them that inlining would bury the emitter.
/// Each returns one expression, suitable for an object initialiser.
/// </remarks>
internal static class Decoding
{
  /// <summary>
  /// Read one property from the decoded tree.
  /// </summary>
  /// <remarks>
  /// A <b>required</b> property of the wrong type fails with a message naming the field and what was expected —
  /// the backstop for when validation is off, and far better than a cast exception with no context. An
  /// <b>optional</b> property of the wrong type becomes null: it was already allowed to be absent, and the
  /// validator reports the mismatch with the field name in strict mode.
  /// </remarks>
  public static string Read(Emitter.Property property, string owner, TypeMapper types)
  {
    var raw = $"Support.Get(data, {Source.Quote(property.WireName)})";
    var bare = property.Type.TrimEnd('?');
    var fail = $"Support.Fail<{property.Type}>({Source.Quote(owner)}, {Source.Quote(property.WireName)}, ";

    if (bare.StartsWith("IReadOnlyList<", StringComparison.Ordinal))
    {
      var element = bare["IReadOnlyList<".Length..^1];
      return $"Support.List({raw}, {ElementDecoder(element, types)})";
    }

    if (bare.StartsWith("IReadOnlyDictionary<string, ", StringComparison.Ordinal))
    {
      var element = bare["IReadOnlyDictionary<string, ".Length..^1];
      return $"Support.Map({raw}, {ElementDecoder(element, types)})";
    }

    return bare switch
    {
      // A *required* `unknown` field still has to satisfy a non-nullable `object`, and `Support.Get`
      // returns `object?` — so returning `raw` unchanged produced CS8601 and an SDK that does not build.
      // Every other required type here already fails loudly on absence; this one silently did not, and
      // the gap only appeared on a spec declaring a required free-form field (Twilio's `request`).
      "object" => property.Required
          ? $"{raw} ?? {fail}{Source.Quote("a value")})"
          : raw,
      "string" => property.Required
          ? $"{raw} is string value{property.Name} ? value{property.Name} : {fail}{Source.Quote("a string")})"
          : $"{raw} as string",
      "long" => Numeric(raw, property, fail, "long", "an integer", "(long)"),
      "int" => Numeric(raw, property, fail, "int", "an integer", "(int)"),
      "double" => Numeric(raw, property, fail, "double", "a number", "(double)"),
      "bool" => property.Required
          ? $"{raw} is bool flag{property.Name} ? flag{property.Name} : {fail}{Source.Quote("a boolean")})"
          : $"{raw} as bool?",
      "DateTimeOffset" => property.Required
          ? $"Support.Instant({raw}) ?? {fail}{Source.Quote("a timestamp")})"
          : $"Support.Instant({raw})",
      _ => Named(bare, raw, property, types, fail),
    };
  }

  /// <summary>
  /// A numeric read.
  /// </summary>
  /// <remarks>
  /// JSON gives <c>long</c> or <c>double</c>, and a spec may declare either — so the pattern matches
  /// <c>IConvertible</c>-ish shapes rather than one exact type, and converts. Matching only <c>long</c> would
  /// reject <c>1.0</c> for an integer field, which is data a serialiser with no integer type produces.
  /// </remarks>
  private static string Numeric(
      string raw,
      Emitter.Property property,
      string fail,
      string csharpType,
      string expected,
      string cast)
  {
    var local = "number" + property.Name;
    var read = $"{raw} is long or double or int ? {cast}Convert.ToDouble({raw}, System.Globalization.CultureInfo.InvariantCulture)";
    return property.Required
        ? $"{read} : {fail}{Source.Quote(expected)})"
        : $"{read} : ({csharpType}?)null";
  }

  private static string Named(
      string bare,
      string raw,
      Emitter.Property property,
      TypeMapper types,
      string fail)
  {
    if (types.Types.Any(entry => types.NameOf(entry.Key) == bare && types.IsEnum(entry.Key)))
    {
      // `FromWire` rather than `Enum.Parse`: a member the server added after generation must not crash the
      // client.
      var read = $"{bare}Extensions.FromWire({raw} as string)";
      return property.Required ? $"{read} ?? {fail}{Source.Quote("a known " + bare + " value")})" : read;
    }

    return property.Required
        ? $"{bare}.FromJson({raw})"
        : $"{raw} is null ? null : {bare}.FromJson({raw})";
  }

  /// <summary>A lambda that decodes one element of a collection.</summary>
  private static string ElementDecoder(string element, TypeMapper types)
  {
    var bare = element.TrimEnd('?');
    if (bare is "string")
    {
      return "item => item as string";
    }

    if (bare is "long" or "int" or "double")
    {
      return $"item => item is long or double or int ? ({bare}?)Convert.ToDouble(item, System.Globalization.CultureInfo.InvariantCulture) : null";
    }

    if (bare is "bool")
    {
      return "item => item as bool?";
    }

    if (bare is "object")
    {
      return "item => item";
    }

    if (bare is "DateTimeOffset")
    {
      return "Support.Instant";
    }

    if (bare.StartsWith("IReadOnlyList<", StringComparison.Ordinal)
        || bare.StartsWith("IReadOnlyDictionary<", StringComparison.Ordinal))
    {
      // A nested collection is handed through: the validator has checked its shape, and decoding one more
      // level would need a recursive lambda for no gain in a generated SDK.
      return "item => item";
    }

    if (types.Types.Any(entry => types.NameOf(entry.Key) == bare && types.IsEnum(entry.Key)))
    {
      return $"item => {bare}Extensions.FromWire(item as string)";
    }

    return $"{bare}.FromJson";
  }

  /// <summary>Add one property to a request body's JSON tree, omitting nulls.</summary>
  public static string Write(Emitter.Property property)
  {
    var name = property.Name;
    var key = Source.Quote(property.WireName);
    var value = WriteValue(property.Type, name);

    // A non-nullable value type is never null, so there is nothing to check — and `is not null` on one is a
    // compile error rather than a redundant check. Decided by the emitter, which knows whether the type is an
    // enum; a hardcoded list of primitives missed exactly that case.
    if (property.IsValueType)
    {
      return $"        result[{key}] = {value};\n";
    }

    return new StringBuilder()
        .Append("        if (").Append(name).Append(" is not null)\n        {\n")
        .Append("            result[").Append(key).Append("] = ").Append(value).Append(";\n        }\n")
        .ToString();
  }

  private static string WriteValue(string type, string name)
  {
    var bare = type.TrimEnd('?');
    if (bare == "DateTimeOffset")
    {
      // A nullable DateTimeOffset needs `.Value` inside the null check; a required one does not.
      return type.EndsWith('?') ? name + ".Value" : name;
    }

    if (bare.StartsWith("IReadOnlyList<", StringComparison.Ordinal)
        || bare.StartsWith("IReadOnlyDictionary<", StringComparison.Ordinal))
    {
      // The runtime's JSON writer normalises enums, timestamps, and nested models on the way out, so a
      // collection is handed over whole.
      return name;
    }

    return bare switch
    {
      "string" or "long" or "int" or "double" or "bool" or "object" => name,
      // A model or enum: the writer normalises it.
      _ => name,
    };
  }
}
