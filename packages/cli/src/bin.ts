#!/usr/bin/env node
import { BRAND, IR_VERSION } from '@graft/protocol';
import { parseArgs, flagBoolean } from './args.js';
import { runCheck } from './commands/check.js';
import type { CommandContext } from './commands/context.js';
import { runInit } from './commands/init.js';
import { runIr } from './commands/ir.js';
import { runGenerate } from './commands/generate.js';
import { runDiff } from './commands/diff.js';
import { runRelease } from './commands/release.js';
import { runTargets } from './commands/targets.js';
import { VERSION } from './index.js';

const USAGE = `${BRAND.name} ${VERSION} — OpenAPI to idiomatic SDK

usage: ${BRAND.name} <command> [options]

commands:
  check <spec>      Validate a spec and report what it fails to say
  init <spec>       Scaffold graft.yaml from a spec
  generate <spec>   Generate an SDK
  ir <spec>         Dump the semantic IR as JSON
  targets           List installed targets and their handshake results
  diff <spec>       Show what regenerating would do to SDK consumers
  release <spec>    Compute the next version and changelog from the contract diff

options:
  --strict          check: exit non-zero on any warning (for CI)
  --json            check: machine-readable output
  --out <path>      init: where to write (default graft.yaml)
  --stdout          init: print instead of writing
  --target <name>   init: which target to scaffold (default typescript)
  --force           init: overwrite an existing graft.yaml
  --config <path>   Path to graft.yaml (default ./graft.yaml if present)
  --summary         ir: print a summary instead of full JSON
  --out <dir>       generate: output directory
  --skip-gates      generate: skip prettier and tsc gates
  --clean           generate: remove the output directory first
  --baseline <path> diff/generate: IR baseline (default .graft/ir.json)
  --accept          diff: update the baseline to the current contract
  --no-baseline     generate: skip writing the IR baseline
  --no-color        Disable colored output
  -h, --help        Show this help
  -v, --version     Show version
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const ctx: CommandContext = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };

  if (flagBoolean(args, 'version')) {
    ctx.stdout(`${BRAND.name} ${VERSION} (IR ${IR_VERSION})\n`);
    return 0;
  }
  if (args.command === undefined || flagBoolean(args, 'help')) {
    ctx.stdout(USAGE);
    return args.command === undefined ? 2 : 0;
  }

  switch (args.command) {
    case 'check':
      return runCheck(args, ctx);
    case 'init':
      return runInit(args, ctx);
    case 'ir':
      return runIr(args, ctx);
    case 'generate':
      return runGenerate(args, ctx);
    case 'diff':
      return runDiff(args, ctx);
    case 'release':
      return runRelease(args, ctx);
    case 'targets':
      return runTargets(args, ctx);
    default:
      ctx.stderr(`${BRAND.name}: unknown command \`${args.command}\`\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => {
    // Set exitCode and let Node exit naturally once stdout drains. Calling process.exit()
    // here silently truncates piped output: writes to a pipe are asynchronous, so anything
    // still buffered is discarded. `graft ir | jq` on a real spec lost everything past the
    // 64KB pipe buffer, producing invalid JSON with no error.
    process.exitCode = code;
  },
  (error: unknown) => {
    // Anything reaching here is a graft bug, not user error — say so plainly.
    process.stderr.write(
      `${BRAND.name}: internal error\n${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exitCode = 70;
  },
);
