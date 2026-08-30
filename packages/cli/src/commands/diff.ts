/**
 * `graft diff` — what regenerating would do to the SDK's consumers.
 *
 * Answers the open question in SPEC.md §9: regenerating must not silently break downstream users.
 * A file-level diff cannot answer it — reformatting shows as a change, and a renamed method shows
 * as one removal plus one addition. This compares *IRs*, so every finding is expressed in terms
 * of the contract: what breaks, what is merely new.
 *
 * Exit codes: 0 no breaking changes, 1 breaking changes under `--strict`, 2 could not run.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import pc from 'picocolors';
import { buildIR, inspectSpecFile, diffIR, impliedBump, SpecLoadError, type Change } from '@graft/core';
import { BRAND, parseIR, type IR } from '@graft/protocol';
import { flagBoolean, flagString, type ParsedArgs } from '../args.js';
import type { CommandContext } from './context.js';
import { resolveConfig } from './ir.js';

export const BASELINE_DIR = BRAND.stateDir;

/**
 * Default baseline location, derived from the spec path.
 *
 * Per-spec, not global: a single shared path meant generating a second spec silently overwrote
 * the first one's baseline, and the next `diff` then compared one API against a completely
 * different one — reporting hundreds of spurious breaking changes.
 *
 * Committed to the repo so CI has something to compare against, and kept out of the generated
 * package so it never ships to consumers.
 */
export function defaultBaselinePath(specPath: string): string {
  const slug = specPath
    .replace(/\.(ya?ml|json)$/i, '')
    .replace(/^\.\//, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${BASELINE_DIR}/${slug || 'spec'}.ir.json`;
}

export async function writeBaseline(path: string, ir: IR): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ir, null, 2)}\n`, 'utf8');
}

const MARKS = { breaking: '✗', additive: '+', patch: '·' } as const;

function paint(change: Change, color: boolean): string {
  const mark = MARKS[change.severity];
  if (!color) return mark;
  if (change.severity === 'breaking') return pc.red(mark);
  if (change.severity === 'additive') return pc.green(mark);
  return pc.dim(mark);
}

export async function runDiff(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const specPath = args.positionals[0];
  if (specPath === undefined) {
    ctx.stderr(`usage: ${BRAND.name} diff <spec.yaml> [--baseline PATH] [--strict] [--json]\n`);
    return 2;
  }

  const baselinePath = flagString(args, 'baseline') ?? defaultBaselinePath(specPath);
  const strict = flagBoolean(args, 'strict');
  const json = flagBoolean(args, 'json');
  const color = !flagBoolean(args, 'no-color') && process.stdout.isTTY === true;

  if (!existsSync(baselinePath)) {
    ctx.stderr(
      `No baseline at ${baselinePath}.\n` +
        `  \`${BRAND.name} generate ${specPath}\` writes one. Commit it so CI can compare against it.\n`,
    );
    return 2;
  }

  let baseline: IR;
  try {
    baseline = parseIR(JSON.parse(await readFile(baselinePath, 'utf8')));
  } catch (error) {
    ctx.stderr(
      `${baselinePath}: not a valid IR baseline\n  ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }\n`,
    );
    return 2;
  }

  const loaded = await resolveConfig(args, ctx);
  if (typeof loaded === 'number') return loaded;

  let inspection;
  try {
    inspection = await inspectSpecFile(specPath);
  } catch (error) {
    if (error instanceof SpecLoadError) {
      ctx.stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const { ir } = buildIR(inspection, loaded.config);
  const result = diffIR(baseline, ir);

  if (json) {
    ctx.stdout(`${JSON.stringify({ ...result, bump: impliedBump(result) }, null, 2)}\n`);
  } else {
    const bold = (text: string): string => (color ? pc.bold(text) : text);
    ctx.stdout(`${bold(specPath)} vs baseline ${baselinePath}\n\n`);

    if (result.changes.length === 0) {
      ctx.stdout(`${color ? pc.green('✓') : '✓'} No contract changes.\n`);
    } else {
      for (const change of result.changes) {
        ctx.stdout(`  ${paint(change, color)} ${change.path}: ${change.message}\n`);
        if (change.detail !== undefined) {
          ctx.stdout(`      ${color ? pc.dim(change.detail) : change.detail}\n`);
        }
      }
      const bump = impliedBump(result);
      ctx.stdout(
        `\n${result.breaking} breaking, ${result.additive} additive, ${result.patch} other` +
          ` — implies a ${bold(bump)} version bump.\n`,
      );
      if (result.breaking > 0 && !strict) {
        ctx.stdout(
          `${color ? pc.dim('Run with --strict to fail CI on breaking changes.') : 'Run with --strict to fail CI on breaking changes.'}\n`,
        );
      }
    }
  }

  if (flagBoolean(args, 'accept')) {
    await writeBaseline(baselinePath, ir);
    ctx.stdout(`Updated baseline ${baselinePath}\n`);
    return 0;
  }

  return strict && result.breaking > 0 ? 1 : 0;
}
