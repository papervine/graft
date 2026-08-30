/**
 * Run the Java packages' own gates: google-java-format, then Maven (compile with `-Werror`, then test).
 *
 * A script rather than pnpm workspace entries for the same reason as Go, Python, and PHP: these are Maven
 * projects, pnpm has no view into them, and a `package.json` in a directory containing no JavaScript would
 * be a lie.
 *
 * **Runs through `devbox` when it is available**, because that is where the JDK, Maven, and
 * google-java-format come from (`AGENTS.md`). Falling back to whatever is on `PATH` keeps the suite usable
 * for someone who installed them another way, and skipping loudly is the last resort — a contributor working
 * only on the TypeScript target should not need a JVM to run `pnpm verify`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Packages with a `pom.xml` and gates to run. */
// Order matters: the target depends on the runtime's JSON parser, so the runtime installs to the local
// Maven repository first. `install` rather than `test` for the runtime alone would skip its tests, so both
// run and the install is a separate step below.
const PACKAGES = ['packages/runtime-java', 'packages/target-java'];

/**
 * How to run a command: through devbox when the project declares it, directly otherwise.
 *
 * devbox pins the JDK version, which matters here — this target requires **21**, because pattern matching in
 * `switch` is only final there and that is what makes the sealed `Schema` type exhaustiveness-checked
 * (SPEC.md §3.3.9). A system JDK 17 would fail to compile the validator, and the error would look like a
 * code problem rather than a toolchain one.
 */
function runner() {
  const hasDevbox =
    spawnSync('sh', ['-c', 'command -v devbox'], { encoding: 'utf8' }).stdout.trim() !== '' &&
    existsSync(join(ROOT, 'devbox.json'));
  if (hasDevbox) {
    // `devbox run` executes at the project root regardless of the spawn cwd, so the directory change has to
    // be inside the command. Discovered the hard way: Maven reported "no POM in this directory" while
    // pointing at the repository root.
    return (argv, cwd) =>
      spawnSync(
        'devbox',
        ['run', '--', 'sh', '-c', `cd ${JSON.stringify(cwd)} && ${argv.map((a) => JSON.stringify(a)).join(' ')}`],
        { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' },
      );
  }
  return (argv, cwd) =>
    spawnSync(argv[0], argv.slice(1), { cwd, stdio: 'pipe', encoding: 'utf8' });
}

const run = runner();

function available(command) {
  const probe = run([command, '--version'], ROOT);
  return probe.status === 0 || (probe.stdout ?? '').trim() !== '';
}

if (!available('javac')) {
  process.stderr.write(
    'No JDK found; skipping the Java suites.\n' +
      '  `devbox install` provides JDK 21, Maven, and google-java-format.\n',
  );
  process.exit(0);
}

/** Every `.java` file in a package, so the formatter check names the file rather than a directory. */
function javaFiles(pkg) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.java')) {
        out.push(full);
      }
    }
  };
  const src = join(ROOT, pkg, 'src');
  if (existsSync(src)) {
    walk(src);
  }
  return out;
}

// The target compiles against the runtime, so the runtime lands in the local Maven repository first. Its own
// tests still run below; this step exists only to make the artifact resolvable.
const install = run(['mvn', '--batch-mode', '--quiet', 'install', '-DskipTests'], join(ROOT, 'packages/runtime-java'));
if (install.status !== 0) {
  process.stderr.write(
    `✗ runtime-java: could not install to the local Maven repository\n${(install.stdout ?? '') + (install.stderr ?? '')}\n`,
  );
  process.exit(1);
}

let failed = 0;

for (const pkg of PACKAGES) {
  const label = pkg.replace('packages/', '');
  const cwd = join(ROOT, pkg);

  // Format check first: a formatting diff is cheap to report and would otherwise be buried under compiler
  // output. `--dry-run` lists files that differ; empty output means clean.
  const files = javaFiles(pkg);
  if (files.length > 0) {
    const format = run(['google-java-format', '--dry-run', ...files], cwd);
    const drifted = (format.stdout ?? '').trim();
    if (format.status !== 0 && drifted === '') {
      // The tool itself is missing or broke. Reported rather than silently passing: a gate that cannot run
      // is a gate that is not enforced (SPEC.md §3.4).
      process.stderr.write(
        `✗ ${label}: google-java-format could not run\n${format.stderr ?? ''}\n` +
          '  Install it with `devbox install`, or run with --skip-format.\n',
      );
      failed += 1;
    } else if (drifted !== '') {
      process.stderr.write(
        `✗ ${label}: google-java-format drift\n${drifted}\n` +
          `  Fix with: devbox run -- sh -c "find ${pkg}/src -name '*.java' -print0 | xargs -0 google-java-format -i"\n`,
      );
      failed += 1;
    } else {
      process.stdout.write(`✓ ${label}: google-java-format\n`);
    }
  }

  // `mvn test` compiles with `-Xlint:all -Werror` (configured in the pom) and then runs JUnit. One step,
  // because a compile failure makes the test run meaningless anyway.
  // `package` for the target, because `corpus/kitchen-sink/graft.yaml` points at the built jar and a stale one
  // would silently generate from yesterday's emitter — the same trap the Go suite documents.
  const goal = pkg.endsWith('target-java') ? 'package' : 'test';
  const maven = run(['mvn', '--batch-mode', '--quiet', goal], cwd);
  if (maven.status === 0) {
    process.stdout.write(`✓ ${label}: mvn ${goal} (-Xlint:all -Werror)\n`);
  } else {
    failed += 1;
    process.stderr.write(
      `✗ ${label}: mvn ${goal}\n${(maven.stdout ?? '') + (maven.stderr ?? '')}\n`,
    );
  }
}

process.exitCode = failed === 0 ? 0 : 1;
