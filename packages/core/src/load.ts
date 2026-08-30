/**
 * Stage 1: load — parse the spec document.
 *
 * This stage is deliberately incurious. It parses YAML or JSON, works out which OpenAPI
 * dialect it is looking at, and stops. No `$ref` resolution, no validation, no opinions —
 * those belong to later stages, and keeping them out means a malformed spec still gets far
 * enough to produce a useful diagnostic instead of a parse crash.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { BRAND, DIAGNOSTIC_CODES, type Diagnostic } from '@graft/protocol';
import { getString, isObject, type JsonObject } from './json.js';

/** Which OpenAPI dialect the document uses. The two differ in ways the normalizer cares about. */
export type Dialect = '3.0' | '3.1' | 'unknown';

export interface LoadedSpec {
  /** Path the document was read from, for diagnostics. */
  readonly source: string;
  readonly document: JsonObject;
  readonly dialect: Dialect;
  /** Raw `openapi` (or `swagger`) version string, verbatim. */
  readonly declaredVersion: string | undefined;
}

export interface LoadResult {
  readonly spec: LoadedSpec;
  readonly diagnostics: Diagnostic[];
}

export class SpecLoadError extends Error {
  constructor(
    message: string,
    readonly source: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SpecLoadError';
  }
}

function detectDialect(document: JsonObject): { dialect: Dialect; declared: string | undefined } {
  const declared = getString(document, 'openapi') ?? getString(document, 'swagger');
  if (declared === undefined) return { dialect: 'unknown', declared: undefined };
  if (declared.startsWith('3.1')) return { dialect: '3.1', declared };
  if (declared.startsWith('3.0')) return { dialect: '3.0', declared };
  return { dialect: 'unknown', declared };
}

/**
 * Parse a spec from a string. Split out from {@link loadSpec} so tests and the snapshot
 * suite can drive the pipeline without touching the filesystem.
 */
export function parseSpec(contents: string, source: string): LoadResult {
  const diagnostics: Diagnostic[] = [];

  let parsed: unknown;
  try {
    // The YAML 1.2 parser handles JSON too, so one path covers both input formats.
    parsed = parseYaml(contents, { merge: true });
  } catch (cause) {
    throw new SpecLoadError(
      `${source}: could not be parsed as YAML or JSON`,
      source,
      cause,
    );
  }

  if (!isObject(parsed)) {
    throw new SpecLoadError(
      `${source}: expected the document root to be a mapping, got ${
        parsed === null ? 'null' : Array.isArray(parsed) ? 'a sequence' : typeof parsed
      }`,
      source,
    );
  }

  const { dialect, declared } = detectDialect(parsed);

  if (declared === undefined) {
    diagnostics.push({
      severity: 'warn',
      code: DIAGNOSTIC_CODES.SPEC_VIOLATION_TOLERATED,
      message: 'Document declares no `openapi` version.',
      detail: ['Proceeding on the assumption that this is OpenAPI 3.x.'],
    });
  } else if (dialect === 'unknown') {
    diagnostics.push({
      severity: 'warn',
      code: DIAGNOSTIC_CODES.SPEC_VIOLATION_TOLERATED,
      message: `Unrecognized OpenAPI version \`${declared}\`.`,
      detail: [
        `${BRAND.title} understands 3.0 and 3.1.`,
        declared.startsWith('2') ? 'Convert Swagger 2.0 first, e.g. with `swagger2openapi`.' : '',
      ].filter((line) => line !== ''),
    });
  }

  if (!isObject(parsed['paths'])) {
    diagnostics.push({
      severity: 'warn',
      code: DIAGNOSTIC_CODES.SPEC_VIOLATION_TOLERATED,
      message: 'Document has no `paths` object, so it declares no operations.',
    });
  }

  return {
    spec: { source, document: parsed, dialect, declaredVersion: declared },
    diagnostics,
  };
}

export async function loadSpec(path: string): Promise<LoadResult> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (cause) {
    throw new SpecLoadError(`${path}: could not be read`, path, cause);
  }
  return parseSpec(contents, path);
}
