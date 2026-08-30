package graft.runtime;

/** The request never completed: DNS, TLS, connection reset. No status, because none arrived. */
public class ConnectionException extends SdkException {

  private static final long serialVersionUID = 1L;

  public ConnectionException(String message, Throwable cause) {
    super(message, cause);
  }

  public ConnectionException(String message) {
    super(message);
  }
}
