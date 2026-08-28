/**
 * Argument parsing.
 *
 * Hand-rolled rather than pulled from a framework: the surface is six commands with a handful
 * of flags, and a dependency here would be carried by every install of the CLI.
 */

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else {
        // A following non-flag token is this flag's value, unless the flag is boolean-ish.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-') && !BOOLEAN_FLAGS.has(body)) {
          flags.set(body, next);
          i += 1;
        } else {
          flags.set(body, true);
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const alias = SHORT_FLAGS[arg.slice(1)];
      if (alias !== undefined) flags.set(alias, true);
    } else if (command === undefined) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

const BOOLEAN_FLAGS = new Set([
  'strict', 'help', 'version', 'no-color', 'json', 'quiet', 'force', 'stdout', 'clean',
  'skip-gates', 'summary', 'accept', 'no-baseline', 'force-overwrite',
]);

const SHORT_FLAGS: Record<string, string> = {
  h: 'help',
  v: 'version',
};

export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}
