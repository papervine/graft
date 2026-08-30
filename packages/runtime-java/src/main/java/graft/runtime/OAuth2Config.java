package graft.runtime;

import java.util.List;

/**
 * Configuration for an OAuth2 token source (SPEC.md §3.1.6).
 *
 * <p>A record with nullable fields rather than a builder: it has five fields, all of which a caller
 * either knows or does not, and no combination is ambiguous.
 */
public record OAuth2Config(
    String tokenUrl,
    String clientId,
    String clientSecret,
    String refreshToken,
    List<String> scopes) {

  public OAuth2Config {
    scopes = scopes == null ? List.of() : List.copyOf(scopes);
  }
}
