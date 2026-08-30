/**
 * `graft generate` — the main verb.
 *
 * Spawns the target as a subprocess, writes its manifest, and runs the language's own
 * formatter and typechecker as gates (SPEC.md §3.4). The subprocess boundary is not bypassed
 * for the in-tree TypeScript target: it is invoked exactly as a third-party target would be.
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  BRAND,
  HANDSHAKE_FLAG,
  IR_VERSION,
  brandPayload,
  isSafeOutputPath,
  parseHandshake,
  parseTargetOutput,
  satisfiesIrVersion,
  TARGET_EXECUTABLE_PREFIX,
  type Handshake,
  type TargetInput,
} from '@graft/protocol';
import {
  buildIR,
  compileIgnore,
  extractRegions,
  inspectSpecFile,
  mergePackageJson,
  mergeRegions,
  regionsEnabled,
  SpecLoadError,
  type Config,
  type PreservedRegion,
} from '@graft/core';
import { flagBoolean, flagString, type ParsedArgs } from '../args.js';
import type { CommandContext } from './context.js';
import { resolveConfig } from './ir.js';
import { resolveTarget } from '../target-resolution.js';
import { readWritten, removeOrphans, writeWritten } from '../written.js';
import { defaultBaselinePath, writeBaseline } from './diff.js';
import { defaultVersionPath } from './release.js';

interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], input?: string, cwd?: string): Promise<SpawnResult> {
  return new Promise((resolveSpawn, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd !== undefined ? { cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolveSpawn({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

export async function runGenerate(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const specPath = args.positionals[0];
  if (specPath === undefined) {
    ctx.stderr(`usage: ${BRAND.name} generate <spec.yaml> [--target typescript] [--out DIR] [--skip-gates]\n`);
    return 2;
  }

  const loaded = await resolveConfig(args, ctx);
  if (typeof loaded === 'number') return loaded;
  const { config } = loaded;

  // Say so when there is no config, because a config-less run is not merely unconfigured — it is
  // materially worse output, produced silently. The read/write split and pagination are both opt-in
  // (§3.1.1, §3.1.3), so without a config `assets.create()` accepts the server-owned `_id` it should
  // refuse and no list operation paginates. The generated per-operation examples now make that visible
  // in the output, but only to someone who reads them; a run that guesses should say it guessed.
  if (loaded.path === undefined) {
    ctx.stderr(
      `No ${BRAND.configFile} found, so the read/write split, pagination, and error shapes are ` +
        `unconfigured.\n  \`${BRAND.name} init ${specPath}\` writes one with every inference spelled out.\n`,
    );
  }

  const targetName = flagString(args, 'target') ?? Object.keys(config.targets ?? {})[0] ?? 'typescript';
  const targetOptions = config.targets?.[targetName] ?? {};
  const outDir = flagString(args, 'out') ?? (targetOptions as { out?: string }).out ?? `sdks/${targetName}`;

  // --- handshake ---------------------------------------------------------
  const configuredCommand = (targetOptions as { command?: readonly string[] }).command;
  const { command, args: commandArgs } = resolveTarget(targetName, configuredCommand);
  let handshake: Handshake;
  try {
    const result = await run(command, [...commandArgs, HANDSHAKE_FLAG]);
    if (result.code !== 0) {
      ctx.stderr(`target \`${targetName}\` failed its handshake (exit ${result.code})\n${result.stderr}`);
      return 2;
    }
    handshake = parseHandshake(JSON.parse(result.stdout));
  } catch (error) {
    ctx.stderr(
      `Could not run target \`${targetName}\`. Expected \`${TARGET_EXECUTABLE_PREFIX}${targetName}\` on PATH.\n  ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 2;
  }

  if (!satisfiesIrVersion(IR_VERSION, handshake.irVersions)) {
    // A hard error, never a warning: a target reading an IR it does not understand produces a
    // subtly wrong SDK, which is worse than no SDK.
    ctx.stderr(
      `IR version mismatch: ${BRAND.name} emits ${IR_VERSION}, target \`${handshake.name}\` accepts ${handshake.irVersions.join(', ')}.\n`,
    );
    return 2;
  }

  // --- build the IR ------------------------------------------------------
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

  const { ir, diagnostics } = buildIR(inspection, config);
  for (const diagnostic of diagnostics) {
    ctx.stderr(`${diagnostic.severity}: ${diagnostic.message}\n`);
  }

  // --- emit --------------------------------------------------------------
  // `command` and `out` are graft's plumbing, not the target's business — a target that received
  // them might reasonably think it was being told where to write, which it never is.
  const { command: _command, out: _out, ...forwardedOptions } = targetOptions as Record<
    string,
    unknown
  >;

  // The released SDK version, when `graft release` has recorded one. Passed to every target so one
  // spec produces one version across all languages — three SDKs from one contract at three different
  // numbers is a support burden with no upside.
  //
  // Deliberately *not* the spec's `info.version`: an API version is not a package version. Stripe's is
  // `2026-07-29.dahlia`, which no package manager will accept.
  const versionPath = defaultVersionPath(specPath);
  if (existsSync(versionPath)) {
    forwardedOptions['sdkVersion'] = (await readFile(versionPath, 'utf8')).trim();
  }
  const input: TargetInput = {
    irVersion: IR_VERSION,
    ir,
    options: forwardedOptions,
    // Sent rather than left to each target to know: a target in another language cannot import
    // `branding.ts`, and a hardcoded fallback is the thing the rule forbids.
    brand: brandPayload(),
  };

  const emitted = await run(command, commandArgs, JSON.stringify(input));
  if (emitted.stderr !== '') ctx.stderr(emitted.stderr);
  if (emitted.code !== 0) {
    ctx.stderr(`target \`${targetName}\` exited ${emitted.code}\n`);
    return 2;
  }

  let manifest;
  try {
    manifest = parseTargetOutput(JSON.parse(emitted.stdout));
  } catch (error) {
    ctx.stderr(
      `target \`${targetName}\` produced an invalid manifest\n  ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }\n`,
    );
    return 2;
  }

  // A manifest is untrusted input: targets are third-party executables.
  const unsafe = manifest.files.filter((file) => !isSafeOutputPath(file.path));
  if (unsafe.length > 0) {
    ctx.stderr(
      `target \`${targetName}\` tried to write outside the output directory:\n${unsafe
        .map((f) => `  ${f.path}`)
        .join('\n')}\n`,
    );
    return 2;
  }

  // --- materialize -------------------------------------------------------
  const absoluteOut = resolvePath(process.cwd(), outDir);
  const clean = flagBoolean(args, 'clean');

  // Read anything worth preserving *before* touching the output directory.
  const preservation = await planPreservation(absoluteOut, manifest.files, config, handshake);

  if (preservation.problems.length > 0) {
    // Never write when preservation is in doubt: the failure mode is deleting hand-written code.
    ctx.stderr(`Refusing to write — hand-written code could be lost.\n\n`);
    for (const problem of preservation.problems) ctx.stderr(`  ${problem}\n`);
    ctx.stderr(
      `\nFix the markers, move the code into a file listed under \`preserve.files\`, or pass\n` +
        `\`--force-overwrite\` to discard it.\n`,
    );
    if (!flagBoolean(args, 'force-overwrite')) return 1;
    ctx.stderr('\n--force-overwrite given; discarding the above.\n\n');
  }

  if (clean && existsSync(absoluteOut)) {
    // `--clean` still respects preserved files: the point of marking a file is that it survives.
    await rm(absoluteOut, { recursive: true, force: true });
  }

  // What graft wrote here last time, read before writing so the two sets can be compared.
  //
  // Keyed by the *configured* output path rather than the absolute one. Passing `absoluteOut` produced
  // `.graft/users-jeff-www-graft-sdks-kitchen-sink.written.json` — a filename carrying one machine's home
  // directory into a directory the repository commits, which would both churn per checkout and stop
  // matching the moment the repo moved.
  const previouslyWritten = await readWritten(outDir);

  let written = 0;
  const nowWritten: string[] = [];
  for (const file of manifest.files) {
    if (preservation.skipped.has(file.path)) continue;
    const destination = join(absoluteOut, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, preservation.contents.get(file.path) ?? file.contents, 'utf8');
    nowWritten.push(file.path);
    written += 1;
  }

  // Restore preserved files that `--clean` removed.
  for (const [path, contents] of preservation.restore) {
    const destination = join(absoluteOut, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, 'utf8');
  }

  // Remove what this run no longer generates. Only files graft itself wrote last time are candidates —
  // see `written.ts` for why that guarantee is the whole point of keeping a record.
  //
  // Everything preserved is kept regardless of how it came to be preserved, so a file the user claimed is
  // never a deletion candidate even if graft once wrote it.
  const keep = new Set([...nowWritten, ...preservation.skipped, ...preservation.restore.keys()]);
  // The *removal* still works from the absolute path, because that is where the files are.
  const orphans = await removeOrphans(absoluteOut, previouslyWritten, keep);
  await writeWritten(outDir, nowWritten);

  for (const warning of manifest.warnings) {
    ctx.stderr(`${warning.severity}: ${warning.message}\n`);
  }
  ctx.stdout(`Wrote ${written} files to ${outDir}\n`);
  if (orphans.length > 0) {
    // Reported rather than silent. A deletion nobody mentioned is indistinguishable from a bug, and after
    // a rename the user needs to see which file went.
    const shown = orphans.slice(0, 5).map((path) => `  ${path}`);
    ctx.stdout(
      `Removed ${orphans.length} file${orphans.length === 1 ? '' : 's'} no longer generated:\n` +
        `${shown.join('\n')}\n` +
        (orphans.length > shown.length ? `  … and ${orphans.length - shown.length} more\n` : ''),
    );
  }
  reportPreservation(preservation, ctx);

  // Bootstrap the baseline `graft diff` compares against, but **only when it does not exist**.
  //
  // Writing it on every run destroys the comparison point: the normal workflow is generate then
  // diff, so an unconditional write meant `diff` always reported "no contract changes" and the
  // CI gate could never fire. Updating the baseline is a deliberate act — `graft diff --accept`.
  //
  // Kept outside the output directory so it never ships to SDK consumers.
  const baselinePath = flagString(args, 'baseline') ?? defaultBaselinePath(specPath);
  if (!flagBoolean(args, 'no-baseline') && !existsSync(baselinePath)) {
    await writeBaseline(baselinePath, ir);
    ctx.stdout(
      `Wrote IR baseline ${baselinePath} — commit it so \`${BRAND.name} diff\` can gate on it.\n`,
    );
  }

  if (flagBoolean(args, 'skip-gates')) return 0;

  // --- gates -------------------------------------------------------------
  return runGates(absoluteOut, outDir, handshake, ctx);
}

/**
 * Run the verification gates the target declared.
 *
 * Non-negotiable per AGENTS.md: output that fails the language's strict typechecker fails the build.
 * *Which* commands those are is the target's decision, not the core's — see `Handshake.gates`. A
 * target that declares none falls back to the TypeScript toolchain for backwards compatibility,
 * which is the only place the core still names a specific language.
 */
