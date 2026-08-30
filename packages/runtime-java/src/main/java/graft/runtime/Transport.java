package graft.runtime;

/**
 * How a request is actually sent.
 *
 * <p>An interface so a caller can inject their own — without it, testing code that uses a generated
 * SDK means making real network calls, which is not a nicety (SPEC.md §3.3.2).
 */
public interface Transport {
  HttpResponseSpec send(HttpRequestSpec request, java.time.Duration timeout);
}
