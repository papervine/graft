#!/usr/bin/env node
/**
 * The target protocol entry point (SPEC.md §3.5).
 *
 *   graft-target-typescript --sdk-target-protocol   → handshake on stdout
 *   graft-target-typescript                    → IR JSON on stdin, manifest on stdout
 *
 * Runs as a subprocess like any third-party target, with no privileged access to the core.
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRAND,
  HANDSHAKE_FLAG,
  parseTargetInput,
  type GeneratedFile,
  type TargetOutput,
} from '@graft/protocol';
import { handshake } from './index.js';
import { TypeScriptEmitter } from './emit.js';

/**
 * Load the hand-written runtime's TypeScript sources for vendoring into the output.
 *
 * Read from the installed package rather than inlined as string constants, so the runtime stays
 * a normal reviewable library that its own test suite exercises (SPEC.md §3.3). Test files are
 * excluded — they belong to the runtime's repo, not to a user's SDK.
 */
export function loadRuntimeSources(): Map<string, string> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('@graft/runtime-typescript/package.json');
  const sourceDir = join(dirname(packageJsonPath), 'src');
  const files = new Map<string, string>();
  for (const name of readdirSync(sourceDir).sort()) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    files.set(name, readFileSync(join(sourceDir, name), 'utf8'));
  }
  if (files.size === 0) {
    throw new Error(`No runtime sources found in ${sourceDir}`);
  }
  return files;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  if (process.argv.includes(HANDSHAKE_FLAG)) {
    process.stdout.write(`${JSON.stringify(handshake)}\n`);
    return 0;
  }

  const raw = await readStdin();
  if (raw.trim() === '') {
    process.stderr.write(`${BRAND.targetPrefix}typescript: expected IR JSON on stdin\n`);
    return 2;
  }

  let input;
  try {
    input = parseTargetInput(JSON.parse(raw));
  } catch (error) {
    process.stderr.write(
      `${BRAND.targetPrefix}typescript: input did not match the IR contract\n${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 2;
  }

  const packageName =
    typeof input.options['packageName'] === 'string' ? input.options['packageName'] : undefined;

  // Target options arrive as an opaque record — the core deliberately knows nothing about them
  // (SPEC.md §3.7) — so each one has to be read and narrowed here.
  const rawSdkVersion = input.options['sdkVersion'];
  const sdkVersion = typeof rawSdkVersion === 'string' ? rawSdkVersion : undefined;

  const rawHeader = input.options['idempotencyHeader'];
  const idempotencyHeader = typeof rawHeader === 'string' ? rawHeader : undefined;

  const rawValidation = input.options['validation'];
  const validation =
    rawValidation === 'strict' || rawValidation === 'warn' || rawValidation === 'off'
      ? rawValidation
      : undefined;

  const emitter = new TypeScriptEmitter(input.ir, {
    ...(packageName !== undefined ? { packageName } : {}),
    ...(validation !== undefined ? { validation } : {}),
    ...(sdkVersion !== undefined ? { sdkVersion } : {}),
    ...(idempotencyHeader !== undefined ? { idempotencyHeader } : {}),
    brand: input.brand,
    runtimeFiles: loadRuntimeSources(),
  });

  const files: GeneratedFile[] = emitter.emit();
  const output: TargetOutput = { files, warnings: [] };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

main().then(
  (code) => {
    // Never process.exit() here: a manifest for a real spec is megabytes, and writes to a pipe
    // are asynchronous, so exiting would truncate it into invalid JSON with no error.
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${BRAND.targetPrefix}typescript: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exitCode = 70;
  },
);