async function runGates(
  absoluteOut: string,
  displayPath: string,
  handshake: Handshake,
  ctx: CommandContext,
): Promise<number> {
  const gates = handshake.gates;
  if (gates === undefined || gates.length === 0) {
    // Said out loud rather than filled in. The core used to fall back to a hardcoded prettier-and-tsc
    // run here, which is the language-specific table SPEC.md §3.7 exists to prevent — and it hid that
    // the blessed TypeScript target was the only one not declaring gates of its own. A third-party
    // target that declares none gets none, and now learns so.
    ctx.stderr(
      `target \`${handshake.name}\` declares no verification gates, so ${displayPath} is unverified.\n` +
        `  A target should declare its own formatter and typechecker; see the target-authoring guide.\n`,
    );
    return 0;
  }

  for (const gate of gates) {
    const [command, ...gateArgs] = gate.command;
    let result: SpawnResult;
    try {
      result = await run(command!, gateArgs, undefined, absoluteOut);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (gate.optional === true) {
        ctx.stderr(`${gate.name} not available; skipping (${message})\n`);
        continue;
      }
      ctx.stderr(
        `✗ ${gate.name} could not be run, and it is required.\n  ${message}\n` +
          `  Install it, or pass --skip-gates to emit unverified output.\n`,
      );
      return 1;
    }
    if (gate.kind === 'fix') {
      // Run for side effects only. A formatter's exit code is not a verdict on the output — see
      // `Handshake.gates.kind`.
      ctx.stdout(`✓ ${gate.name}\n`);
      continue;
    }
    if (result.code !== 0) {
      const output = result.stdout || result.stderr;
      ctx.stderr(`✗ ${displayPath} failed ${gate.name}\n${output.slice(0, 8000)}\n`);
      return 1;
    }
    ctx.stdout(`✓ ${gate.name}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Preservation
// ---------------------------------------------------------------------------

interface PreservationPlan {
  /** Manifest paths not to write, because the user owns them. */
  readonly skipped: Set<string>;
  /** Manifest paths whose content was rewritten to carry preserved code. */
  readonly contents: Map<string, string>;
  /** Preserved files to restore after `--clean` removed them. */
  readonly restore: Map<string, string>;
  /** Regions carried across, as `path#region`. */
  readonly applied: string[];
  /** Ignored files the generator would otherwise have changed — Fern's silent-staleness trap. */
  readonly stale: string[];
  /** Anything that would lose code. Non-empty means refuse to write. */
  readonly problems: string[];
  readonly carriedPackageKeys: string[];
}

/**
 * Work out what to preserve, reading the existing output directory.
 *
 * Runs before anything is written or removed, so a refusal costs nothing.
 */
async function planPreservation(
  absoluteOut: string,
  files: readonly { path: string; contents: string }[],
  config: Config,
  handshake: Handshake,
): Promise<PreservationPlan> {
  const plan: PreservationPlan = {
    skipped: new Set(),
    contents: new Map(),
    restore: new Map(),
    applied: [],
    stale: [],
    problems: [],
    carriedPackageKeys: [],
  };

  if (!existsSync(absoluteOut)) return plan;

  // `.graftignore` in the output directory, plus `preserve.files` from config.
  const ignoreFile = join(absoluteOut, `.${BRAND.name}ignore`);
  const fromFile = existsSync(ignoreFile)
    ? (await readFile(ignoreFile, 'utf8')).split('\n')
    : [];
  const patterns = [...fromFile, ...(config.preserve?.files ?? [])];
  // The ignore file itself is always the user's.
  patterns.push(`.${BRAND.name}ignore`);
  const isIgnored = compileIgnore(patterns);

  const readIfPresent = async (path: string): Promise<string | undefined> => {
    const full = join(absoluteOut, path);
    return existsSync(full) ? readFile(full, 'utf8') : undefined;
  };

  for (const file of files) {
    if (isIgnored(file.path)) {
      plan.skipped.add(file.path);
      const existing = await readIfPresent(file.path);
      if (existing !== undefined) {
        plan.restore.set(file.path, existing);
        // The improvement over a plain ignore list: say when holding a file back is costing you an
        // update, instead of letting it drift silently.
        if (existing !== file.contents) plan.stale.push(file.path);
      }
      continue;
    }

    // package.json carries user dependencies that must survive.
    if (file.path === 'package.json') {
      const existing = await readIfPresent(file.path);
      const { text, carried } = mergePackageJson(file.contents, existing);
      if (carried.length > 0) {
        plan.contents.set(file.path, text);
        plan.carriedPackageKeys.push(...carried);
      }
      continue;
    }

    if (!regionsEnabled(config)) continue;
    const lineComment = handshake.lineComment;
    if (lineComment === undefined) continue;

    const existing = await readIfPresent(file.path);
    if (existing === undefined) continue;

    const { regions, problems } = extractRegions(existing, { lineComment });
    for (const problem of problems) plan.problems.push(`${file.path}: ${problem}`);
    if (regions.length === 0) continue;

    const merged = mergeRegions(file.contents, regions, { lineComment });
    for (const orphan of merged.orphaned) {
      plan.problems.push(
        `${file.path}: region \`${orphan.name}\` has code but the regenerated file has no such region`,
      );
    }
    if (merged.applied.length > 0) {
      plan.contents.set(file.path, merged.text);
      plan.applied.push(...merged.applied.map((name) => `${file.path}#${name}`));
    }
  }

  // Preserved files that the manifest does not mention at all still need restoring after --clean.
  const manifestPaths = new Set(files.map((f) => f.path));
  const walk = async (dir: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(join(absoluteOut, dir), { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), `${rel}/`);
      } else if (!manifestPaths.has(rel) && isIgnored(rel)) {
        plan.restore.set(rel, await readFile(join(absoluteOut, rel), 'utf8'));
      }
    }
  };
  await walk('.');

  return plan;
}

function reportPreservation(plan: PreservationPlan, ctx: CommandContext): void {
  if (plan.skipped.size > 0) {
    ctx.stdout(`  ${plan.skipped.size} file(s) left untouched (preserved)\n`);
  }
  if (plan.applied.length > 0) {
    ctx.stdout(`  ${plan.applied.length} custom region(s) carried across\n`);
  }
  if (plan.carriedPackageKeys.length > 0) {
    ctx.stdout(`  kept in package.json: ${plan.carriedPackageKeys.join(', ')}\n`);
  }
  for (const path of plan.stale) {
    // Silent staleness is the failure mode of a plain ignore list, so it is stated out loud.
    ctx.stderr(
      `warn: ${path} is preserved, but the generator would have changed it — it may be out of date\n`,
    );
  }
}
