/**
 * Run the PHP packages' own gates: PHPStan, php-cs-fixer, and PHPUnit.
 *
 * A script rather than pnpm workspace entries for the same reason as Go and Python: these are Composer
 * packages, pnpm has no view into them, and a `package.json` in a directory containing no JavaScript
 * would be a lie.
 *
 * **Skips rather than fails when PHP or the vendored tools are absent.** A contributor working only on
 * the TypeScript target should not need a PHP toolchain to run `pnpm verify`. CI installs it, so the
 * suite is enforced where enforcement matters. The skip is loud, and it names the command that fixes it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Packages with a Composer manifest and gates to run. */
const PACKAGES = ['packages/runtime-php', 'packages/target-php'];

function findPhp() {
  const which = spawnSync('sh', ['-c', 'command -v php'], { encoding: 'utf8' });
  const found = which.stdout.trim();
  if (found !== '') return found;
  for (const candidate of ['/opt/homebrew/bin/php', '/usr/local/bin/php', '/usr/bin/php']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const php = findPhp();
if (php === undefined) {
  process.stderr.write(
    'PHP not found; skipping the PHP suites.\n' +
      '  Install PHP 8.4 or later (`brew install php`) to run them.\n',
  );
  process.exit(0);
}

const missing = PACKAGES.filter((pkg) => !existsSync(join(ROOT, pkg, 'vendor/autoload.php')));
if (missing.length > 0) {
  process.stderr.write(
    `Composer dependencies not installed; skipping the PHP suites.\n` +
      missing.map((pkg) => `  cd ${pkg} && composer install\n`).join(''),
  );
  process.exit(0);
}

/**
 * Each gate, in the order that makes its output useful.
 *
 * `php -l` is not listed: PHPStan parses every file anyway and reports a syntax error more precisely
 * than the linter does. It stays in the *generated* SDK's gates, where a syntax error means the emitter
 * is broken and the message should be as blunt as possible.
 *
 * php-cs-fixer runs in `--dry-run` here. In this repository the runtime is hand-written and drift is a
 * failure; when generating, the same tool runs as a `fix` gate because a formatter's exit code is not a
 * verdict on the output (SPEC.md §3.5).
 */
const steps = [
  ['phpstan (level 9)', ['vendor/bin/phpstan', 'analyse', '--no-progress', '--no-interaction']],
  ['php-cs-fixer', ['vendor/bin/php-cs-fixer', 'fix', '--dry-run', '--using-cache=no', '--no-interaction']],
  ['phpunit', ['vendor/bin/phpunit', '--no-progress']],
];

let failed = 0;
for (const pkg of PACKAGES) {
  const label = pkg.replace('packages/', '');
  for (const [name, argv] of steps) {
    const result = spawnSync(php, argv, {
      cwd: join(ROOT, pkg),
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (result.status === 0) {
      process.stdout.write(`✓ ${label}: ${name}\n`);
      continue;
    }
    failed += 1;
    process.stderr.write(`✗ ${label}: ${name}\n${(result.stdout || '') + (result.stderr || '')}\n`);
  }
}

process.exitCode = failed === 0 ? 0 : 1;
