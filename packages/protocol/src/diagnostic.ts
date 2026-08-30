/**
 * Diagnostics — the shared vocabulary for everything graft has to *tell* the user.
 *
 * This type is in `protocol/` rather than `core/` because targets emit diagnostics too, and
 * they travel back across the subprocess boundary in the manifest (SPEC.md §3.5).
 *
 * Design note: `fix` is not optional decoration. On an under-specified spec the tool's job
 * includes saying what the spec fails to say (SPEC.md "Enrichment, not just translation"),
 * and a diagnostic the user cannot act on has not done that job. Prefer a copy-pasteable
 * `graft.yaml` fragment over prose.
 */

import { z } from 'zod';

export const SeveritySchema = z.enum(['error', 'warn', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * Stable diagnostic codes.
 *
 * These are part of the user-visible contract — people suppress them in config and grep for
 * them in CI logs — so treat renames as breaking. Grouped by prefix:
 * `M` model, `E` errors, `P` pagination, `H` headers, `T` type, `S` spec, `X` protocol.
 */
export const DIAGNOSTIC_CODES = {
  /** One schema used in both request and response position. SPEC.md §3.1.1. */
  READ_WRITE_CONFLATION: 'M001',
  /** An object type with no `required` fields; every field becomes optional downstream. */
  ALL_FIELDS_OPTIONAL: 'M002',
  /** Structurally identical inline schemas collapsed into one named type. */
  STRUCTURAL_DEDUPE: 'M003',
  /** A name was synthesized for an anonymous inline schema. */
  NAME_SYNTHESIZED: 'M004',

  /** Error responses that declare no schema, so the error type is unknowable. */
  ERROR_SCHEMA_MISSING: 'E001',

  /** Pagination inferred from parameter names and prose rather than declared structure. */
  PAGINATION_INFERRED: 'P001',
  /** Looks pageable but no scheme could be inferred. */
  PAGINATION_UNRESOLVED: 'P002',

  /** A constant header parameter hoisted into runtime defaults. */
  CONST_HEADER_HOISTED: 'H001',

  /** `oneOf` collapsed to a map because one branch was an empty-array artifact. */
  PHP_EMPTY_MAP_COLLAPSED: 'T001',
  /** `oneOf` of differing scalars, treated as loose encoding rather than a domain union. */
  SCALAR_UNION: 'T002',
  /** `schema: {}` or equivalent; became `unknown`. */
  EMPTY_SCHEMA: 'T003',
  /** A reference cycle was found and flagged rather than inlined. */
  REFERENCE_CYCLE: 'T004',

  /** The spec violates OpenAPI but was absorbed. Tolerating garbage is a feature. */
  SPEC_VIOLATION_TOLERATED: 'S001',
  /** A vendor extension was read as overlay input, e.g. `x-fern-sdk-group-name`. */
  VENDOR_EXTENSION_USED: 'S002',

  /**
   * An OAuth2 scheme declares no flow the SDK can perform, so the client accepts a token directly.
   *
   * Includes `openIdConnect`, whose discovery document would have to be fetched at generate time —
   * making generation depend on the network, which it must not.
   */
  OAUTH2_NO_USABLE_FLOW: 'A001',
  /**
   * The authorization-code redirect stays the application's job (SPEC.md §3.1.6). Informational, not a
   * warning: the generated client is correct, it just cannot open a browser.
   */
  OAUTH2_AUTHORIZATION_CODE: 'A002',
  /** Only the implicit or password flow, both deprecated by OAuth 2.1, so neither is implemented. */
  OAUTH2_DEPRECATED_FLOW: 'A003',

  /**
   * A schema is mapped to more than one discriminator value, which is contradictory, so its
   * discriminator field cannot be narrowed (SPEC.md §3.1.7).
   */
  DISCRIMINATOR_CONFLICT: 'T005',
  /**
   * A `oneOf` whose branches cannot be told apart — no discriminator and structurally overlapping.
   * It will decode ambiguously in every language.
   */
  AMBIGUOUS_ONE_OF: 'T006',

  /** Target handshake or manifest problem. */
  /**
   * A server URL references a variable it does not declare, so no default exists to substitute.
   *
   * A warning rather than an error because the rest of the SDK is fine — but the base URL will contain
   * a literal `{placeholder}`, and a host with braces in it does not resolve. Worth a line, because the
   * symptom otherwise appears at the first request as a DNS failure.
   */
  SERVER_VARIABLE_UNDECLARED: 'S003',

  /**
   * The spec declares webhooks but no signature scheme is configured, so no verifier is emitted.
   *
   * A warning rather than an error, because typed events are useful on their own and the spec is not at
   * fault: OpenAPI has no field describing a signature scheme, so graft cannot infer one. But it must be
   * *said*, because the failure mode of not knowing is accepting forged requests — and unlike most gaps in
   * this list, nothing downstream will ever surface it.
   */
  WEBHOOK_NO_SIGNATURE_SCHEME: 'W001',

  TARGET_PROTOCOL: 'X001',
} as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

export const DiagnosticSchema = z.object({
  severity: SeveritySchema,
  /** One of {@link DIAGNOSTIC_CODES}. Free-form so third-party targets can add their own. */
  code: z.string().min(1),
  /** One line. What is wrong, stated as a fact about the spec. */
  message: z.string().min(1),
  /** Supporting lines — the specific schemas, operations, or counts involved. */
  detail: z.array(z.string()).optional(),
  /** A copy-pasteable `graft.yaml` fragment that resolves this. */
  fix: z.string().optional(),
  /** JSON pointer into the source spec, when a single site is responsible. */
  sourcePointer: z.string().optional(),
  /** How many sites this diagnostic aggregates, when it was rolled up. */
  count: z.number().int().positive().optional(),
  /**
   * Dotted `graft.yaml` paths that answer this diagnostic, e.g. `models.Widget.split`.
   *
   * Machine-readable alongside the human `fix`, so `check` can stop reporting something the user has
   * already resolved. Without it `check` had no idea: `graft init` wrote the split, the required
   * fields, and the pagination scheme into `graft.yaml`, and `check` reported all three anyway — which
   * meant `--strict` could never pass and the documented CI gate was unusable.
   *
   * Declared *by the diagnostic that raises it*, deliberately. A separate table mapping codes to
   * config keys is a second list of the same knowledge, and those drift.
   *
   * **Every** listed path must be present. A diagnostic aggregating five conflated schemas lists five
   * paths, because configuring one of them leaves the warning true of the other four.
   */
  resolvedBy: z.array(z.string().min(1)).optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export function diagnostic(d: Diagnostic): Diagnostic {
  return DiagnosticSchema.parse(d);
}

/**
 * Drop diagnostics the config already answers.
 *
 * Generic over the paths a diagnostic declares in `resolvedBy`, so adding a diagnostic needs no change
 * here — the alternative was a table of codes to config keys, which is the same knowledge written twice.
 */
export function withoutResolved(
  diagnostics: readonly Diagnostic[],
  config: unknown,
): Diagnostic[] {
  return diagnostics.filter((d) => {
    const paths = d.resolvedBy ?? [];
    // An empty list means the diagnostic declared nothing, so it is never suppressed. Only a
    // diagnostic that says what would answer it can be answered.
    return paths.length === 0 || !paths.every((path) => configHasPath(config, path));
  });
}

/**
 * Is a dotted path present, and set to something meaningful?
 *
 * An empty array or object does not count: `models.Widget.required: []` says nothing was promoted, so
 * the diagnostic that asked for it still applies.
 */
export function configHasPath(config: unknown, path: string): boolean {
  let node: unknown = config;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[segment];
    if (node === undefined) return false;
  }
  if (Array.isArray(node)) return node.length > 0;
  if (node !== null && typeof node === 'object') return Object.keys(node).length > 0;
  return node !== undefined && node !== null && node !== false;
}

/** True when any diagnostic should fail a `--strict` run. */
export function hasBlocking(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error' || d.severity === 'warn');
}
