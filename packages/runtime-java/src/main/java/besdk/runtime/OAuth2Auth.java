package besdk.runtime;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** OAuth2, holding a token source that refreshes itself. */
public final class OAuth2Auth implements Auth {

  private final TokenSource source;

  public OAuth2Auth(TokenSource source) {
    this.source = source;
  }

  @Override
  public Applied apply(Map<String, String> headers, Map<String, List<String>> query) {
    Map<String, String> out = new LinkedHashMap<>(headers);
    out.put("Authorization", "Bearer " + source.token());
    return new Applied(out, query);
  }

  /** Drop the cached token. The 401-retry path calls this before its one retry. */
  public void invalidate() {
    source.invalidate();
  }
}
