package besdk.runtime;

import java.util.List;
import java.util.Map;

/** How a request proves who is making it. */
public interface Auth {

  /**
   * Apply credentials, returning what to send.
   *
   * <p>Both maps are returned rather than mutated, because an API key in the query string has to
   * modify the query and a bearer token has to modify the headers, and a single-return interface
   * would force one of them to be a special case.
   */
  Applied apply(Map<String, String> headers, Map<String, List<String>> query);

  /** The result of applying credentials. */
  record Applied(Map<String, String> headers, Map<String, List<String>> query) {}

  /**
   * No credentials at all — a public API, or one authenticated by something the SDK does not model.
   */
  Auth NONE = (headers, query) -> new Applied(headers, query);
}
