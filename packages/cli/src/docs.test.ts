/**
 * Documentation drift guard.
 *
 * `AGENTS.md` requires that any user-visible change land in `./docs` in the same turn it lands in
 * `SPEC.md`. A rule enforced only by discipline decays, so this enforces it: if a CLI command, a
 * `graft.yaml` key, an extension key, or a diagnostic code exists in code but appears nowhere in
 * `./docs`, the build fails.
 *
 * Deliberately checks *presence*, not prose quality. A test cannot tell whether documentation is
 * good — but it can tell when a flag was added and never written down, which is the failure that
 * actually happens.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND, DIAGNOSTIC_CODES, extensionKey } from '@graft/protocol';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const DOCS_ROOT = join(REPO_ROOT, 'docs');

/** All documentation text concatenated, for presence checks. */
function docsText(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
        parts.push(readFileSync(full, 'utf8'));
      }
    }
  };
  walk(DOCS_ROOT);
  return parts.join('\n');
}

const DOCS = docsText();

describe('CLI surface is documented', () => {
  /** Commands the binary dispatches on, read from its own switch statement. */
  const commands = (() => {
    const bin = readFileSync(join(REPO_ROOT, 'packages/cli/src/bin.ts'), 'utf8');
    return [...bin.matchAll(/^\s*case '([a-z-]+)':/gm)].map((m) => m[1]!);
  })();

  it('finds at least the commands we expect', () => {
    // Guards the extraction itself: a refactor that broke the regex would otherwise make every
    // check below vacuously pass.
    expect(commands).toEqual(expect.arrayContaining(['check', 'init', 'generate', 'diff', 'ir']));
  });

  it.each(commands.map((c) => [c]))('documents `%s`', (command) => {
    expect(DOCS).toContain(`${BRAND.name} ${command}`);
  });

  it('documents every flag the CLI parses', () => {
    // Long flags mentioned in usage strings and help text across the CLI.
    const sources = ['bin.ts', 'commands/check.ts', 'commands/init.ts', 'commands/generate.ts', 'commands/diff.ts', 'commands/ir.ts'];
    const flags = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(join(REPO_ROOT, 'packages/cli/src', file), 'utf8');
      for (const match of text.matchAll(/--([a-z][a-z-]{2,})/g)) flags.add(match[1]!);
    }
    // Not user-facing CLI flags: the handshake flag, and arguments graft passes to the external
    // tools it spawns (Prettier, tsc).
    for (const internal of [`${BRAND.name}-protocol`, 'log-level', 'write', 'noEmit']) {
      flags.delete(internal);
    }

    const undocumented = [...flags].filter((flag) => !DOCS.includes(`--${flag}`)).sort();
    expect(undocumented).toEqual([]);
  });
});

describe('diagnostics are documented', () => {
  const codes = Object.values(DIAGNOSTIC_CODES);

  it('has codes to check', () => {
    expect(codes.length).toBeGreaterThan(10);
  });

  it.each(codes.map((c) => [c]))('documents `%s`', (code) => {
    // Codes are a public contract: users grep them in CI logs, so each needs an entry explaining
    // what it means and how to resolve it.
    expect(DOCS).toContain(code);
  });
});

describe('extensions are documented', () => {
  const suffixes = ['group', 'method', 'ignore', 'pagination', 'name', 'server-owned', 'client-name'];

  it.each(suffixes.map((s) => [s]))('documents `x-…-%s`', (suffix) => {
    expect(DOCS).toContain(extensionKey(suffix));
  });

  it('documents the vendor extensions graft reads', () => {
    const extensions = readFileSync(join(REPO_ROOT, 'packages/core/src/extensions.ts'), 'utf8');
    // Vendor keys are literals in the tier tables, so they can be extracted directly.
    const vendorKeys = new Set(
      [...extensions.matchAll(/'(x-(?:fern|speakeasy|internal)[a-z-]*)'/g)].map((m) => m[1]!),
    );
    expect(vendorKeys.size).toBeGreaterThan(4);
    const undocumented = [...vendorKeys].filter((key) => !DOCS.includes(key)).sort();
    expect(undocumented).toEqual([]);
  });
});

describe('graft.yaml keys are documented', () => {
  /**
   * Every key a user can type, at any depth and in any schema in the file.
   *
   * Scoped to `ConfigSchema`'s own body at four-space indentation once, which meant it saw only
   * top-level keys — and not even all of those, since the per-target schema is declared *above*
   * `ConfigSchema` and so fell outside the slice entirely. `targets.<name>.idempotencyHeader` was
   * added and shipped undocumented with the guard green. A drift guard that covers one nesting level
   * of the thing it guards is worse than none, because it is trusted.
   *
   * The pattern is a key followed by a zod expression, which is what distinguishes a schema field
   * from an object literal in the parsing helpers further down the file. Whitespace after `z` is
   * significant to match: a field whose chain is long enough for prettier to break the line —
   * `envPrefix: z\n  .string()\n  .regex(…)` — put `z` and `.string()` on separate lines, and the
   * first version of this pattern required them adjacent. It shipped `envPrefix` undocumented while
   * green, which is the same failure this guard's own docstring describes one paragraph above. A
   * pattern matching source has to tolerate however the formatter chose to lay that source out.
   */
  it('documents every config key, at every depth', () => {
    const config = readFileSync(join(REPO_ROOT, 'packages/core/src/config.ts'), 'utf8');
    const code = config.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const keys = new Set(
      [...code.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:\s*z\s*\./gm)].map((m) => m[1]!),
    );
    // Well above the 14 the old bound-to-ConfigSchema scan found, so a regression to that scope
    // fails here rather than silently narrowing coverage again.
    expect(keys.size).toBeGreaterThan(25);
    const undocumented = [...keys].filter((key) => !DOCS.includes(key)).sort();
    expect(undocumented).toEqual([]);
  });
});

describe('navigation is complete', () => {
  it('lists every page, and every listed page exists', () => {
    const config = JSON.parse(readFileSync(join(DOCS_ROOT, 'docs.json'), 'utf8')) as {
      navigation: { tabs: Array<{ groups: Array<{ pages: string[] }> }> };
    };
    const listed = new Set(
      config.navigation.tabs.flatMap((tab) => tab.groups.flatMap((group) => group.pages)),
    );

    const onDisk = new Set<string>();
    const walk = (dir: string, prefix = ''): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
        else if (entry.endsWith('.mdx')) onDisk.add(`${prefix}${entry.replace(/\.mdx$/, '')}`);
      }
    };
    walk(DOCS_ROOT);

    // A page nobody can navigate to is invisible; a nav entry with no page is a 404.
    expect([...onDisk].filter((p) => !listed.has(p)).sort()).toEqual([]);
    expect([...listed].filter((p) => !onDisk.has(p)).sort()).toEqual([]);
  });
});
