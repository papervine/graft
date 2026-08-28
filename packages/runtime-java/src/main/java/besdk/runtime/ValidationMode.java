package besdk.runtime;

/** How strictly a response is checked against the shape the spec declared (SPEC.md §3.4.1.1). */
public enum ValidationMode {
  /** Throw a {@link ResponseValidationException} naming the offending field. The default. */
  STRICT,
  /** Log and continue. */
  WARN,
  /** Skip the check. */
  OFF
}
