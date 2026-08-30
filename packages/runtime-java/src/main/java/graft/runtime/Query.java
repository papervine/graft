package graft.runtime;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Building query strings and URLs.
 *
 * <p>Its own class because the rules are shared and fiddly: every generated method funnels through
 * them, and getting {@code null} versus {@code false} versus an empty list wrong is the kind of bug
 * that only shows up against a real server.
 */
public final class Query {

  private Query() {}

  /**
   * Flatten user-supplied query parameters into repeated string values.
   *
   * <p>Three rules, each of which cost a real bug in another target:
   *
   * <ul>
   *   <li><b>{@code null} is omitted, {@code false} is not.</b> {@code ?active=false} is a
   *       meaningful filter, and omitting the parameter is a different request.
   *   <li><b>A collection repeats the key.</b> {@code ?tag=a&tag=b}, which is what servers expect.
   *   <li><b>An empty collection sends nothing</b>, rather than an empty key.
   * </ul>
   */
  public static Map<String, List<String>> flatten(Map<String, ?> params) {
    Map<String, List<String>> out = new LinkedHashMap<>();
    for (Map.Entry<String, ?> entry : params.entrySet()) {
      Object value = entry.getValue();
      if (value == null) {
        continue;
      }
      List<String> rendered = new ArrayList<>();
      if (value instanceof Iterable<?> items) {
        for (Object item : items) {
          if (item != null) {
            rendered.add(scalar(item));
          }
        }
      } else {
        rendered.add(scalar(value));
      }
      if (!rendered.isEmpty()) {
        out.put(entry.getKey(), List.copyOf(rendered));
      }
    }
    return out;
  }

  /**
   * One query value as a string.
   *
   * <p>An enum sends its wire value, not {@code name()}. That distinction cost a cross-language
   * conformance failure in PHP, where an enum fell through to a JSON encoder and arrived quoted —
   * so it is handled explicitly and first here.
   */
  private static String scalar(Object value) {
    if (value instanceof Boolean b) {
      // The words, not 1/0: a server reading a boolean query parameter expects `true`.
      return b ? "true" : "false";
    }
    if (value instanceof WireValued enumeration) {
      return enumeration.wireValue();
    }
    if (value instanceof Instant instant) {
      return DateTimeFormatter.ISO_INSTANT.format(instant);
    }
    if (value instanceof java.time.OffsetDateTime moment) {
      return DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(moment);
    }
    return String.valueOf(value);
  }

  /** Join a base URL, a path, and query parameters. */
  public static String url(String baseUrl, String path, Map<String, List<String>> query) {
    StringBuilder url = new StringBuilder();
    url.append(baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl);
    url.append(path.startsWith("/") ? path : "/" + path);
    if (query.isEmpty()) {
      return url.toString();
    }
    url.append(url.indexOf("?") >= 0 ? '&' : '?');
    boolean first = true;
    for (Map.Entry<String, List<String>> entry : query.entrySet()) {
      for (String value : entry.getValue()) {
        if (!first) {
          url.append('&');
        }
        first = false;
        url.append(encode(entry.getKey())).append('=').append(encode(value));
      }
    }
    return url.toString();
  }

  /**
   * Substitute {@code {name}} path parameters.
   *
   * <p>Each value is percent-encoded, so an id containing a slash cannot escape its segment and
   * reach a different endpoint.
   */
  public static String path(String template, Map<String, ?> params) {
    String result = template;
    for (Map.Entry<String, ?> entry : params.entrySet()) {
      result =
          result.replace("{" + entry.getKey() + "}", pathSegment(String.valueOf(entry.getValue())));
    }
    return result;
  }

  /**
   * Percent-encode one path segment.
   *
   * <p>{@code URLEncoder} is form encoding, not URL encoding: it renders a space as {@code +},
   * which is correct in a query string and wrong in a path. So the {@code +} is corrected back, and
   * the characters that are legal unencoded in a path are restored.
   */
  private static String pathSegment(String value) {
    return encode(value).replace("+", "%20");
  }

  private static String encode(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8);
  }

  /**
   * Something with a wire representation distinct from its Java name. Generated enums implement
   * this.
   */
  public interface WireValued {
    String wireValue();
  }
}
