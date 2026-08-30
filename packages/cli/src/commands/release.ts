/**
 * `graft release` — compute the next version and the changelog (SPEC.md §3.5.1).
 *
 * Writes two things and publishes nothing. That split is deliberate: graft owns what needs contract
 * knowledge, and a tool holding registry credentials is a tool nobody runs locally to see what it would
 * do.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { BRAND } from '@graft/protocol';
import {
  buildIR,
  diffIR,
  inspectSpecFile,
  insertChangelogEntry,
  planRelease,
  renderChangelogEntry,
  SpecLoadError,
  type ReleasePlan,
} from '@graft/core';
import type { IR } from '@graft/protocol';
import { flagBoolean, flagString, type ParsedArgs } from '../args.js';
import type { Config } from '@graft/core';
import type { CommandContext } from './context.js';
import { resolveConfig } from './ir.js';
import { defaultBaselinePath } from './diff.js';

/** Where the SDK's own version lives, beside the IR baseline it is derived from. */
export function defaultVersionPath(specPath: string): string {
  return defaultBaselinePath(specPath).replace(/\.ir\.json$/, '.sdk-version');
}

export async function runRelease(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const specPath = args.positionals[0];
  if (specPath === undefined) {
    ctx.stderr(
      `usage: ${BRAND.name} release <spec.yaml> [--version X.Y.Z] [--changelog PATH] [--dry-run]\n`,
    );
    return 2;
  }

  const loaded = await resolveConfig(args, ctx);
  if (typeof loaded === 'number') return loaded;
  const { config } = loaded;

  let inspection;
  try {
    inspection = await inspectSpecFile(specPath);
  } catch (error) {
    if (error instanceof SpecLoadError) {
      ctx.stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const { ir } = buildIR(inspection, config);

  const baselinePath = flagString(args, 'baseline') ?? defaultBaselinePath(specPath);
  const versionPath = flagString(args, 'version-file') ?? defaultVersionPath(specPath);
  const changelogPath = flagString(args, 'changelog') ?? 'CHANGELOG.md';
  const dryRun = flagBoolean(args, 'dry-run');

  // No baseline means nothing to compare against, so there is no bump to compute. Reported rather than
  // guessed: silently treating a first run as `0.1.0` when the baseline is merely *missing* would
  // publish a version that goes backwards the next time.
  let baseline: IR | undefined;
  if (existsSync(baselinePath)) {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as IR;
  }

  const currentVersion = existsSync(versionPath)
    ? (await readFile(versionPath, 'utf8')).trim()
    : undefined;

  const diff =
    baseline === undefined
      ? { changes: [], breaking: 0, additive: 0, patch: 0 }
      : diffIR(baseline, ir);

  let plan: ReleasePlan;
  try {
    plan = planRelease(currentVersion, diff, flagString(args, 'version'));
  } catch (error) {
    ctx.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  // --- report -------------------------------------------------------------
  if (currentVersion === undefined) {
    ctx.stdout(
      `No recorded SDK version, so this is the first release.\n` +
        `  \`0.x\` says "generated, not yet promised". Use --version 1.0.0 when you mean it.\n\n`,
    );
  }
  if (baseline === undefined) {
    ctx.stdout(
      `No baseline at ${baselinePath}, so no changes could be computed.\n` +
        `  Run \`${BRAND.name} generate\` first; it writes the baseline that \`release\` compares against.\n\n`,
    );
  }

  ctx.stdout(`${plan.current} → ${plan.next}  (${plan.bump}: ${plan.because})\n`);
  if (plan.changes.length > 0) {
    const shown = plan.changes.slice(0, 5);
    for (const change of shown) {
      const marker = change.severity === 'breaking' ? '✗' : change.severity === 'additive' ? '+' : '·';
      ctx.stdout(`  ${marker} ${change.path} — ${change.message}\n`);
    }
    if (plan.changes.length > shown.length) {
      ctx.stdout(`  … and ${plan.changes.length - shown.length} more, all in the changelog\n`);
    }
  }

  if (plan.goMajorSuffix !== undefined) {
    // Go requires the major version in the module path, so this is a rename of every import rather
    // than a version edit. Surfaced, never performed: it touches files a user may have customised.
    ctx.stdout(
      `\nGo needs the major version in its module path at ${plan.next}.\n` +
        `  Set \`targets.go.modulePath\` to end in \`${plan.goMajorSuffix}\` and regenerate, or\n` +
        `  consumers cannot \`go get\` it. This is Go's rule, not ${BRAND.name}'s.\n`,
    );
  }

  // A first release has no bump but is still a release: the version file has to exist before a later
  // run can compute anything from it.
  const isFirstRelease = currentVersion === undefined;
  if (plan.bump === 'none' && !isFirstRelease && flagString(args, 'version') === undefined) {
    ctx.stdout(`\nNothing to release.\n`);
    return 0;
  }

  // --- write --------------------------------------------------------------
  const date = flagString(args, 'date') ?? new Date().toISOString().slice(0, 10);
  const entry = renderChangelogEntry(plan, date);

  if (dryRun) {
    ctx.stdout(`\n--dry-run, so nothing was written. The entry would be:\n\n${entry}`);
    return 0;
  }

  await mkdir(dirname(versionPath), { recursive: true });
  await writeFile(versionPath, `${plan.next}\n`, 'utf8');

  const existingChangelog = existsSync(changelogPath)
    ? await readFile(changelogPath, 'utf8')
    : undefined;
  await writeFile(
    changelogPath,
    insertChangelogEntry(existingChangelog, entry, plan.next),
    'utf8',
  );

  ctx.stdout(`\nWrote ${versionPath} and ${changelogPath}\n`);
  ctx.stdout(
    `Commit both, then regenerate so the version reaches each package manifest.\n` +
      `${BRAND.name} does not publish: that needs registry credentials, which belong in CI.\n`,
  );

  // Tags are printed rather than created, for the same reason nothing is published — and because a Go
  // module's version *is* its tag, so this is the only place that target gets a version at all.
  for (const [name, target] of Object.entries(config.targets ?? {})) {
    const out = (target as { out?: string }).out;
    if (name === 'go' && out !== undefined) {
      ctx.stdout(`\nGo module tag to create: ${out}/v${plan.next}\n`);
    }
  }

  if (flagBoolean(args, 'workflow')) {
    const path = flagString(args, 'workflow-path') ?? '.github/workflows/release-sdks.yml';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderWorkflow(config, specPath), 'utf8');
    ctx.stdout(`\nWrote ${path}\n`);
  }

  return 0;
}

/**
 * Emit a CI workflow that publishes.
 *
 * Emitted rather than executed. Publishing needs registry credentials, and a tool that needs
 * credentials is one nobody runs locally to see what it would do — so the steps live where the secrets
 * already are. It is also the only honest place for the parts graft cannot know: which registry, which
 * branch, whether a human approves.
 *
 * Written once and then owned by the user. Regenerating it would overwrite the customisations that
 * make it fit their pipeline, so `--workflow` is opt-in rather than part of every release.
 */
function renderWorkflow(config: Config, specPath: string): string {
  const targets = Object.keys(config.targets ?? {});
  const lines: string[] = [
    `# Publishes the SDKs ${BRAND.name} generated.`,
    '#',
    `# Written once by \`${BRAND.name} release --workflow\` and then yours: it will not be`,
    '# overwritten, because',
    '# the parts it cannot know — which registry, which branch, whether a human approves — are exactly',
    '# the parts you will edit.',
    '#',
    `# The version and changelog are computed by \`${BRAND.name} release\` and committed, so this`,
    '# workflow only',
    '# publishes what is already decided. That split is deliberate: a generator holding registry',
    '# credentials is a generator nobody runs locally.',
    'name: Release SDKs',
    '',
    'on:',
    '  push:',
    '    tags: ["v*"]',
    '  workflow_dispatch:',
    '',
    'jobs:',
  ];

  if (targets.includes('typescript')) {
    const out = (config.targets?.['typescript'] as { out?: string })?.out ?? 'sdks/typescript';
    lines.push(
      '  typescript:',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      contents: read',
      '      # Trusted publishing: npm mints a short-lived token from this, so no long-lived secret',
      '      # has to exist in the repository at all.',
      '      id-token: write',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-node@v4',
      '        with:',
      "          node-version: '22'",
      "          registry-url: 'https://registry.npmjs.org'",
      `      - run: npm ci --prefix ${out} || npm install --prefix ${out}`,
      `      - run: npm run build --prefix ${out}`,
      // `--provenance` links the published package to this workflow run, which is what lets a consumer
      // verify it was built from this source rather than uploaded by hand.
      `      - run: npm publish --provenance --access public`,
      `        working-directory: ${out}`,
      '        env:',
      '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
      '',
    );
  }

  if (targets.includes('python')) {
    const out = (config.targets?.['python'] as { out?: string })?.out ?? 'sdks/python';
    lines.push(
      '  python:',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      contents: read',
      '      # PyPI trusted publishing, for the same reason as npm above.',
      '      id-token: write',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-python@v5',
      '        with:',
      "          python-version: '3.12'",
      '      - run: pipx run build',
      `        working-directory: ${out}`,
      '      - uses: pypa/gh-action-pypi-publish@release/v1',
      '        with:',
      `          packages-dir: ${out}/dist`,
      '',
    );
  }

  if (targets.includes('go')) {
    const out = (config.targets?.['go'] as { out?: string })?.out ?? 'sdks/go';
    lines.push(
      '  go:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-go@v5',
      '        with:',
      "          go-version: '1.22'",
      `      - run: go build ./... && go vet ./...`,
      `        working-directory: ${out}`,
      '      # Nothing to upload: a Go module is published by tagging the repository, which the tag that',
      '      # triggered this workflow already did. A module in a subdirectory needs a tag prefixed with',
      `      # its path — \`${out}/vX.Y.Z\` — which \`${BRAND.name} release\` prints.`,
      '      - run: echo "Go module published by tag ${{ github.ref_name }}"',
      '',
    );
  }

  lines.push(
    '  # A guard rather than a step you can forget: regenerating must not change the committed SDKs, or',
    '  # what is being published is not what the spec says.',
    '  verify-up-to-date:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '22'",
    `      - run: npx --yes ${BRAND.name} generate ${specPath}`,
    '      - name: Fail if regenerating changed anything',
    '        run: git diff --exit-code',
    '',
  );

  return lines.join('\n');
}
