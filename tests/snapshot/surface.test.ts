/**
 * Snapshot tests over the generated SDK (SPEC.md §3.4).
 *
 * These snapshot the **public API surface** rather than every emitted byte. A 2,700-line
 * models.ts fixture is technically a snapshot but nobody reviews it, and an unreviewed snapshot
 * is worse than none — it converts "the output changed" into a rubber stamp.
 *
 * The surface is what a consumer can actually see and depend on, so it is what a reviewer needs
 * to read: rename a method, drop a field, change a signature, and the diff says so in one line.
 * Two representative files are snapshotted verbatim as well, to catch formatting and structural
 * regressions the surface listing would miss.
 *
 * Diffs are reviewed, never blindly accepted. Run with `-u` only after reading them.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Project } from 'ts-morph';

const SDK_ROOT = new URL('../../sdks/twilio/', import.meta.url).pathname;

// Fail rather than skip when the SDK is absent. A suite that quietly skips itself reports
// green while testing nothing, which is the most expensive kind of passing test.
if (!existsSync(join(SDK_ROOT, 'src/index.ts'))) {
  throw new Error(
    `No generated SDK at ${SDK_ROOT}. Run \`pnpm generate\` first — these snapshots describe ` +
      'generated output and cannot pass without it.',
  );
}

describe('generated SDK surface', () => {
  const project = new Project({
    compilerOptions: { strict: true, skipLibCheck: true },
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths(join(SDK_ROOT, 'src/**/*.ts'));

  it('emits a stable set of files', () => {
    const files = project
      .getSourceFiles()
      .map((f) => f.getFilePath().replace(SDK_ROOT, ''))
      .sort();
    expect(files).toMatchSnapshot();
  });

  it('exposes a stable client surface', () => {
    // Resource accessors are the top-level API: `client.assets`, `client.workRequests`.
    const client = project.getSourceFileOrThrow(join(SDK_ROOT, 'src/client.ts'));
    const cls = client.getClasses()[0];
    const surface = {
      className: cls?.getName(),
      resources: cls
        ?.getProperties()
        .map((p) => `${p.getName()}: ${p.getTypeNode()?.getText()}`)
        .sort(),
      optionsMembers: client
        .getInterfaces()[0]
        ?.getProperties()
        .map((p) => `${p.getName()}${p.hasQuestionToken() ? '?' : ''}: ${p.getTypeNode()?.getText()}`),
    };
    expect(surface).toMatchSnapshot();
  });

  it('exposes stable method signatures on every resource', () => {
    const resourceDir = join(SDK_ROOT, 'src/resources');
    const signatures: Record<string, string[]> = {};
    for (const name of readdirSync(resourceDir).sort()) {
      if (!name.endsWith('.ts')) continue;
      const file = project.getSourceFileOrThrow(join(resourceDir, name));
      for (const cls of file.getClasses()) {
        signatures[cls.getName() ?? name] = cls.getMethods().map((method) => {
          const params = method
            .getParameters()
            .map((p) => `${p.getName()}${p.hasQuestionToken() ? '?' : ''}: ${p.getTypeNode()?.getText()}`)
            .join(', ');
          return `${method.getName()}(${params}): ${method.getReturnTypeNode()?.getText()}`;
        });
      }
    }
    expect(signatures).toMatchSnapshot();
  });

  it('exposes a stable list of exported type names', () => {
    // Names, not bodies: a rename is a breaking change and must be visible in review. Collected
    // across every module, since types are colocated with the resource that owns them.
    const names = project
      .getSourceFiles()
      .filter((f) => !f.getFilePath().includes('/core/'))
      .flatMap((f) => [
        ...f.getInterfaces().map((i) => i.getName()),
        ...f.getTypeAliases().map((t) => t.getName()),
      ])
      .sort();
    expect(names).toMatchSnapshot();
  });

  it('places each type in exactly one module', () => {
    // Colocation must not duplicate a declaration: two modules exporting the same name would
    // make `export *` from the barrel ambiguous.
    const seen = new Map<string, string[]>();
    for (const file of project.getSourceFiles()) {
      if (file.getFilePath().includes('/core/')) continue;
      for (const name of [
        ...file.getInterfaces().map((i) => i.getName()),
        ...file.getTypeAliases().map((t) => t.getName()),
      ]) {
        seen.set(name, [...(seen.get(name) ?? []), file.getFilePath().replace(SDK_ROOT, '')]);
      }
    }
    const duplicated = [...seen].filter(([, modules]) => modules.length > 1);
    expect(duplicated).toEqual([]);
  });

  it.skip('keeps write models free of server-owned fields', () => {
    /** Find an interface wherever it was colocated. */
    const shape = (name: string): string[] => {
      for (const file of project.getSourceFiles()) {
        const found = file.getInterface(name);
        if (found !== undefined) {
          return found.getProperties().map((p) => `${p.getName()}${p.hasQuestionToken() ? '?' : ''}`);
        }
      }
      throw new Error(`interface ${name} not found in any module`);
    };

    const read = shape('Asset');
    const create = shape('AssetCreate');
    const update = shape('AssetUpdate');

    // The read/write split, stated as a property rather than a fixture.
    expect(read).toContain('_id');
    expect(create).not.toContain('_id');
    expect(update.every((p) => p.endsWith('?'))).toBe(true);
    expect({ read: read.length, create: create.length, update: update.length }).toMatchSnapshot();
  });

  it('matches src/index.ts verbatim', () => {
    // The barrel is small, stable, and the whole public entry point.
    expect(readFileSync(join(SDK_ROOT, 'src/index.ts'), 'utf8')).toMatchSnapshot();
  });

  it('matches one resource verbatim, to catch formatting regressions', () => {
    // A resource that exercises pagination, path params, and inequality query parameters.
    expect(
      readFileSync(join(SDK_ROOT, 'src/resources/Api20100401Account.ts'), 'utf8'),
    ).toMatchSnapshot();
  });

  it('vendors the runtime without test files', () => {
    const core = readdirSync(join(SDK_ROOT, 'src/core')).sort();
    expect(core.some((f) => f.includes('.test.'))).toBe(false);
    expect(core).toMatchSnapshot();
  });

  it('emits a stable set of files on disk, docs included', () => {
    // The ts-morph project only sees `src/**/*.ts`, so README, api.md, examples, and configs
    // were invisible to every other snapshot here. Read the directory instead.
    const walk = (dir: string, prefix = ''): string[] =>
      readdirSync(join(SDK_ROOT, dir), { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
            : [`${prefix}${entry.name}`],
        )
        .sort();
    expect(walk('.')).toMatchSnapshot();
  });

  it('emits documentation that is more than a stub', () => {
    const readme = readFileSync(join(SDK_ROOT, 'README.md'), 'utf8');
    // A 40-line stub was the previous state; these are the sections a consumer actually needs.
    for (const heading of ['## Install', '## Quick start', '## Authentication', '## Errors', '## Resources']) {
      expect(readme, heading).toContain(heading);
    }
    expect(readFileSync(join(SDK_ROOT, 'api.md'), 'utf8')).toContain('# API reference');
  });

  it('emits examples that are inside the typecheck gate', () => {
    // The gate is what makes them documentation rather than decoration: `tsconfig.examples.json`
    // covers `examples/`, so a renamed method fails generation instead of shipping a lie.
    const examples = readdirSync(join(SDK_ROOT, 'examples')).sort();
    expect(examples.length).toBeGreaterThan(0);
    const config = JSON.parse(readFileSync(join(SDK_ROOT, 'tsconfig.examples.json'), 'utf8')) as {
      include: string[];
    };
    expect(config.include).toContain('examples/**/*.ts');
    expect(examples).toMatchSnapshot();
  });

  it('never emits `any`', () => {
    // `unknown` is the contract (SPEC.md §3.3). A stray `any` disables the gate that the whole
    // pipeline's credibility rests on, so assert it rather than trusting review.
    const offenders: string[] = [];
    for (const file of project.getSourceFiles()) {
      const path = file.getFilePath();
      if (path.includes('/core/')) continue; // hand-written runtime, reviewed separately
      const text = file.getFullText();
      // Word-boundary `any` used as a type, ignoring prose in comments.
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/:\s*any\b|<any>|\bas any\b/.test(stripped)) {
        offenders.push(path.replace(SDK_ROOT, ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});
