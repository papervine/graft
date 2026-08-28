/**
 * `@besdk/target-typescript` — the TypeScript target.
 *
 * Boundary rule (SPEC.md §3.7): must never import `@besdk/core`. It communicates only via
 * the protocol on stdin/stdout, exactly like a third-party target.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { IR_VERSION, type Handshake } from '@besdk/protocol';

/**
 * Absolute path to an executable inside this package's own dependencies.
 *
 * The protocol asks for exactly this: "a target that resolves a tool inside its own dependencies
 * should emit an absolute path — it knows where its own installation is and the core does not."
 * Returns `undefined` when the tool is absent, so the caller can mark the gate optional rather than
 * emit a command that cannot run.
 */
function resolveBin(packageName: string, binPath?: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const root = dirname(manifestPath);
    if (binPath !== undefined) return join(root, binPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const bin = manifest.bin;
    const relative = typeof bin === 'string' ? bin : Object.values(bin ?? {})[0];
    return relative === undefined ? undefined : join(root, relative);
  } catch {
    return undefined;
  }
}

/**
 * Verification gates for generated TypeScript.
 *
 * Declared here rather than known by the core, and this target was the last one not doing so — Go and
 * Python both declared theirs, while the core kept a hardcoded prettier-and-tsc branch alive for
 * TypeScript alone. That is the language-specific table §3.7 exists to prevent, and worse, it meant the
 * blessed reference target was the one not exercising the protocol it ships — the same failure mode
 * "blessed targets get no in-process privileges" (§3.5) was written to avoid.
 *
 * Order matters: format first, so the typechecker reports positions in the final text.
 *
 * Both tsconfigs are always emitted (see `emit.ts`), so the commands are static rather than conditional
 * on what landed on disk.
 */
function gates(): Handshake['gates'] {
  const node = process.execPath;
  const prettier = resolveBin('prettier');
  const tsc = resolveBin('typescript', 'bin/tsc');

  const declared: NonNullable<Handshake['gates']> = [];
  if (prettier !== undefined) {
    declared.push({
      name: 'prettier',
      command: [node, prettier, '--write', '--log-level', 'warn', '.'],
      // A formatter's exit code is not a verdict on the output; see `Handshake.gates.kind`.
      kind: 'fix',
      // Absent formatting is a cosmetic loss. Absent typechecking is not, which is why only this one
      // is optional.
      optional: true,
    });
  }
  if (tsc !== undefined) {
    declared.push(
      { name: 'tsc', command: [node, tsc, '-p', 'tsconfig.json', '--noEmit'], kind: 'verify' },
      // The examples compile as part of the typecheck, which is what stops a `@example` in a docstring
      // from drifting into code that does not build.
      { name: 'tsc (examples)', command: [node, tsc, '-p', 'tsconfig.examples.json', '--noEmit'], kind: 'verify' },
    );
  }

  // The generated per-operation tests, run as a gate (SPEC.md §3.11).
  //
  // Optional, and that is a deliberate asymmetry with `tsc`: a typechecker ships with the target's own
  // dependencies, while a test runner has to be installed in the *output* package. Generating into a
  // directory where `npm install` has not been run is normal — it is what `besdk generate` does on a
  // first run — and failing generation because a devDependency is absent would make the feature a
  // liability. When vitest is there, the tests run and a broken request fails the build.
  //
  // Worth stating why this is a gate at all rather than a suite the user runs: these tests caught the
  // exact multipart bug five of six targets shipped, and they caught it by asserting a content type no
  // typechecker can see. A generated test nobody runs is documentation.
  const vitest = resolveBin('vitest');
  if (vitest !== undefined) {
    declared.push({
      name: 'generated tests',
      command: [node, vitest, 'run', '--root', '.', '--dir', 'tests'],
      kind: 'verify',
      optional: true,
    });
  }
  return declared;
}

export const handshake: Handshake = {
  name: 'typescript',
  displayName: 'TypeScript',
  version: '0.0.0',
  irVersions: [`${IR_VERSION.split('.')[0]}.x`],
  /**
   * What this target actually emits, which is not what it used to claim.
   *
   * It declared `pagination` and `read-write-split` only, while emitting `async *stream()` over SSE,
   * `Blob`/stream handling for binary responses, and `FormData` for multipart bodies — all three
   * covered by tests. `besdk targets` prints this list, so a third-party author reading it to see what
   * a reference target supports was told less than the truth.
   *
   * `sync-and-async` is deliberately absent, and that one is honest: every method returns a promise,
   * because TypeScript has no synchronous HTTP. Python declares it because it emits both clients.
   */
  capabilities: [
    'pagination',
    'streaming',
    'binary-responses',
    'multipart-requests',
    'read-write-split',
  ],
  lineComment: '//',
  gates: gates(),
};
