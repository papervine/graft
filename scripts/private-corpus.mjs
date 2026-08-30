#!/usr/bin/env node
/**
 * Run graft over every spec in `corpus/private/`, which is gitignored.
 *
 * Exists so a proprietary or unreleased API description can be the thing you actually develop
 * against, without it becoming part of an open-source repository. That distinction is not a
 * preference — a spec licensed `UNLICENSED` cannot be redistributed, so it must not be committed.
 *
 * Absence is success. Nobody else's checkout has these files, so the script reports and exits `0`
 * rather than failing a build that has nothing to do with them.
 */

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PRIVATE = join(ROOT, 'corpus/private');
const CLI = join(ROOT, 'packages/cli/dist/bin.js');

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: 'inherit', cwd: ROOT });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function listSpecs() {
  try {
    const entries = await readdir(PRIVATE);
    return entries
      .filter((name) => /\.(ya?ml|json)$/i.test(name))
      // A sibling `<name>.graft.yaml` is config, not a spec.
      .filter((name) => !/\.graft\.ya?ml$/i.test(name))
      .sort();
  } catch {
    return undefined;
  }
}

const specs = await listSpecs();

if (specs === undefined) {
  console.log('corpus/private/ does not exist — nothing to do.');
  console.log('Drop a spec there (it is gitignored) to develop against your own API.');
  process.exit(0);
}

if (specs.length === 0) {
  console.log('corpus/private/ is empty — nothing to do.');
  process.exit(0);
}

const command = process.argv[2] ?? 'generate';
const passthrough = process.argv.slice(3);
let failures = 0;

for (const spec of specs) {
  const name = basename(spec, extname(spec));
  const specPath = join('corpus/private', spec);
  const configPath = join(PRIVATE, `${name}.graft.yaml`);
  const hasConfig = await stat(configPath).then(
    () => true,
    () => false,
  );

  console.log(`\n=== ${command} ${specPath} ===`);
  const args = [command, specPath];
  if (hasConfig) args.push('--config', join('corpus/private', `${name}.graft.yaml`));
  if (command === 'generate') args.push('--out', join('sdks/private', name));
  args.push(...passthrough);

  const code = await run(args);
  if (code !== 0) failures += 1;
}

if (failures > 0) {
  console.error(`\n${failures} of ${specs.length} failed.`);
  process.exitCode = 1;
}
