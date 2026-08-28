package besdk.runtime;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** HTTP Bearer. */
public final class BearerAuth implements Auth {

  private final String token;

  public BearerAuth(String token) {
    this.token = token;
  }

  @Override
  public Applied apply(Map<String, String> headers, Map<String, List<String>> query) {
    Map<String, String> out = new LinkedHashMap<>(headers);
    out.put("Authorization", "Bearer " + token);
    return new Applied(out, query);
  }
}
