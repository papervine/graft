#!/usr/bin/env node
/**
 * Fetch large public OpenAPI documents into `corpus/vendor/`, which is gitignored.
 *
 * Committing every corpus entry would put tens of megabytes of third-party YAML in the repository.
 * Committing none would make the test suite depend on the network. So the split is by size: one
 * real spec is vendored and committed (`corpus/twilio`) to keep the default suite hermetic, and the
 * giants are fetched on demand.
 *
 * **Every entry is pinned to a commit SHA, never a branch.** A snapshot diff must be attributable
 * to a besdk change; if upstream could move under us, a diff would be ambiguous and the snapshots
 * would be worthless as a regression signal.
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const VENDOR = join(ROOT, 'corpus/vendor');

/**
 * Specs fetched on demand.
 *
 * `licence` is recorded because these are redistributed into a developer's working tree; anything
 * that cannot be attributed does not belong here.
 */
const SPECS = [
  {
    name: 'stripe',
    description: 'Stripe API — the canonical pathological spec',
    repo: 'stripe/openapi',
    path: 'openapi/spec3.yaml',
    sha: 'af5309cae53e5f666f9686dfed306d6d3b5fdc67',
    licence: 'MIT — Copyright (c) 2011- Stripe, Inc.',
    out: 'stripe/spec.yaml',
  },
  {
    name: 'github',
    description: 'GitHub REST API — very large, heavy on unions',
    repo: 'github/rest-api-description',
    path: 'descriptions/api.github.com/api.github.com.yaml',
    sha: '66c7249d69f9aa013abda010658d15eefbacd0a3',
    licence: 'MIT — see github/rest-api-description',
    out: 'github/spec.yaml',
  },
  {
    name: 'box',
    description: 'Box API — JSON rather than YAML, deep nesting',
    repo: 'box/box-openapi',
    path: 'openapi.json',
    sha: 'ab2802e50f99dd85e7f71253f465d3c47343fbc7',
    licence: 'Apache-2.0 — Box, Inc.',
    out: 'box/spec.json',
  },
];

function rawUrl(spec) {
  return `https://raw.githubusercontent.com/${spec.repo}/${spec.sha}/${spec.path}`;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchSpec(spec, { force }) {
  const destination = join(VENDOR, spec.out);
  if (!force && (await exists(destination))) {
    console.log(`  · ${spec.name} already present`);
    return { ...spec, skipped: true };
  }

  const url = rawUrl(spec);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${spec.name}: ${response.status} ${response.statusText}\n  ${url}`);
  }
  const body = await response.text();
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body, 'utf8');

  const megabytes = (body.length / 1_000_000).toFixed(1);
  console.log(`  ✓ ${spec.name} — ${megabytes} MB`);
  return { ...spec, bytes: body.length };
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((arg) => !arg.startsWith('-'));
const selected = only.length > 0 ? SPECS.filter((s) => only.includes(s.name)) : SPECS;

if (selected.length === 0) {
  console.error(`No matching spec. Known: ${SPECS.map((s) => s.name).join(', ')}`);
  process.exitCode = 2;
} else {
  console.log(`Fetching ${selected.length} spec(s) into corpus/vendor/ (gitignored)\n`);
  const results = [];
  for (const spec of selected) {
    try {
      results.push(await fetchSpec(spec, { force }));
    } catch (error) {
      console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }

  // A manifest so a developer can see what is in their tree and under what terms.
  await mkdir(VENDOR, { recursive: true });
  await writeFile(
    join(VENDOR, 'SOURCES.md'),
    [
      '# Vendored specifications',
      '',
      'Fetched by `pnpm corpus:fetch`. **Gitignored** — not part of this repository.',
      '',
      'Each is pinned to a commit so a snapshot diff is attributable to a besdk change rather than',
      'to an upstream edit.',
      '',
      '| Spec | Source | Pinned commit | Licence |',
      '|---|---|---|---|',
      ...SPECS.map(
        (s) =>
          `| ${s.name} | [${s.repo}](https://github.com/${s.repo}) \`${s.path}\` | \`${s.sha.slice(0, 12)}\` | ${s.licence} |`,
      ),
      '',
      'besdk claims no ownership of these documents. They are used only to exercise the generator',
      'against real API descriptions.',
      '',
    ].join('\n'),
    'utf8',
  );

  const fetched = results.filter((r) => !r.skipped).length;
  console.log(`\n${fetched} fetched, ${results.length - fetched} already present.`);
}
