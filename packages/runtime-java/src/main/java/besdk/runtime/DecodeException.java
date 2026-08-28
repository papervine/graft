package besdk.runtime;

/** The response arrived but was not the JSON it claimed to be. */
public final class DecodeException extends SdkException {

  private static final long serialVersionUID = 1L;

  public DecodeException(String message) {
    super(message);
  }

  public DecodeException(String message, Throwable cause) {
    super(message, cause);
  }
}
