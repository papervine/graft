package graft.runtime;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/**
 * Encoding a request body as {@code multipart/form-data}.
 *
 * <p>Its own class because the framing is fiddly and unforgiving: a boundary that appears in the
 * content, a missing {@code filename=}, or a header set without the boundary all produce a request
 * the server cannot parse, and none of them is visible from the client side.
 *
 * <p>Builds bytes rather than a string, because a file's content is not text. Assembling multipart
 * as a {@code String} and letting the transport encode it would corrupt anything that is not valid
 * UTF-8 — which is most of what anyone uploads.
 */
public final class Multipart {

  private static final SecureRandom RANDOM = new SecureRandom();

  private Multipart() {}

  /** An encoded multipart body and the content type that describes it. */
  public record Encoded(byte[] body, String contentType) {}

  /**
   * Encode a JSON tree as multipart, treating the named fields as file content.
   *
   * <p>The tree rather than the model, so wire names and omit-when-null come from the same place
   * the JSON path gets them. The file field names come from the caller because Java's type for a
   * {@code format: binary} field is {@code String} — the same constraint PHP has, and the reason
   * "which field is a file" cannot be answered here.
   *
   * <p>Both halves are returned together: the content type carries the boundary, and a boundary
   * invented separately from the body it delimits is the one multipart mistake that cannot be
   * recovered from.
   */
  public static Encoded encode(Object tree, List<String> fileFields) {
    String boundary = "----formdata" + HexFormat.of().formatHex(randomBytes());
    ByteArrayOutputStream out = new ByteArrayOutputStream();

    if (tree instanceof Map<?, ?> fields) {
      for (Map.Entry<?, ?> entry : fields.entrySet()) {
        Object value = entry.getValue();
        // Null is omitted rather than sent as an empty part, which a server reads as a real value —
        // the
        // same rule Query and Form follow.
        if (value == null) {
          continue;
        }
        String name = String.valueOf(entry.getKey());
        if (fileFields.contains(name)) {
          // The filename is the field name, the best available guess: the spec carries none, and a
          // server matching on `filename=` sees nothing without one.
          write(out, "--" + boundary + "\r\n");
          write(
              out,
              "Content-Disposition: form-data; name=\""
                  + name
                  + "\"; filename=\""
                  + name
                  + "\"\r\n");
          write(out, "Content-Type: application/octet-stream\r\n\r\n");
          write(out, scalar(value));
          write(out, "\r\n");
          continue;
        }
        if (value instanceof List<?> items) {
          for (Object item : items) {
            if (item != null) {
              field(out, boundary, name, scalar(item));
            }
          }
          continue;
        }
        field(out, boundary, name, scalar(value));
      }
    }
    write(out, "--" + boundary + "--\r\n");
    return new Encoded(out.toByteArray(), "multipart/form-data; boundary=" + boundary);
  }

  private static void field(ByteArrayOutputStream out, String boundary, String name, String value) {
    write(out, "--" + boundary + "\r\n");
    write(out, "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n");
    write(out, value);
    write(out, "\r\n");
  }

  private static void write(ByteArrayOutputStream out, String text) {
    out.writeBytes(text.getBytes(StandardCharsets.UTF_8));
  }

  /**
   * One value as part content.
   *
   * <p>Shares the rules {@link Form} uses, so a boolean is {@code true} in both encodings and an
   * integral double is an integer in both. Two copies would disagree, and only against a strict
   * server.
   */
  private static String scalar(Object value) {
    return Form.scalarFor(value);
  }

  /**
   * Random boundary bytes.
   *
   * <p>Random rather than fixed: a fixed boundary appearing inside an uploaded file would truncate
   * the request there, and a file is exactly the content most likely to contain arbitrary bytes.
   */
  private static byte[] randomBytes() {
    byte[] bytes = new byte[16];
    RANDOM.nextBytes(bytes);
    return bytes;
  }
}
