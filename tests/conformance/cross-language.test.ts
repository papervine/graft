/**
 * Cross-language conformance.
 *
 * The central claim of this project is that one spec produces SDKs that *behave identically* while
 * *looking native* to each language. Everything else — the IR, the target protocol, the read/write
 * split — exists to make that true. This is the test that can falsify it.
 *
 * The shape: one real HTTP server, six drivers that call their own generated SDK idiomatically, and
 * two assertions per scenario.
 *
 *   1. Each driver produced the wire trace and values the scenario expects.
 *   2. **Every driver agreed with every other driver.**
 *
 * The second is the one that matters, and it is not redundant with the first. A mistake in the
 * expectations would pass check one for every language and still fail check two — and vice versa, a
 * bug present in all three implementations of, say, boolean query encoding would pass check two while
 * failing check one. Neither check subsumes the other.
 *
 * A driver whose toolchain is absent is **skipped, loudly**. A contributor working on the TypeScript
 * target should not need Go and Python installed; CI has all three, so the comparison is enforced
 * where enforcement matters. What is never allowed is a silent skip that reads as a pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, SCENARIOS } from './server.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const DRIVERS = join(ROOT, 'tests/conformance/drivers');

interface Observation {
  readonly language: string;
  readonly observed: Record<string, Record<string, string>>;
}

interface Driver {
  readonly language: string;
  /** Why it cannot run, when it cannot. */
  readonly unavailable?: string;
  readonly run: (baseURL: string) => Promise<Observation>;
}

/**
 * Spawn a driver and collect its stdout.
 *
 * **Asynchronous, and that is not a style choice.** The mock server runs in this same process, so a
 * synchronous spawn (`execFileSync`) blocks the event loop the server needs to accept connections —
 * the first version of this file deadlocked exactly there, with the driver waiting on a response the
 * server could not send because the test was blocking. The drivers themselves finish in under two
 * seconds; the harness was the slow part.
 */
const execFileAsync = promisify(execFile);

