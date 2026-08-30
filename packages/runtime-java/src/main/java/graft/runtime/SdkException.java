package graft.runtime;

/**
 * The base of every error this runtime raises.
 *
 * <p>Named for its role, never for the generator. A generator-branded class would put this tool's
 * name in every consumer's catch block, making a rename here a breaking change for every SDK ever
 * produced (SPEC.md §1.2). Generated code aliases this to {@code <ClientName>Exception}, so the
 * name a user sees is their own.
 *
 * <p><b>Unchecked</b>, and that is the most consequential decision in this target (SPEC.md §3.3.9).
 * Checked exceptions would force every caller of every method to {@code try}/{@code catch} or
 * declare {@code throws}, which is how Java code acquires {@code catch (Exception e) {}}. Checked
 * exceptions model recoverable, local conditions; a 500 from someone else's server is neither.
 * Spring, the AWS SDK, Stripe, and the JDK's own {@code java.net.http} all agree.
 */
public abstract class SdkException extends RuntimeException {

  private static final long serialVersionUID = 1L;

  protected SdkException(String message) {
    super(message);
  }

  protected SdkException(String message, Throwable cause) {
    super(message, cause);
  }
}
