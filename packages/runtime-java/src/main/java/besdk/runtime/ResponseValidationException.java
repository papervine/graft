package besdk.runtime;

import java.util.List;

/**
 * A response did not match the shape the spec declared.
 *
 * <p>Deliberately <b>not</b> an {@link ApiException}. The server answered successfully; what failed
 * is the contract between the spec and the implementation, and a caller catching {@code
 * ApiException} to handle <em>the API saying no</em> should not accidentally swallow this (SPEC.md
 * §3.4.1.1).
 *
 * <p>{@code @SuppressWarnings("serial")} for the reason given on {@link ApiException}.
 */
@SuppressWarnings("serial")
public final class ResponseValidationException extends SdkException {

  private static final long serialVersionUID = 1L;

  private final String operation;
  private final List<String> problems;

  public ResponseValidationException(String operation, List<String> problems) {
    super(buildMessage(operation, problems));
    this.operation = operation;
    this.problems = List.copyOf(problems);
  }

  private static String buildMessage(String operation, List<String> problems) {
    String first =
        problems.isEmpty() ? "the response did not match the declared shape" : problems.get(0);
    String extra = problems.size() > 1 ? " (and " + (problems.size() - 1) + " more)" : "";
    return operation + ": the response did not match the API's declared shape — " + first + extra;
  }

  public String operation() {
    return operation;
  }

  public List<String> problems() {
    return problems;
  }
}