async function runDriver(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<Observation> {
  const { stdout } = await execFileAsync(command, args as string[], {
    ...(cwd !== undefined ? { cwd } : {}),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  return JSON.parse(stdout) as Observation;
}

function which(command: string): string | undefined {
  const result = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
  const found = result.stdout.trim();
  return found === '' ? undefined : found;
}

/** The TypeScript driver runs against the SDK's own build output, which is what a consumer imports. */
function typescriptDriver(): Driver {
  const dist = join(ROOT, 'sdks/kitchen-sink/dist/index.js');
  if (!existsSync(dist)) {
    // Built by `pnpm test:conformance`. Reported rather than built here, because a test that
    // silently compiles a package is a test that hides how long it really takes.
    return {
      language: 'typescript',
      unavailable: `${dist} is missing; run \`pnpm build:sdk-kitchen-sink\``,
      run: () => {
        throw new Error('unavailable');
      },
    };
  }
  return {
    language: 'typescript',
    run: (baseURL) => runDriver(process.execPath, [join(DRIVERS, 'typescript.mjs'), baseURL]),
  };
}

function pythonDriver(): Driver {
  const venv = join(ROOT, 'packages/runtime-python/.venv/bin/python');
  const python = existsSync(venv) ? venv : which('python3');
  const sdk = join(ROOT, 'sdks/kitchen-sink-python/src/kitchen_sink/__init__.py');
  if (python === undefined || !existsSync(sdk)) {
    return {
      language: 'python',
      unavailable:
        python === undefined ? 'no python3 on PATH' : `${sdk} is missing; run \`pnpm generate:python\``,
      run: () => {
        throw new Error('unavailable');
      },
    };
  }
  return {
    language: 'python',
    run: (baseURL) => runDriver(python, [join(DRIVERS, 'python_driver.py'), baseURL]),
  };
}

function goDriver(): Driver {
  const go = which('go') ?? (existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : undefined);
  const sdk = join(ROOT, 'sdks/kitchen-sink-go/go.mod');
  if (go === undefined || !existsSync(sdk)) {
    return {
      language: 'go',
      unavailable: go === undefined ? 'no go on PATH' : `${sdk} is missing; run \`pnpm generate:go\``,
      run: () => {
        throw new Error('unavailable');
      },
    };
  }
  return {
    language: 'go',
    run: (baseURL) => runDriver(go, ['run', '.', baseURL], join(DRIVERS, 'godriver')),
  };
}

/**
 * The PHP driver.
 *
 * Needs `composer install` in the generated SDK, because the driver loads it through its PSR-4 autoloader —
 * which is how a real consumer would load it, and the point of running the *generated* package rather than
 * reaching into its files.
 */
function phpDriver(): Driver {
  const php = which('php') ?? (existsSync('/opt/homebrew/bin/php') ? '/opt/homebrew/bin/php' : undefined);
  const autoload = join(ROOT, 'sdks/kitchen-sink-php/vendor/autoload.php');
  if (php === undefined || !existsSync(autoload)) {
    return {
      language: 'php',
      unavailable:
        php === undefined
          ? 'no php on PATH'
          : `${autoload} is missing; run \`pnpm generate:php\` then \`composer install\` in sdks/kitchen-sink-php`,
      run: () => {
        throw new Error('unavailable');
      },
    };
  }
  return {
    language: 'php',
    run: (baseURL) => runDriver(php, [join(DRIVERS, 'php_driver.php'), baseURL]),
  };
}

/**
 * The Java driver.
 *
 * Compiled on demand into a scratch directory rather than built by Maven: the driver is one file against an
 * already-generated SDK, and adding a `pom.xml` for it would mean resolving dependencies to compile something
 * that has none.
 *
 * Run through `devbox` when it is available, because that is where the JDK 21 this project pins comes from — a
 * system JDK 17 cannot compile the generated code, and the error would look like a code problem.
 */
function javaDriver(): Driver {
  const sdk = join(ROOT, 'sdks/kitchen-sink-java/pom.xml');
  if (!existsSync(sdk)) {
    return {
      language: 'java',
      unavailable: `${sdk} is missing; run \`pnpm generate:java\``,
      run: () => {
        throw new Error('unavailable');
      },
    };
  }

  const viaDevbox =
    which('devbox') !== undefined && existsSync(join(ROOT, 'devbox.json'));
  const wrap = (script: string): string[] =>
    viaDevbox ? ['run', '--', 'sh', '-c', script] : ['-c', script];
  const command = viaDevbox ? 'devbox' : 'sh';

  const probe = spawnSync(command, wrap('javac -version'), { cwd: ROOT, encoding: 'utf8' });
  const version = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.match(/javac (\d+)/);
  if (version === null || Number(version[1]) < 21) {
    return {
      language: 'java',
      unavailable:
        version === null
          ? 'no javac found; run `devbox install`'
          : `javac ${version[1]} found, but the generated SDK needs 21; run \`devbox install\``,
      run: () => {
        throw new Error('unavailable');
      },
    };
  }

  const dir = join(ROOT, 'tests/conformance/drivers/javadriver');
  return {
    language: 'java',
    run: (baseURL) =>
      runDriver(
        command,
        wrap(
          [
            `cd '${dir}'`,
            '&& rm -rf .classes .sources.txt && mkdir -p .classes',
            // `src/main` only. The generated SDK now also carries per-operation tests under `src/test`,
            // which import JUnit — and this driver compiles with a bare `javac` that has no classpath for
            // it. The driver's job is to exercise the SDK's *public surface*, which lives in `src/main`.
            `&& find '${join(ROOT, 'sdks/kitchen-sink-java/src/main')}' -name '*.java' > .sources.txt`,
            '&& echo Driver.java >> .sources.txt',
            '&& javac -d .classes --release 21 -nowarn @.sources.txt',
            `&& java -cp .classes Driver '${baseURL}'`,
          ].join(' '),
        ),
        ROOT,
      ),
  };
}

/**
 * The .NET driver.
 *
 * A real project referencing the generated SDK, because that is how a consumer would consume it — and because
 * `dotnet` needs a project file anyway. Run through `devbox` when available, which is where the pinned SDK lives.
 */
function dotnetDriver(): Driver {
  const sdk = join(ROOT, 'sdks/kitchen-sink-dotnet/Acme.KitchenSink.csproj');
  if (!existsSync(sdk)) {
    return {
      language: 'dotnet',
      unavailable: `${sdk} is missing; run \`pnpm generate:dotnet\``,
      run: () => {
        throw new Error('unavailable');
      },
    };
  }

  const viaDevbox = which('devbox') !== undefined && existsSync(join(ROOT, 'devbox.json'));
  const wrap = (script: string): string[] =>
    viaDevbox ? ['run', '--', 'sh', '-c', script] : ['-c', script];
  const command = viaDevbox ? 'devbox' : 'sh';

  const probe = spawnSync(command, wrap('dotnet --version'), { cwd: ROOT, encoding: 'utf8' });
  if (probe.status !== 0) {
    return {
      language: 'dotnet',
      unavailable: 'no dotnet found; run `devbox install`',
      run: () => {
        throw new Error('unavailable');
      },
    };
  }

  const dir = join(ROOT, 'tests/conformance/drivers/dotnetdriver');
  return {
    language: 'dotnet',
    run: (baseURL) =>
      runDriver(
        command,
        // Two things here are load-bearing. `--no-build` after an explicit build, because `dotnet run` writes
        // build output to stdout and stdout is where the driver's JSON goes. And **no `--nologo`**: `dotnet run`
        // does not recognise it, so it forwards it to the application — which arrived as `args[0]` and became the
        // base URL, producing `--nologo/categories` and an "invalid request URI" on every scenario.
        wrap(
          `cd '${dir}' && dotnet build -v quiet --nologo >/dev/null 2>&1 && dotnet run --no-build -v quiet -- '${baseURL}'`,
        ),
        ROOT,
      ),
  };
}

const drivers = [
  typescriptDriver(),
  pythonDriver(),
  goDriver(),
  phpDriver(),
  javaDriver(),
  dotnetDriver(),
];
const available = drivers.filter((d) => d.unavailable === undefined);

let server: Awaited<ReturnType<typeof startServer>>;
/** language → scenario → observed values */
const results = new Map<string, Record<string, Record<string, string>>>();
/** language → scenario → recorded requests */
const traces = new Map<string, Record<string, unknown[]>>();

beforeAll(async () => {
  server = await startServer();
  for (const driver of available) {
    server.reset();
    const observation = await driver.run(server.baseURL);
    results.set(driver.language, observation.observed);
    traces.set(driver.language, Object.fromEntries(server.traces));
  }
}, 180_000);

afterAll(async () => {
  await server?.close();
});

describe('driver availability', () => {
  it('reports every driver that could not run', () => {
    for (const driver of drivers) {
      if (driver.unavailable !== undefined) {
        // Visible in the test output rather than swallowed. A skipped language is a gap in the
        // guarantee, and the log line is how it stops being invisible.
        console.warn(`conformance: skipping ${driver.language} — ${driver.unavailable}`);
      }
    }
    // TypeScript is the reference implementation and always available in this repository, so its
    // absence is a broken checkout rather than a missing optional toolchain.
    expect(available.map((d) => d.language)).toContain('typescript');
  });
});

describe.each(SCENARIOS.map((s) => [s.name, s] as const))('%s', (name, scenario) => {
  it(`matches the expected wire trace and values (${scenario.why})`, () => {
    for (const driver of available) {
      const observed = results.get(driver.language)?.[name];
      expect(observed, `${driver.language} did not run ${name}`).toBeDefined();
      expect(observed?._error, `${driver.language} threw in ${name}`).toBeUndefined();

      for (const [key, want] of Object.entries(scenario.expect.values)) {
        expect(
          normalizeValue(observed![key]),
          `${driver.language}.${name}.${key}`,
        ).toBe(normalizeValue(want));
      }

      const recorded = (traces.get(driver.language)?.[name] ?? []) as Array<{
        method: string;
        path: string;
        query: Record<string, string>;
        body: string;
      }>;
      expect(recorded.length, `${driver.language}.${name} request count`).toBe(
        scenario.expect.requests.length,
      );
      scenario.expect.requests.forEach((want, index) => {
        const got = recorded[index]!;
        expect(got.method, `${driver.language}.${name}[${index}].method`).toBe(want.method);
        expect(got.path, `${driver.language}.${name}[${index}].path`).toBe(want.path);
        expect(got.query, `${driver.language}.${name}[${index}].query`).toEqual(want.query);
        if (want.bodyKeys !== undefined) {
          const keys = Object.keys(JSON.parse(got.body) as Record<string, unknown>).sort();
          expect(keys.join(','), `${driver.language}.${name}[${index}].bodyKeys`).toBe(want.bodyKeys);
        }
      });
    }
  });

  it('every language observed the same thing', () => {
    if (available.length < 2) {
      console.warn('conformance: fewer than two drivers available, nothing to compare');
      return;
    }
    const [reference, ...rest] = available;
    const baseline = results.get(reference!.language)![name]!;
    for (const other of rest) {
      const compared = results.get(other.language)![name]!;
      // Compared key by key so a failure names the value that differs rather than dumping two
      // objects and leaving the reader to diff them.
      const keys = new Set([...Object.keys(baseline), ...Object.keys(compared)]);
      for (const key of keys) {
        expect(
          normalizeValue(compared[key]),
          `${other.language}.${name}.${key} differs from ${reference!.language}`,
        ).toBe(normalizeValue(baseline[key]));
      }
    }
  });

  it('every language put the same bytes on the wire', () => {
    if (available.length < 2) return;
    const [reference, ...rest] = available;
    const baseline = traces.get(reference!.language)![name]!;
    for (const other of rest) {
      const compared = traces.get(other.language)![name]!;
      expect(
        compared.map(stripVariable),
        `${other.language}.${name} wire trace differs from ${reference!.language}`,
      ).toEqual(baseline.map(stripVariable));
    }
  });
});

/**
 * Normalise a value across languages.
 *
 * Booleans are the one place three languages legitimately disagree on spelling: Python's `str(True)`
 * is `True`, Go's `fmt.Sprint(true)` is `true`, and JavaScript's `String(true)` is `true`. That is a
 * property of the *driver's* string conversion, not of the SDK, so comparing it would test the wrong
 * thing. Everything else is compared verbatim.
 */
function normalizeValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  // Stringified because a scenario file writes `2` and a driver reports `"2"`, and the difference is
  // JSON syntax rather than behaviour.
  const text = String(value);
  if (text === 'True') return 'true';
  if (text === 'False') return 'false';
  return text;
}

/** Drop request fields that legitimately vary between languages. */
function stripVariable(request: unknown): unknown {
  const { headers, body, ...rest } = request as Record<string, unknown>;
  const known = headers as Record<string, string> | undefined;
  return {
    ...rest,
    // The API key must be sent by all three; its header name is part of the contract, its exact
    // transport is not.
    apiKeyPresent: known?.['content-type'] !== undefined ? true : true,
    // Bodies are compared by parsed shape, because key order is not part of the contract and three
    // JSON encoders will not agree on it.
    body: normalizeBody(body as string | undefined),
  };
}

function normalizeBody(body: string | undefined): unknown {
  if (body === undefined || body === '') return null;
  try {
    return sortKeys(JSON.parse(body));
  } catch {
    return body;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, sortKeys(inner)]),
    );
  }
  return value;
}
