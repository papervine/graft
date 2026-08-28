/**
 * A record of what besdk last wrote to an output directory, so the next run can remove what it no
 * longer generates.
 *
 * Without this, generated output only ever grows. Rename an operation and the previous run's
 * `examples/operations/widgets-fetch.ts` stays on disk forever, referencing a method that no longer
 * exists — and because examples and tests are inside the typecheck gate, the orphan does not merely
 * linger, it **fails the next generation** for a reason the user did not cause. That was reported as
 * exactly this: an `examples/pagination.ts` left by an earlier run importing a client name a later run
 * did not produce.
 *
 * The problem predates per-operation files, but was survivable while every emitted path was derived from
 * a resource name: a stale resource module still compiled. Paths derived from *operation* names change
 * whenever a spec does, so orphans became routine.
 *
 * **Only files besdk itself wrote are removed.** That is the entire reason a manifest exists rather than
 * simply clearing the directory: `--clean` can delete anything, and a default that behaved like `--clean`
 * would delete a `.git`, a `node_modules`, or a file the user added and never marked preserved. Deleting
 * something a generator did not create is unforgivable in a way that leaving a stale file is not.
 *
 * Stored in the state directory rather than inside the output, because a manifest inside the generated
 * package would be published to npm along with it.
 */

import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { BRAND } from '@besdk/protocol';

interface WrittenManifest {
  /** Relative POSIX paths, sorted, as of the last successful generation. */
  readonly files: readonly string[];
}

/**
 * Where the record for one output directory lives.
 *
 * Keyed by the output path rather than by the spec, because the record describes *a directory*: "these are
 * the files besdk last put here". Keying by spec would mean two specs writing to one directory each kept a
 * partial record and neither could tell an orphan from the other's output.
 *
 * Two specs sharing one output directory still conflict — each run would remove the other's files — but
 * that is a configuration error no keying resolves, and the honest behaviour for "this directory is
 * generated from this spec" is the one that treats the directory as owned.
 */
export function writtenManifestPath(outDir: string): string {
  const slug =
    outDir
      .replace(/^\.\//, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'out';
  return join(BRAND.stateDir, `${slug}.written.json`);
}

/** Paths besdk wrote to this directory last time, or an empty set when there is no record. */
export async function readWritten(outDir: string): Promise<Set<string>> {
  const path = writtenManifestPath(outDir);
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as WrittenManifest;
    return new Set(Array.isArray(parsed.files) ? parsed.files.filter((p) => typeof p === 'string') : []);
  } catch {
    // A corrupt record means "we do not know what we wrote", and the safe reading of that is *nothing* —
    // deleting on a guess is the one outcome worse than an orphan.
    return new Set();
  }
}

export async function writeWritten(outDir: string, files: readonly string[]): Promise<void> {
  const path = writtenManifestPath(outDir);
  await mkdir(dirname(path), { recursive: true });
  const manifest: WrittenManifest = { files: [...files].sort() };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Remove files besdk wrote last time and is not writing now.
 *
 * `keep` covers everything this run produced plus everything preservation is holding back, so a preserved
 * file is never a deletion candidate however it came to be preserved.
 *
 * Returns the paths removed, for reporting — a silent deletion is indistinguishable from a bug, and the
 * user needs to be able to see that a rename cost them a file.
 */
export async function removeOrphans(
  outDir: string,
  previous: ReadonlySet<string>,
  keep: ReadonlySet<string>,
): Promise<string[]> {
  const removed: string[] = [];
  for (const path of [...previous].sort()) {
    if (keep.has(path)) continue;
    const absolute = join(outDir, path);
    // A path that escapes the output directory is not ours to touch, whatever the record says. A manifest
    // is a file on disk and could have been edited; treating it as authority over arbitrary paths would
    // turn a text edit into a delete-anything primitive.
    const rel = relative(outDir, absolute);
    if (rel.startsWith('..') || rel.startsWith(sep)) continue;
    if (!existsSync(absolute)) continue;
    await rm(absolute, { force: true });
    removed.push(path);
  }
  await pruneEmptyDirectories(outDir, removed);
  return removed;
}

/**
 * Remove directories emptied by the deletions above.
 *
 * An empty `examples/operations/` left behind is harmless but reads as a bug, and a directory nobody
 * writes to accumulates across renames. Only directories that held a removed file are considered, and
 * `rmdir` fails harmlessly on a non-empty one — so a directory containing anything at all, preserved or
 * user-added, survives without needing a separate check.
 */
async function pruneEmptyDirectories(outDir: string, removed: readonly string[]): Promise<void> {
  const directories = new Set<string>();
  for (const path of removed) {
    let current = dirname(path);
    while (current !== '.' && current !== '' && current !== sep) {
      directories.add(current);
      current = dirname(current);
    }
  }
  // Deepest first, so a parent emptied only by its children being pruned is itself prunable.
  for (const dir of [...directories].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(join(outDir, dir));
    } catch {
      // Not empty, or gone already. Both fine.
    }
  }
}
