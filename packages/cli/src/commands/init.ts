/**
 * `besdk init` — write a `besdk.yaml` scaffolded from analysis.
 *
 * Refuses to overwrite an existing config without `--force`. The config accumulates hand-made
 * judgments about the API, so clobbering it silently would destroy the most expensive thing in
 * the repository.
 */

import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inspectSpecFile, renderInitConfig, SpecLoadError } from '@besdk/core';
import { flagBoolean, flagString, type ParsedArgs } from '../args.js';
import type { CommandContext } from './context.js';
import { BRAND } from '@besdk/protocol';

export async function runInit(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const specPath = args.positionals[0];
  if (specPath === undefined) {
    ctx.stderr(`usage: ${BRAND.name} init <spec.yaml> [--out ${BRAND.configFile}] [--target typescript] [--force]\n`);
    return 2;
  }

  const outPath = flagString(args, 'out') ?? BRAND.configFile;
  const force = flagBoolean(args, 'force');
  const stdout = flagBoolean(args, 'stdout');
  const target = flagString(args, 'target');

  if (!stdout && !force && existsSync(outPath)) {
    ctx.stderr(
      `${outPath} already exists. It holds judgments ${BRAND.name} cannot re-derive, so it will not be\n` +
        'overwritten. Pass --force to replace it, or --stdout to preview.\n',
    );
    return 2;
  }

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

  const contents = renderInitConfig(inspection, {
    specPath,
    ...(target !== undefined ? { targets: [target] } : {}),
  });

  if (stdout) {
    ctx.stdout(contents);
    return 0;
  }

  await writeFile(outPath, contents, 'utf8');
  const reviewCount = contents.split('\n').filter((line) => line.includes('REVIEW')).length;
  ctx.stdout(`Wrote ${outPath}\n`);
  if (reviewCount > 0) {
    ctx.stdout(
      `${reviewCount} line${reviewCount === 1 ? '' : 's'} marked REVIEW need your input — ` +
        `${BRAND.name} cannot infer them from the spec.\n`,
    );
  }
  return 0;
}
