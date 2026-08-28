using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Besdk.Runtime;

/// <summary>
/// Encoding a request body as <c>multipart/form-data</c>.
/// </summary>
/// <remarks>
/// <para>
/// Its own type because the framing is fiddly and unforgiving: a boundary that appears in the content, a
/// missing <c>filename=</c>, or a header set without the boundary all produce a request the server cannot
/// parse, and none of them is visible from the client side.
/// </para>
/// <para>
/// Builds bytes rather than a string, because a file's content is not text. Assembling multipart as a
/// string and letting the transport encode it corrupts anything that is not valid UTF-8.
/// </para>
/// <para>
/// Hand-rolled rather than using <c>MultipartFormDataContent</c>, for one reason: the encoded bytes and the
/// boundary have to be returned *together*, and .NET's type owns its boundary internally and only reveals
/// it once attached to a request. Splitting them is the one multipart mistake that cannot be recovered
/// from, so the encoder keeps them in one value.
/// </para>
/// </remarks>
public static class Multipart
{
  /// <summary>An encoded multipart body and the content type that describes it.</summary>
  public sealed record Encoded(byte[] Body, string ContentType);

  /// <summary>
  /// Encode a JSON tree as multipart, treating the named fields as file content.
  /// </summary>
  /// <remarks>
  /// The tree rather than the record, so wire names and omit-when-null come from the same place the JSON
  /// path gets them. The file field names come from the caller because C#'s type for a
  /// <c>format: binary</c> field is <c>string</c> — the same constraint PHP and Java have, and the reason
  /// "which field is a file" cannot be answered here.
  /// </remarks>
  public static Encoded Encode(object? tree, IReadOnlyList<string> fileFields)
  {
    var boundary = "----formdata" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
    using var buffer = new MemoryStream();

    if (tree is IReadOnlyDictionary<string, object?> fields)
    {
      foreach (var (key, value) in fields)
      {
        // Null is omitted rather than sent as an empty part, which a server reads as a real value — the
        // same rule Query and Form follow.
        if (value is null)
        {
          continue;
        }

        if (fileFields.Contains(key))
        {
          // The filename is the field name, the best available guess: the spec carries none, and a server
          // matching on `filename=` sees nothing without one.
          Write(buffer, $"--{boundary}\r\n");
          Write(buffer, $"Content-Disposition: form-data; name=\"{key}\"; filename=\"{key}\"\r\n");
          Write(buffer, "Content-Type: application/octet-stream\r\n\r\n");
          Write(buffer, Form.ScalarFor(value));
          Write(buffer, "\r\n");
          continue;
        }

        if (value is IReadOnlyList<object?> items)
        {
          foreach (var item in items)
          {
            if (item is not null)
            {
              Field(buffer, boundary, key, Form.ScalarFor(item));
            }
          }
          continue;
        }

        Field(buffer, boundary, key, Form.ScalarFor(value));
      }
    }

    Write(buffer, $"--{boundary}--\r\n");
    return new Encoded(buffer.ToArray(), "multipart/form-data; boundary=" + boundary);
  }

  private static void Field(Stream buffer, string boundary, string name, string value)
  {
    Write(buffer, $"--{boundary}\r\n");
    Write(buffer, $"Content-Disposition: form-data; name=\"{name}\"\r\n\r\n");
    Write(buffer, value);
    Write(buffer, "\r\n");
  }

  private static void Write(Stream buffer, string text)
  {
    var bytes = Encoding.UTF8.GetBytes(text);
    buffer.Write(bytes, 0, bytes.Length);
  }
}
