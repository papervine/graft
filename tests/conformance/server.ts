/**
 * The conformance mock server.
 *
 * One real HTTP server, not a stubbed transport per language. That matters: a mocked `fetch` proves
 * the TypeScript SDK calls `fetch` the way the test expects, which is close to tautological. A real
 * socket proves what actually goes on the wire, which is the only thing three languages can be
 * compared on.
 *
 * The driver announces which scenario it is running with an `X-Scenario` header. The server replays
 * that scenario's scripted responses in order and records every request it received, so the runner
 * can compare the trace against the expectation *and* against the other languages.
 *
 * Deliberately dependency-free and stdlib-only, so it starts in milliseconds and can be driven from
 * a shell script if the Node runner is ever not the thing running it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

/** One scripted response. Exactly one of `json` and `body` is set. */
export interface ScriptedResponse {
  readonly status: number;
  readonly json?: unknown;
  readonly body?: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

/** One request the scenario expects to see, in order. */
export interface ExpectedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  /** Comma-joined sorted top-level keys of the JSON body, when the scenario cares. */
  readonly bodyKeys?: string;
}

export interface Scenario {
  readonly name: string;
  /** Why this scenario exists. Surfaced in the test name so a failure explains itself. */
  readonly why: string;
  readonly responses: readonly ScriptedResponse[];
  readonly expect: {
    readonly requests: readonly ExpectedRequest[];
    readonly values: Record<string, string | number | boolean>;
  };
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface ScenarioFile {
  readonly scenarios: readonly Scenario[];
}

export const SCENARIOS: readonly Scenario[] = (
  JSON.parse(readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8')) as ScenarioFile
).scenarios;

const byName = new Map(SCENARIOS.map((scenario) => [scenario.name, scenario]));

/**
 * Start the server.
 *
 * Returns the bound port and the recorded traces. Port 0 lets the OS choose, so concurrent runs and
 * a developer's own dev server never collide.
 */
export interface RunningServer {
  readonly port: number;
  readonly baseURL: string;
  readonly traces: Map<string, RecordedRequest[]>;
  readonly reset: () => void;
  readonly close: () => Promise<void>;
}

export function startServer(): Promise<RunningServer> {
  const traces = new Map<string, RecordedRequest[]>();
  const cursors = new Map<string, number>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const scenario = req.headers['x-scenario'];
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      // The raw target, not a parsed URL: comparing the path *before* any normalisation is the
      // point, because an unescaped path separator is exactly the bug being tested for.
      const rawTarget = req.url ?? '/';
      const questionMark = rawTarget.indexOf('?');
      const rawPath = questionMark === -1 ? rawTarget : rawTarget.slice(0, questionMark);
      const rawQuery = questionMark === -1 ? '' : rawTarget.slice(questionMark + 1);

      const query: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(rawQuery)) {
        // Repeated keys join with a comma so the comparison is order-insensitive per key but still
        // records multiplicity — an array parameter sent twice is not the same as sent once.
        query[key] = key in query ? `${query[key]!},${value}` : value;
      }

      if (typeof scenario !== 'string' || !byName.has(scenario)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `unknown or missing X-Scenario: ${scenario}` }));
        return;
      }

      const recorded = traces.get(scenario) ?? [];
      recorded.push({
        method: req.method ?? 'GET',
        path: rawPath,
        query,
        headers: {
          authorization: req.headers.authorization ?? '',
          accept: req.headers.accept ?? '',
          'content-type': req.headers['content-type'] ?? '',
        },
        body,
      });
      traces.set(scenario, recorded);

      const index = cursors.get(scenario) ?? 0;
      cursors.set(scenario, index + 1);
      const responses = byName.get(scenario)!.responses;
      // The last scripted response repeats. A scenario that makes more calls than it scripted is
      // usually a runaway iterator, and the runner catches that by comparing request counts — but it
      // must not hang here.
      const script = responses[Math.min(index, responses.length - 1)]!;

      const headers: Record<string, string> = { ...(script.headers ?? {}) };
      let payload: string;
      if (script.json !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(script.json);
      } else {
        headers['content-type'] = script.contentType ?? 'text/plain';
        payload = script.body ?? '';
      }
      res.writeHead(script.status, headers);
      res.end(payload);
    });
  });

  return new Promise<RunningServer>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        baseURL: `http://127.0.0.1:${port}`,
        traces,
        reset: () => {
          traces.clear();
          cursors.clear();
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

