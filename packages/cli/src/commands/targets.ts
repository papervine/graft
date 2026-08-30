/**
 * `graft targets` — what targets are installed, and will they run?
 *
 * Exists because the failure it diagnoses is otherwise opaque. A target is a subprocess discovered
 * on `PATH` (SPEC.md §3.5), so "it isn't installed", "it crashed on handshake", and "it does not
 * accept this IR version" all look the same from `generate`. This separates them, and gives someone
 * writing a target a way to check their handshake without generating anything.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pc from 'picocolors';
import {
  BRAND,
  HANDSHAKE_FLAG,
  IR_VERSION,
  parseHandshake,
  satisfiesIrVersion,
  TARGET_EXECUTABLE_PREFIX,
  type Handshake,
} from '@graft/protocol';
import { loadConfig, ConfigError } from '@graft/core';
import { existsSync } from 'node:fs';
import { flagBoolean, flagString, type ParsedArgs } from '../args.js';
import type { CommandContext } from './context.js';
import { resolveTarget, type TargetOrigin } from '../target-resolution.js';

/** Targets shipped in this distribution. Checked before `PATH` so a checkout works unconfigured. */
const BLESSED = ['typescript'];

interface Discovered {
  readonly name: string;
  /** How it was found, for the report. */
  readonly origin: TargetOrigin;
  readonly command: string;
  readonly args: readonly string[];
}

interface Probed extends Discovered {
  readonly handshake?: Handshake;
  readonly error?: string;
  readonly compatible: boolean;
}

function run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function probe(target: Discovered): Promise<Probed> {
  try {
    const result = await run(target.command, [...target.args, HANDSHAKE_FLAG]);
    if (result.code !== 0) {
      return {
        ...target,
        error: `handshake exited ${result.code}${result.stderr === '' ? '' : `: ${result.stderr.trim().split('\n')[0]}`}`,
        compatible: false,
      };
    }
    const handshake = parseHandshake(JSON.parse(result.stdout));
    return {
      ...target,
      handshake,
      compatible: satisfiesIrVersion(IR_VERSION, handshake.irVersions),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...target,
      error: /ENOENT/.test(message) ? 'not installed' : message,
      compatible: false,
    };
  }
}

export async function runTargets(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const json = flagBoolean(args, 'json');
  const color = !flagBoolean(args, 'no-color') && process.stdout.isTTY === true;

  // Any target named in config is probed too, so a configured-but-missing target is visible here
  // rather than only when `generate` fails.
  // The *command* each target configures, not just its name. Reading only the names was the bug: a
  // target reachable solely through `targets.<name>.command` — which is how the Python and Go targets
  // run from a checkout — was reported as "not installed, expected on PATH" while `generate` ran it
  // happily. Both commands now resolve through `resolveTarget`, so they cannot disagree again.
  const configuredCommands = new Map<string, readonly string[] | undefined>();
  const configPath = flagString(args, 'config') ?? BRAND.configFile;
  if (existsSync(configPath)) {
    try {
      const config = await loadConfig(configPath);
      for (const [name, target] of Object.entries(config.targets ?? {})) {
        configuredCommands.set(name, (target as { command?: readonly string[] }).command);
      }
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      // A broken config should not stop us reporting what is installed.
      ctx.stderr(`${configPath}: could not be read; reporting installed targets only\n`);
    }
  }

  const names = [...new Set([...BLESSED, ...configuredCommands.keys()])].sort();
  const discovered: Discovered[] = names.map((name) => ({
    name,
    ...resolveTarget(name, configuredCommands.get(name)),
  }));

  const probed = await Promise.all(discovered.map(probe));

  if (json) {
    ctx.stdout(`${JSON.stringify({ irVersion: IR_VERSION, targets: probed }, null, 2)}\n`);
    return probed.some((t) => !t.compatible) && flagBoolean(args, 'strict') ? 1 : 0;
  }

  const ok = (text: string): string => (color ? pc.green(text) : text);
  const bad = (text: string): string => (color ? pc.red(text) : text);
  const dim = (text: string): string => (color ? pc.dim(text) : text);

  ctx.stdout(`${BRAND.name} emits IR ${IR_VERSION}\n\n`);

  for (const target of probed) {
    if (target.handshake === undefined) {
      ctx.stdout(`  ${bad('✗')} ${target.name} ${dim(`— ${target.error ?? 'unavailable'}`)}\n`);
      ctx.stdout(`      ${dim(`expected \`${TARGET_EXECUTABLE_PREFIX}${target.name}\` on PATH`)}\n`);
      continue;
    }

    const { handshake } = target;
    const mark = target.compatible ? ok('✓') : bad('✗');
    ctx.stdout(
      `  ${mark} ${handshake.name} ${dim(`v${handshake.version}`)} ${dim(`(${target.origin})`)}\n`,
    );
    ctx.stdout(`      IR ${handshake.irVersions.join(', ')}`);
    if (!target.compatible) {
      ctx.stdout(bad(` — incompatible with ${IR_VERSION}`));
    }
    ctx.stdout('\n');
    if (handshake.capabilities.length > 0) {
      ctx.stdout(`      ${dim(handshake.capabilities.join(', '))}\n`);
    }
  }

  const unusable = probed.filter((t) => !t.compatible);
  if (unusable.length === 0) {
    ctx.stdout(`\n${ok('✓')} ${probed.length} target${probed.length === 1 ? '' : 's'} usable.\n`);
    return 0;
  }

  ctx.stdout(
    `\n${unusable.length} of ${probed.length} unusable: ${unusable.map((t) => t.name).join(', ')}.\n`,
  );
  return flagBoolean(args, 'strict') ? 1 : 0;
}
