package graft.runtime;

import java.util.Map;

/** See {@link ApiException}. */
public final class PermissionDeniedException extends ApiException {

  private static final long serialVersionUID = 1L;

  public PermissionDeniedException(
      int statusCode, String message, String requestId, Object body, Map<String, String> headers) {
    super(statusCode, message, requestId, body, headers);
  }
}
