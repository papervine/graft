/**
 * How a target executable is located. One implementation, used by every command that needs one.
 *
 * It was two. `generate` honoured `targets.<name>.command`, an installed `@besdk/target-<name>`
 * package, then `PATH`; `targets` read only the config *keys* and went straight to `PATH`. So the
 * command whose entire job is reporting which targets are usable reported the configured Python and Go
 * targets as "not installed" while `generate` ran them without complaint — wrong about two thirds of the
 * project, and the first thing anyone evaluating besdk would run.
 *
 * The general lesson is already recorded in SPEC.md and this is another instance of it: two
 * implementations of one decision will disagree, and the one nobody exercises is the one that is wrong.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRAND, TARGET_EXECUTABLE_PREFIX } from '@besdk/protocol';

/** Where a target executable came from, for reporting. */
export type TargetOrigin = 'config' | 'in-tree' | 'PATH';

export interface ResolvedTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly origin: TargetOrigin;
}

/**
 * Locate the target named `name`.
 *
 * Resolution order, and each step earns its place:
 *
 * 1. **`targets.<name>.command`** — the only way to reach a target that is neither an npm package nor
 *    on `PATH`, which is the normal situation for a target written in another language during
 *    development. An argv array, so no shell is involved and a path containing a space needs no quoting.
 * 2. **An installed `@besdk/target-<name>` package** — so a checkout works with no global install.
 * 3. **`besdk-target-<name>` on `PATH`** — how every third-party target joins.
 *
 * Never fails: a name that resolves nowhere still returns a `PATH` candidate, so the caller reports a
 * missing executable rather than an absent resolution.
 */
export function resolveTarget(
  name: string,
  configuredCommand: readonly string[] | undefined,
): ResolvedTarget {
  if (configuredCommand !== undefined && configuredCommand.length > 0) {
    const [command, ...args] = configuredCommand;
    return { command: command!, args, origin: 'config' };
  }

  const require = createRequire(import.meta.url);
  try {
    const manifestPath = require.resolve(`@besdk/target-${name}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      bin?: Record<string, string>;
    };
    const bin = Object.values(manifest.bin ?? {})[0];
    if (bin !== undefined) {
      return {
        command: process.execPath,
        args: [join(dirname(manifestPath), bin)],
        origin: 'in-tree',
      };
    }
  } catch {
    // Not installed; fall through.
  }

  return { command: `${TARGET_EXECUTABLE_PREFIX}${name}`, args: [], origin: 'PATH' };
}

/** How the resolution order reads in help text and diagnostics, so it is stated in exactly one place. */
export const RESOLUTION_ORDER = `targets.<name>.command, then an installed @${BRAND.name}/target-<name> package, then PATH`;
