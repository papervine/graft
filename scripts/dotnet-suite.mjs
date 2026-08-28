/**
 * Run the .NET packages' own gates: `dotnet format --verify-no-changes`, then `dotnet test`.
 *
 * A script rather than pnpm workspace entries for the same reason as Go, Python, PHP, and Java: these are MSBuild
 * projects, pnpm has no view into them, and a `package.json` in a directory containing no JavaScript would be a
 * lie.
 *
 * **Runs through `devbox` when it is available**, because that is where the .NET SDK comes from
 * (`AGENTS.md`). Falling back to `PATH` keeps the suite usable for someone who installed it another way, and
 * skipping loudly is the last resort — a contributor working only on the TypeScript target should not need the
 * .NET SDK to run `pnpm verify`.
 *
 * The build itself carries `TreatWarningsAsErrors` and `Nullable` from `Directory.Build.props`, so `dotnet test`
 * is both the correctness gate and the test run: nullable-reference warnings are errors, which is what makes
 * `T?` load-bearing rather than documentation (SPEC.md §3.3.11).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Projects with gates to run, in dependency order. */
const PROJECTS = [
  { label: 'runtime-dotnet', dir: 'packages/runtime-dotnet' },
  // The target has no tests of its own yet; `dotnet build` is still the gate, and building it here keeps the
  // jar-equivalent fresh for `generate:dotnet` — the same trap the Go and Java suites document.
  { label: 'target-dotnet', dir: 'packages/target-dotnet' },
];

function runner() {
  const hasDevbox =
    spawnSync('sh', ['-c', 'command -v devbox'], { encoding: 'utf8' }).stdout.trim() !== '' &&
    existsSync(join(ROOT, 'devbox.json'));
  if (hasDevbox) {
    // `devbox run` executes at the project root regardless of the spawn cwd, so the directory change has to be
    // inside the command — the same trap the Java suite documents.
    return (argv, cwd) =>
      spawnSync(
        'devbox',
        [
          'run',
          '--',
          'sh',
          '-c',
          `cd ${JSON.stringify(cwd)} && ${argv.map((a) => JSON.stringify(a)).join(' ')}`,
        ],
        { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' },
      );
  }
  return (argv, cwd) => spawnSync(argv[0], argv.slice(1), { cwd, stdio: 'pipe', encoding: 'utf8' });
}

const run = runner();

const probe = run(['dotnet', '--version'], ROOT);
if (probe.status !== 0) {
  process.stderr.write(
    'No .NET SDK found; skipping the .NET suites.\n' +
      '  `devbox install` provides the .NET 8 SDK.\n',
  );
  process.exit(0);
}

let failed = 0;

for (const { label, dir } of PROJECTS) {
  const cwd = join(ROOT, dir);

  // Format check first: a formatting diff is cheap to report and would otherwise be buried under build output.
  // `--verify-no-changes` exits non-zero when anything would change.
  const format = run(
    ['dotnet', 'format', '--verify-no-changes', '--no-restore', '--verbosity', 'quiet'],
    cwd,
  );
  if (format.status === 0) {
    process.stdout.write(`✓ ${label}: dotnet format\n`);
  } else {
    failed += 1;
    process.stderr.write(
      `✗ ${label}: dotnet format\n${(format.stdout ?? '') + (format.stderr ?? '')}\n` +
        `  Fix with: devbox run -- sh -c "cd ${dir} && dotnet format"\n`,
    );
  }

  // One step, because a build failure makes the test run meaningless anyway. Warnings are errors here.
  // `test` where there are tests, `build` otherwise — `dotnet test` on a project with none exits non-zero, which
  // would report a missing test project as a broken build.
  const hasTests = existsSync(join(cwd, 'tests'));
  const goal = hasTests ? 'test' : 'build';
  const test = run(['dotnet', goal, '--nologo', '--verbosity', 'quiet'], cwd);
  if (test.status === 0) {
    process.stdout.write(`✓ ${label}: dotnet ${goal} (nullable, warnings as errors)\n`);
  } else {
    failed += 1;
    process.stderr.write(`✗ ${label}: dotnet ${goal}\n${(test.stdout ?? '') + (test.stderr ?? '')}\n`);
  }
}

process.exitCode = failed === 0 ? 0 : 1;
