package graft.runtime;

/**
 * The request exceeded its timeout.
 *
 * <p>Distinguished from {@link ConnectionException} because a timeout is retryable in a way a TLS
 * failure is not.
 */
public final class TimeoutException extends ConnectionException {

  private static final long serialVersionUID = 1L;

  public TimeoutException(String message, Throwable cause) {
    super(message, cause);
  }
}
