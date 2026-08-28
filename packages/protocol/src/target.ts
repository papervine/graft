/**
 * The target protocol — how besdk supports "any language" (SPEC.md §3.5).
 *
 * A target is an executable. It is invoked twice:
 *
 *   1. `besdk-target-<lang> --sdk-target-protocol`
 *        → prints a {@link Handshake} on stdout and exits 0.
 *
 *   2. `besdk-target-<lang>`
 *        ← receives a {@link TargetInput} as JSON on stdin
 *        → prints a {@link TargetOutput} on stdout and exits 0.
 *
 * Anything on stderr is treated as log output and surfaced to the user. A non-zero exit, or
 * stdout that fails to parse, is a hard failure — never a partial write.
 *
 * The subprocess boundary is deliberate: it lets a Go target be written in Go using `go/ast`
 * and `gofmt`, which is the only way to hit the quality bar for a language whose AST tooling
 * lives in its own ecosystem. Blessed in-tree targets get no shortcut around it, because a
 * plugin API that nothing external exercises rots.
 */

import { z } from 'zod';
import { BRAND } from './branding.js';
import { DiagnosticSchema } from './diagnostic.js';
import { IRSchema } from './ir.js';

/** The flag a target must respond to with a {@link Handshake}. */
export const HANDSHAKE_FLAG = BRAND.handshakeFlag;

/** Prefix by which third-party targets are discovered on `PATH`. */
export const TARGET_EXECUTABLE_PREFIX = BRAND.targetPrefix;

/**
 * Optional behaviours a target can declare. The core uses these to decide what to ask for,
 * and to fail early rather than emitting an SDK that silently drops a feature.
 */
export const CapabilitySchema = z.enum([
  'pagination',
  'streaming',
  'binary-responses',
  'multipart-requests',
  'read-write-split',
  'sync-and-async',
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const HandshakeSchema = z.object({
  /** Target identifier, e.g. `typescript`. Must match the `--target` value users pass. */
  name: z.string().min(1),
  /** Human-facing version of the target itself, independent of the IR version. */
  version: z.string().min(1),
  /**
   * Supported IR versions as semver ranges, e.g. `["1.x"]`. The core refuses to run a target
   * whose range excludes the IR it produces — a mismatch is an error, never a warning,
   * because the failure mode otherwise is a subtly wrong SDK.
   */
  irVersions: z.array(z.string().min(1)).min(1),
  capabilities: z.array(CapabilitySchema),
  /** Language name for display, e.g. `TypeScript`. */
  displayName: z.string().optional(),
  /**
   * Line-comment prefix for the target language: `//`, `#`, `--`.
   *
   * Lets the core find `#region` preservation markers without knowing the language. Declared by the
   * target because only it knows its own syntax; absent means the target does not support
   * preserved regions.
   */
  lineComment: z.string().min(1).max(4).optional(),
  /**
   * Verification gates to run over the emitted output, in order.
   *
   * Declared by the target because only the target knows its language's toolchain, and because the
   * core growing a table of "TypeScript means prettier and tsc, Python means ruff and mypy" is
   * exactly the boundary violation SPEC.md §3.7 exists to prevent. It also means a third-party
   * target gets real gates rather than none, which is what makes the quality bar enforceable
   * outside this repository.
   *
   * Each command is an argv array run with the output directory as its working directory. A target
   * that resolves a tool inside its own dependencies should emit an absolute path — it knows where
   * its own installation is and the core does not.
   */
  gates: z
    .array(
      z.object({
        /** Shown to the user, e.g. `ruff format`. */
        name: z.string().min(1),
        command: z.array(z.string().min(1)).min(1),
        /**
         * What the exit code means.
         *
         * `'fix'` runs the command for its side effects and **ignores its exit code**; `'verify'`
         * treats a non-zero exit as a build failure. The distinction is not cosmetic. `ruff check
         * --fix` exits non-zero when something remains that it could not fix — but at that point the
         * formatter has not run yet, so its verdict is premature; treating it as a verdict failed
         * generation on a line the very next step would have wrapped. Every formatter has this shape
         * (`prettier --write`, `gofmt -w`, `ruff format`), so it is worth naming rather than
         * special-casing.
         */
        kind: z.enum(['fix', 'verify']).default('verify'),
        /**
         * When true, a missing executable is a warning rather than a failure. For a formatter that
         * is a reasonable degradation; for a typechecker it is not, because skipping it silently
         * removes the guarantee the whole pipeline is premised on.
         */
        optional: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type Handshake = z.infer<typeof HandshakeSchema>;

export const TargetInputSchema = z.object({
  irVersion: z.string().min(1),
  ir: IRSchema,
  /**
   * Target-specific options from `besdk.yaml` (`targets.<name>`). Deliberately opaque here:
   * the core must not grow knowledge of individual targets' settings, or the boundary in
   * SPEC.md §3.7 is already broken.
   */
  options: z.record(z.string(), z.unknown()),
  /** Version of the hand-written runtime the generated code should expect. */
  runtimeVersion: z.string().optional(),
  /**
   * The project's own name and the strings derived from it.
   *
   * Required rather than optional, and that is the point: a target must never write this project's
   * name as a literal, because generated files are ones consumers commit and a rename would break
   * them. A target written in Go or Python cannot import `branding.ts`, so if the field were
   * optional it would need a hardcoded fallback — reintroducing exactly what the rule forbids.
   * Making it required means a target can rely on it. See `brandPayload()`.
   */
  brand: z.object({
    name: z.string().min(1),
    title: z.string().min(1),
    homepage: z.string().min(1),
    configFile: z.string().min(1),
    generatedNotice: z.string().min(1),
    attribution: z.string().min(1),
  }),
});
export type TargetInput = z.infer<typeof TargetInputSchema>;

/** The brand strings a target receives. Derived from the schema so it cannot drift from it. */
export type Brand = TargetInput['brand'];

export const GeneratedFileSchema = z.object({
  /** Relative to the output directory. Must not escape it; the core rejects `..` segments. */
  path: z.string().min(1),
  contents: z.string(),
});
export type GeneratedFile = z.infer<typeof GeneratedFileSchema>;

export const TargetOutputSchema = z.object({
  files: z.array(GeneratedFileSchema),
  warnings: z.array(DiagnosticSchema),
});
export type TargetOutput = z.infer<typeof TargetOutputSchema>;

/**
 * Does the IR version besdk emits fall inside a target's declared ranges?
 *
 * Lives here rather than in the CLI because two commands need it — `generate` gates on it and
 * `targets` reports it — and a compatibility check that disagrees with itself is worse than one
 * that is merely strict. Ranges are `1.x`, an exact `1.2.0`, or `*`.
 */
export function satisfiesIrVersion(version: string, ranges: readonly string[]): boolean {
  const [major] = version.split('.');
  return ranges.some((range) => {
    if (range === '*') return true;
    const [rangeMajor, rangeMinor] = range.split('.');
    if (rangeMajor !== major) return false;
    return rangeMinor === 'x' || rangeMinor === undefined || range === version;
  });
}

export function parseHandshake(value: unknown): Handshake {
  return HandshakeSchema.parse(value);
}

export function parseTargetInput(value: unknown): TargetInput {
  return TargetInputSchema.parse(value);
}

export function parseTargetOutput(value: unknown): TargetOutput {
  return TargetOutputSchema.parse(value);
}

/**
 * Reject paths that would write outside the output directory. Targets are third-party code;
 * a manifest is untrusted input.
 */
export function isSafeOutputPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return !p
    .split(/[/\\]/)
    .some((segment) => segment === '..' || segment === '.' || segment.trim() === '');
}
