/**
 * `graft check` — validate a spec and report what it fails to say (SPEC.md §3.6).
 *
 * Exit codes: 0 clean, 1 warnings present under `--strict`, 2 the spec could not be read.
 * The distinction matters for CI, where "your spec is vague" and "your spec is broken" want
 * different responses.
 */

import { buildIR, inspectSpecFile, SpecLoadError } from '@graft/core';
import { renderReport } from '../report.js';
import { flagBoolean, type ParsedArgs } from '../args.js';
import { BRAND, withoutResolved, type Diagnostic } from '@graft/protocol';
import { resolveConfig } from './ir.js';
import type { CommandContext } from './context.js';

export type { CommandContext } from './context.js';


export async function runCheck(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const specPath = args.positionals[0];
  if (specPath === undefined) {
    ctx.stderr(
      `usage: ${BRAND.name} check <spec.yaml> [--config ${BRAND.configFile}] [--strict] [--json] ` +
        `[--no-color]\n`,
    );
    return 2;
  }

  const strict = flagBoolean(args, 'strict');
  const json = flagBoolean(args, 'json');
  const color = !flagBoolean(args, 'no-color') && process.stdout.isTTY === true;

  let inspection;
  try {
    inspection = await inspectSpecFile(specPath);
  } catch (error) {
    if (error instanceof SpecLoadError) {
      // Spec garbage must produce a useful message, never a stack trace.
      ctx.stderr(`${error.message}\n`);
      const cause = error.cause;
      if (cause instanceof Error && cause.message !== '') {
        ctx.stderr(`  ${cause.message.split('\n')[0]}\n`);
      }
      return 2;
    }
    throw error;
  }

  const { analysis, spec } = inspection;

  // The IR is built so its diagnostics are reported too, and this is not an optimisation detail.
  // `check` used to report only the analyzer's findings, which left five codes — a colliding
  // `operationId`, a conflicting `discriminator`, an OAuth2 scheme with no usable flow, a server URL
  // that cannot be resolved, a tolerated spec violation — reachable *only* by running `generate`.
  // A command whose entire purpose is surfacing what a spec fails to say must not hide half of it.
  //
  // Config is loaded for the same reason: a diagnostic the user has already answered in
  // `graft.yaml` is noise, and `check` that keeps nagging about a fixed problem stops being read.
  const resolved = await resolveConfig(args, ctx);
  if (typeof resolved === 'number') return resolved;
  const { diagnostics: irDiagnostics } = buildIR(inspection, resolved.config);
  // Anything the config already answers is dropped. `graft init` writes exactly these fixes, so without
  // this the documented flow — init, edit, gate CI on `check --strict` — could never pass: the three
  // warnings init had just resolved were reported on every run.
  const diagnostics = withoutResolved(
    mergeDiagnostics(analysis.diagnostics, irDiagnostics),
    resolved.config,
  );

  if (json) {
    ctx.stdout(
      `${JSON.stringify(
        {
          source: spec.source,
          dialect: spec.dialect,
          summary: analysis.summary,
          diagnostics,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    ctx.stdout(
      `${renderReport(
        { source: spec.source, ...analysis.summary },
        diagnostics,
        { color },
        strict,
      )}\n`,
    );
  }

  const blocking = diagnostics.some(
    (d) => d.severity === 'error' || d.severity === 'warn',
  );
  return strict && blocking ? 1 : 0;
}

/**
 * Combine the analyzer's diagnostics with the IR builder's, dropping duplicates.
 *
 * Both stages can reach the same conclusion by different routes — `ERROR_SCHEMA_MISSING` is raised by
 * the analyzer from the spec and by the builder from the assembled taxonomy — and reporting it twice
 * reads as two problems. Identity is the code plus the message, not the code alone: two diagnostics
 * sharing a code can name different things.
 */
function mergeDiagnostics(
  analysis: readonly Diagnostic[],
  ir: readonly Diagnostic[],
): Diagnostic[] {
  const seen = new Set(analysis.map((d) => `${d.code}\u0000${d.message}`));
  const extra = ir.filter((d) => !seen.has(`${d.code}\u0000${d.message}`));
  return [...analysis, ...extra];
}
