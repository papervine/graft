package besdk.runtime;

import java.util.Map;

/** A response, with header names lowercased on the way in. */
public record HttpResponseSpec(int statusCode, String body, Map<String, String> headers) {

  /** A header by name, case-insensitively. Null when absent. */
  public String header(String name) {
    return headers.get(name.toLowerCase(java.util.Locale.ROOT));
  }
}
