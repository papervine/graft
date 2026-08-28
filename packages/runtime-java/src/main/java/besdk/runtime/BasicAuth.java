package besdk.runtime;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** HTTP Basic. */
public final class BasicAuth implements Auth {

  private final String username;
  private final String password;

  public BasicAuth(String username, String password) {
    this.username = username;
    this.password = password;
  }

  @Override
  public Applied apply(Map<String, String> headers, Map<String, List<String>> query) {
    Map<String, String> out = new LinkedHashMap<>(headers);
    String credentials = username + ":" + password;
    out.put(
        "Authorization",
        "Basic "
            + Base64.getEncoder().encodeToString(credentials.getBytes(StandardCharsets.UTF_8)));
    return new Applied(out, query);
  }
}
