/**
 * `graft ir` — dump the semantic IR as JSON.
 *
 * This is both the debugging affordance and the way the target protocol stays inspectable
 * rather than notional (SPEC.md §3.7): what this prints is byte-for-byte what a target
 * receives on stdin.
 */

import { existsSync } from 'node:fs';
import {
  buildIR,
  inspectSpecFile,
  loadConfig,
  ConfigError,
  SpecLoadError,
  type Config,
} from '@graft/core';
import { BRAND, parseIR } from '@graft/protocol';
import { flagBoolean, flagString, type ParsedArgs } from '../args.js';
import type { CommandContext } from './context.js';

export const DEFAULT_CONFIG_PATH = BRAND.configFile;

/** Load config from `--config`, or `graft.yaml` if it happens to exist. */
export async function resolveConfig(
  args: ParsedArgs,
  ctx: CommandContext,
): Promise<{ config: Config; path: string | undefined } | number> {
  const explicit = flagString(args, 'config');
  const path = explicit ?? DEFAULT_CONFIG_PATH;
  if (explicit === undefined && !existsSync(path)) {
    return { config: {}, path: undefined };
  }
  try {
    return { config: await loadConfig(path), path };
  } catch (error) {
    if (error instanceof ConfigError) {
      ctx.stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

export async function runIr(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const specPath = args.positionals[0];
  if (specPath === undefined) {
    ctx.stderr(`usage: ${BRAND.name} ir <spec.yaml> [--config ${BRAND.configFile}] [--summary]\n`);
    return 2;
  }

  const resolved = await resolveConfig(args, ctx);
  if (typeof resolved === 'number') return resolved;

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

  const { ir, diagnostics } = buildIR(inspection, resolved.config);

  // Validate our own output against the published contract. If the core emits an IR that a
  // target would reject, that is a graft bug and it should surface here, not downstream.
  try {
    parseIR(ir);
  } catch (error) {
    ctx.stderr(
      `${BRAND.name}: produced an IR that fails the protocol contract — this is a bug.\n${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 70;
  }

  for (const diagnostic of diagnostics) {
    ctx.stderr(`${diagnostic.severity}: ${diagnostic.message}\n`);
  }

  if (flagBoolean(args, 'summary')) {
    const methods = ir.resources.reduce((sum, r) => sum + r.methods.length, 0);
    const paginated = ir.resources.reduce(
      (sum, r) => sum + r.methods.filter((m) => m.paginationId !== undefined).length,
      0,
    );
    const byRole = new Map<string, number>();
    for (const type of ir.types) {
      if (type.kind === 'object') byRole.set(type.role, (byRole.get(type.role) ?? 0) + 1);
    }
    ctx.stdout(
      [
        `service:    ${ir.service.name.tokens.join(' ')} v${ir.service.version}`,
        `servers:    ${ir.service.servers.map((s) => s.id).join(', ')}`,
        `auth:       ${ir.service.auth.map((a) => a.kind).join(' | ') || 'none'}`,
        `headers:    ${Object.keys(ir.service.constantHeaders).join(', ') || 'none'}`,
        `resources:  ${ir.resources.length}`,
        `methods:    ${methods} (${paginated} paginated)`,
        `types:      ${ir.types.length} (${[...byRole].map(([r, n]) => `${n} ${r}`).join(', ')})`,
        `errors:     ${ir.errors.byStatus.map((e) => e.statusCode).join(', ') || 'none'}`,
        `pagination: ${ir.pagination.map((p) => p.style).join(', ') || 'none'}`,
        '',
      ].join('\n'),
    );
    return 0;
  }

  ctx.stdout(`${JSON.stringify(ir, null, 2)}\n`);
  return 0;
}
