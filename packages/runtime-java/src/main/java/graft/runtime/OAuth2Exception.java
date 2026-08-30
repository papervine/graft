package graft.runtime;

/** Obtaining or refreshing an OAuth2 token failed. */
public final class OAuth2Exception extends SdkException {

  private static final long serialVersionUID = 1L;

  public OAuth2Exception(String message) {
    super(message);
  }
}
