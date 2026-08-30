package graft.runtime;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.StringJoiner;

/**
 * Encoding a request body as {@code application/x-www-form-urlencoded}.
 *
 * <p>Its own class because the rules are shared with nothing else and getting them wrong is
 * invisible: a server receiving JSON where it expected a form rejects the request, and nothing on
 * the client side can tell. Every write operation of every form-based API was sent as JSON before
 * this existed.
 *
 * <p>Takes the body's *JSON tree* rather than the model, so the wire names and the omit-when-null
 * rules are exactly the ones the JSON path already gets right. Reflecting over the record
 * separately would be a second implementation of field naming, and the two would disagree the first
 * time a model changed.
 */
public final class Form {

  private Form() {}

  /**
   * Encode a JSON tree as a form-encoded string.
   *
   * <p>A list becomes a repeated key, which is what every form-encoded API this project has seen
   * expects; {@code key[]=} is a PHP convention and {@code key=a,b} is a third. A nested object is
   * JSON-encoded, matching the multipart path — form encoding has no canonical nesting, so
   * inventing one would send something no server asked for.
   */
  public static String encode(Object tree) {
    StringJoiner joined = new StringJoiner("&");
    if (!(tree instanceof Map<?, ?> fields)) {
      return "";
    }
    for (Map.Entry<?, ?> entry : fields.entrySet()) {
      Object value = entry.getValue();
      // Null is omitted rather than sent as an empty value, which a server reads as a real one —
      // the
      // same rule Query follows.
      if (value == null) {
        continue;
      }
      String name = escape(String.valueOf(entry.getKey()));
      if (value instanceof List<?> items) {
        for (Object item : items) {
          if (item == null) {
            continue;
          }
          joined.add(name + "=" + escape(scalar(item)));
        }
        continue;
      }
      joined.add(name + "=" + escape(scalar(value)));
    }
    return joined.toString();
  }

  /**
   * One value as a form field.
   *
   * <p>Shared with {@link Multipart} so a boolean is {@code true} in both encodings and an integral
   * double is an integer in both. Two copies of this would disagree, and the disagreement would
   * only show up against a server strict about one of them.
   */
  public static String scalarFor(Object value) {
    return scalar(value);
  }

  /** One value as a form field. */
  private static String scalar(Object value) {
    if (value instanceof String text) {
      return text;
    }
    if (value instanceof Boolean flag) {
      return flag ? "true" : "false";
    }
    if (value instanceof Double number && number == Math.floor(number) && Math.abs(number) < 1e15) {
      // A JSON number parses as a Double, so an id would otherwise be sent as `1.0` — a rejected
      // request where an integer was expected.
      return String.valueOf(number.longValue());
    }
    if (value instanceof Map<?, ?> || value instanceof List<?>) {
      return Json.write(value);
    }
    return String.valueOf(value);
  }

  /**
   * Percent-encode a component.
   *
   * <p>{@code URLEncoder} is the form encoder specifically — a space becomes {@code +}, which is
   * correct here and wrong in a path. That difference is why {@code Query} does not share this
   * method.
   */
  private static String escape(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8);
  }
}
