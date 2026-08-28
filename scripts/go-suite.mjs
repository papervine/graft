/**
 * Build the Go target and run the Go packages' own test suites.
 *
 * A script rather than pnpm workspace entries because these are Go modules: pnpm has no view into
 * them, and a `package.json` in a directory containing no JavaScript would be a lie.
 *
 * **Skips rather than fails when Go is absent**, on the same principle as the Python suite: a
 * contributor working only on the TypeScript target should not need a Go toolchain to run
 * `pnpm verify`. CI installs it, so the suite is enforced where enforcement matters. The skip is loud.
 *
 * The build step is not optional even in "test" mode: `corpus/kitchen-sink/besdk.yaml` points the Go
 * target at `packages/target-go/bin/besdk-target-go`, so a stale binary would silently generate from
 * yesterday's emitter.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function findGo() {
  const which = spawnSync('sh', ['-c', 'command -v go'], { encoding: 'utf8' });
  const found = which.stdout.trim();
  if (found !== '') return found;
  for (const candidate of ['/usr/local/go/bin/go', '/opt/homebrew/bin/go']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const go = findGo();
if (go === undefined) {
  process.stderr.write(
    'Go toolchain not found; skipping the Go suites and the target build.\n' +
      '  Install Go 1.22 or later from https://go.dev/dl/ to run them.\n',
  );
  process.exit(0);
}

const steps = [
  ['target: build binary', ['build', '-o', 'bin/besdk-target-go', './cmd/besdk-target-go'], 'packages/target-go'],
  ['runtime: vet', ['vet', './...'], 'packages/runtime-go'],
  ['runtime: test', ['test', './...'], 'packages/runtime-go'],
  ['target: vet', ['vet', './...'], 'packages/target-go'],
  ['target: test', ['test', './...'], 'packages/target-go'],
];

let failed = 0;
for (const [label, args, cwd] of steps) {
  const result = spawnSync(go, args, { cwd: join(ROOT, cwd), stdio: 'pipe', encoding: 'utf8' });
  if (result.status === 0) {
    process.stdout.write(`✓ ${label}\n`);
    continue;
  }
  failed += 1;
  process.stderr.write(`✗ ${label}\n${(result.stdout || '') + (result.stderr || '')}\n`);
}

// gofmt is checked with `gofmt -l`, which *lists* files needing formatting. `go fmt -n` was the
// first attempt and it prints the command it would run whether or not anything is misformatted — so
// it reported drift on every clean run. A check that always fails is worse than no check.
const gofmt = go.replace(/go$/, 'gofmt');
for (const pkg of ['packages/runtime-go', 'packages/target-go']) {
  const result = spawnSync(gofmt, ['-l', '.'], {
    cwd: join(ROOT, pkg),
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const drifted = (result.stdout || '').trim();
  if (drifted !== '') {
    process.stderr.write(`✗ ${pkg}: gofmt drift\n${drifted}\n`);
    failed += 1;
  } else {
    process.stdout.write(`✓ ${pkg}: gofmt\n`);
  }
}

process.exitCode = failed === 0 ? 0 : 1;
