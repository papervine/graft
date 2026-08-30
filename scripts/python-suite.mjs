/**
 * Run the Python packages' own test suites.
 *
 * Kept as a script rather than a pnpm workspace entry because these are Python packages: pnpm has
 * no view into them, and pretending otherwise would mean a `package.json` in a directory that has
 * no JavaScript in it.
 *
 * **Skips rather than fails when the toolchain is absent.** A contributor working only on the
 * TypeScript target should not need a Python environment to run `pnpm verify`, and a hard failure
 * here would make the Python target's dependencies everyone's problem. CI installs them, so the
 * suite is enforced where enforcement matters. The skip is loud.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const VENV = join(ROOT, 'packages/runtime-python/.venv/bin/python');

if (!existsSync(VENV)) {
  process.stderr.write(
    `Python toolchain not found at ${VENV}; skipping the Python suites.\n` +
      `  Set it up with:  cd packages/runtime-python && uv venv .venv && \\\n` +
      `                   uv pip install --python .venv/bin/python -e . ruff mypy pytest pytest-asyncio\n`,
  );
  process.exit(0);
}

/** Each step is (label, argv, cwd). A non-zero exit fails the suite. */
const steps = [
  ['runtime: ruff', [VENV, '-m', 'ruff', 'check', 'src', 'tests'], 'packages/runtime-python'],
  ['runtime: mypy --strict', [VENV, '-m', 'mypy', '--strict', 'src/graft_runtime'], 'packages/runtime-python'],
  ['runtime: pytest', [VENV, '-m', 'pytest', '-q', 'tests'], 'packages/runtime-python'],
  ['target: ruff', [VENV, '-m', 'ruff', 'check', 'src'], 'packages/target-python'],
  ['target: pytest', [VENV, '-m', 'pytest', '-q', 'tests'], 'packages/target-python'],
];

let failed = 0;
for (const [label, argv, cwd] of steps) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: join(ROOT, cwd),
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status === 0) {
    process.stdout.write(`✓ ${label}\n`);
    continue;
  }
  failed += 1;
  process.stderr.write(`✗ ${label}\n${(result.stdout || '') + (result.stderr || '')}\n`);
}

process.exitCode = failed === 0 ? 0 : 1;
