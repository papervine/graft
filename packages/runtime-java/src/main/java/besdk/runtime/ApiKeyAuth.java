package besdk.runtime;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * An API key, in a header or the query string.
 *
 * <p>The query variant exists because specs declare it, not because it is a good idea — a key in a
 * URL lands in access logs and browser history. besdk honours what the spec says and does not
 * editorialise.
 */
public final class ApiKeyAuth implements Auth {

  private final String key;
  private final String name;
  private final boolean inQuery;

  public ApiKeyAuth(String key, String name, boolean inQuery) {
    this.key = key;
    this.name = name;
    this.inQuery = inQuery;
  }

  @Override
  public Applied apply(Map<String, String> headers, Map<String, List<String>> query) {
    if (inQuery) {
      Map<String, List<String>> out = new LinkedHashMap<>(query);
      out.put(name, List.of(key));
      return new Applied(headers, out);
    }
    Map<String, String> out = new LinkedHashMap<>(headers);
    out.put(name, key);
    return new Applied(out, query);
  }
}
