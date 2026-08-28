/**
 * Orphan removal (SPEC.md §3.9).
 *
 * These pin the *safety* properties rather than the happy path, because the failure modes are asymmetric:
 * leaving an orphan wastes a build, and deleting the wrong file destroys work. Every assertion below is a
 * thing that must never happen, not a convenience.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeOrphans } from './written.js';

const created: string[] = [];

function sandbox(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'besdk-written-'));
  created.push(dir);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('removeOrphans', () => {
  it('removes a file besdk wrote last time and is not writing now', () => {
    // The reported bug: an `examples/pagination.ts` from an earlier run, importing a client name a later
    // run did not produce, failing the typecheck gate on every subsequent generation.
    const dir = sandbox({ 'examples/pagination.ts': 'stale', 'src/client.ts': 'fresh' });
    return removeOrphans(dir, new Set(['examples/pagination.ts', 'src/client.ts']), new Set(['src/client.ts'])).then(
      (removed) => {
        expect(removed).toEqual(['examples/pagination.ts']);
        expect(existsSync(join(dir, 'examples/pagination.ts'))).toBe(false);
        expect(existsSync(join(dir, 'src/client.ts'))).toBe(true);
      },
    );
  });

  it('never touches a file besdk did not write', async () => {
    // The whole reason a record exists rather than clearing the directory. A default that behaved like
    // `--clean` would take a `.git`, a `node_modules`, or anything the user added.
    const dir = sandbox({ 'NOTES.md': 'mine', 'src/client.ts': 'generated' });
    const removed = await removeOrphans(dir, new Set(['src/client.ts']), new Set(['src/client.ts']));
    expect(removed).toEqual([]);
    expect(existsSync(join(dir, 'NOTES.md'))).toBe(true);
  });

  it('never removes a preserved file, even one it wrote before it was preserved', async () => {
    // A file besdk generated in an earlier run and the user has since claimed via `preserve.files` is in
    // the previous record *and* must survive. Preservation wins.
    const dir = sandbox({ 'README.md': 'edited by hand' });
    const removed = await removeOrphans(dir, new Set(['README.md']), new Set(['README.md']));
    expect(removed).toEqual([]);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
  });

  it('refuses a path that escapes the output directory', async () => {
    // The record is a file on disk and could be edited. Treating it as authority over arbitrary paths
    // would turn a text edit into a delete-anything primitive.
    const outer = sandbox({ 'victim.txt': 'do not delete', 'out/src/client.ts': 'x' });
    const outDir = join(outer, 'out');
    const removed = await removeOrphans(outDir, new Set(['../victim.txt']), new Set());
    expect(removed).toEqual([]);
    expect(existsSync(join(outer, 'victim.txt'))).toBe(true);
  });

  it('cannot reach a sibling output directory', async () => {
    // The scenario worth proving impossible: several SDKs generated side by side under one `sdks/`, and a
    // run for one of them removing another's output. A record naming a sibling is refused rather than
    // followed, so a stale or hand-edited record cannot cascade across directories.
    const root = sandbox({
      'sdks/typescript/src/client.ts': 'a',
      'sdks/python/src/client.py': 'b',
      'sdks/go/client.go': 'c',
    });
    const outDir = join(root, 'sdks/typescript');
    const removed = await removeOrphans(
      outDir,
      new Set(['src/client.ts', '../python/src/client.py', '../go/client.go']),
      new Set(),
    );
    expect(removed).toEqual(['src/client.ts']);
    expect(existsSync(join(root, 'sdks/python/src/client.py'))).toBe(true);
    expect(existsSync(join(root, 'sdks/go/client.go'))).toBe(true);
  });

  it('does not follow an absolute path in the record', async () => {
    const root = sandbox({ 'victim.txt': 'x', 'out/src/client.ts': 'y' });
    const outDir = join(root, 'out');
    const removed = await removeOrphans(outDir, new Set([join(root, 'victim.txt')]), new Set());
    expect(removed).toEqual([]);
    expect(existsSync(join(root, 'victim.txt'))).toBe(true);
  });

  it('tolerates a recorded file that is already gone', async () => {
    const dir = sandbox({});
    const removed = await removeOrphans(dir, new Set(['examples/gone.ts']), new Set());
    expect(removed).toEqual([]);
  });

  it('prunes a directory it emptied, but not one still holding something', async () => {
    const dir = sandbox({
      'examples/operations/old.ts': 'stale',
      'tests/operations/old.test.ts': 'stale',
      'tests/mine.test.ts': 'hand-written, never recorded',
    });
    await removeOrphans(
      dir,
      new Set(['examples/operations/old.ts', 'tests/operations/old.test.ts']),
      new Set(),
    );
    // Emptied entirely, so both it and its now-empty parent go.
    expect(existsSync(join(dir, 'examples/operations'))).toBe(false);
    expect(existsSync(join(dir, 'examples'))).toBe(false);
    // `tests/` still holds a file besdk never wrote, so it survives even though `tests/operations` went.
    expect(existsSync(join(dir, 'tests/operations'))).toBe(false);
    expect(existsSync(join(dir, 'tests/mine.test.ts'))).toBe(true);
  });
});
