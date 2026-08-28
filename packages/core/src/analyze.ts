/**
 * The analysis pass behind `besdk check` (SPEC.md §3.6).
 *
 * Each analyzer answers one question about what the spec fails to say, and every diagnostic
 * carries a `besdk.yaml` fragment that resolves it. A diagnostic the user cannot act on has
 * not done its job — under-specification must be surfaced, never silently papered over.
 *
 * These analyzers are also the detection half of the normalizer rules in SPEC.md §3.1.2: the
 * same predicates that report a problem in `check` are what `generate` acts on.
 */

import { BRAND, DIAGNOSTIC_CODES, type Diagnostic } from '@besdk/protocol';
import {
  entriesOf,
  getArray,
  getObject,
  getString,
  isArray,
  isObject,
  pointer,
  structuralKey,
  type Json,
  type JsonObject,
} from './json.js';
import {
  hasTypeInformation,
  resourceGroupOf,
  type OperationIndex,
  type OperationView,
} from './operations.js';
import { DEFAULT_COMPOUND_WORDS, singularize, tokenize } from './names.js';
import { surveyExtensions, UNHANDLED_EXTENSIONS } from './extensions.js';
import type { ResolvedSpec } from './resolve.js';

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/** `1 thing is` / `2 things are`, so aggregate messages read as English. */
function plural(count: number, singular: string, verb?: [string, string]): string {
  const noun = count === 1 ? singular : `${singular}s`;
  if (verb === undefined) return `${count} ${noun}`;
  return `${count} ${noun} ${count === 1 ? verb[0] : verb[1]}`;
}

/**
 * Naive singularization, used only to *suggest* a better model name.
 *
 * `AssetsResponse` → `Asset`, because a list-item type named in the plural reads wrong on a
 * single value. Wrong guesses are harmless here: the output is a `besdk.yaml` fragment the
 * user edits, never a name applied automatically.
 */
export function suggestModelName(
  schemaName: string,
  vocabulary: ReadonlySet<string> = new Set(DEFAULT_COMPOUND_WORDS),
): string {
  const stripped = schemaName.replace(/(Response|Payload|Model|Dto)$/i, '') || schemaName;
  // Tokenize with the vocabulary so an all-lowercase compound is split before recasing:
  // `AssettypesResponse` must suggest `AssetType`, not `Assettype`.
  const tokens = tokenize(stripped, vocabulary);
  if (tokens.length === 0) return stripped;
  const last = tokens[tokens.length - 1]!;
  const singular = [...tokens.slice(0, -1), singularize(last, vocabulary)];
  return singular.map((t) => t[0]!.toUpperCase() + t.slice(1)).join('');
}

export interface SchemaSite {
  readonly pointer: string;
  readonly schema: JsonObject;
}

/** Yield every schema-shaped node reachable from a root, with its JSON pointer. */
export function* walkSchemas(root: Json, path: string[] = []): Generator<SchemaSite> {
  if (isArray(root)) {
    for (let i = 0; i < root.length; i++) yield* walkSchemas(root[i] as Json, [...path, String(i)]);
    return;
  }
  if (!isObject(root)) return;
  if (hasTypeInformation(root)) yield { pointer: pointer(...path), schema: root };
  for (const [key, value] of Object.entries(root)) {
    // Vendor extensions are not the API contract, and walking into them produces confident nonsense.
    // Stripe's `x-expansionResources` holds a `oneOf` of every expandable resource — 46 of them —
    // which the ambiguous-union check reported as a spec problem when it is Stripe's own metadata about
    // *its* tooling. A diagnostic with 46 false positives is not a diagnostic.
    //
    // Applied in the walker rather than in one check, because every check reading this stream had the
    // same exposure: `x-*` can contain anything that looks like a schema and means something else.
    if (key.startsWith('x-')) continue;
    yield* walkSchemas(value as Json, [...path, key]);
  }
}

function truncate(items: readonly string[], limit = 6): string[] {
  if (items.length <= limit) return [...items];
  return [...items.slice(0, limit), `…and ${items.length - limit} more`];
}

// ---------------------------------------------------------------------------
// M001 — read/write model conflation
// ---------------------------------------------------------------------------

export interface ConflatedSchema {
  readonly name: string;
  readonly roles: readonly string[];
}

/**
 * Find schemas used in both request and response position.
 *
 * This is the highest-leverage finding in the whole pass. A schema serving both roles yields
 * `create({ _id: … })` — a method whose signature invites the caller to supply a field the
 * server owns. It typechecks, so nothing else catches it.
 */
export function findReadWriteConflation(index: OperationIndex): ConflatedSchema[] {
  const conflated: ConflatedSchema[] = [];
  for (const [name, positions] of index.schemaPositions) {
    if (!positions.has('request') || !positions.has('response')) continue;
    const roles = new Set<string>();
    for (const op of index.operations) {
      if (op.body?.schemaRefs.includes(name)) {
        roles.add(`${op.verb.toUpperCase()} ${op.path} request body`);
      }
      for (const response of op.responses) {
        if (response.schemaRefs.includes(name)) {
          roles.add(`${op.verb.toUpperCase()} ${op.path} → ${response.status}`);
        }
      }
    }
    conflated.push({ name, roles: [...roles].sort() });
  }
  return conflated.sort((a, b) => b.roles.length - a.roles.length || a.name.localeCompare(b.name));
}

function diagnoseReadWriteConflation(index: OperationIndex): Diagnostic[] {
  const conflated = findReadWriteConflation(index);
  if (conflated.length === 0) return [];
  const worst = conflated[0]!;
  return [
    {
      severity: 'warn',
      code: DIAGNOSTIC_CODES.READ_WRITE_CONFLATION,
      message: `${plural(conflated.length, 'schema', ['serves', 'serve'])} as both request and response bodies.`,
      detail: [
        `${worst.name} is used in ${worst.roles.length} roles:`,
        ...truncate(worst.roles, 4).map((role) => `  ${role}`),
        'Generated write methods will accept server-owned fields such as ids and timestamps.',
        ...(conflated.length > 1
          ? [`Also: ${truncate(conflated.slice(1).map((c) => c.name), 5).join(', ')}`]
          : []),
      ],
      fix: (() => {
        const suggested = suggestModelName(worst.name);
        return [
          'models:',
          `  ${worst.name}:`,
          `    rename: ${suggested}`,
          `    split: { read: ${suggested}, create: ${suggested}Create, update: ${suggested}Update }`,
          '    serverOwned: [_id, createdAt, updatedAt]',
        ].join('\n');
      })(),
      // Every conflated schema, not just the worst one: configuring one leaves the warning true of
      // the rest. `withoutResolved` requires all of them.
      resolvedBy: conflated.map((c) => `models.${c.name}.split`),
      count: conflated.length,
    },
  ];
}

// ---------------------------------------------------------------------------
// E001 — error responses without a schema
// ---------------------------------------------------------------------------

export interface ErrorResponseSurvey {
  readonly total: number;
  readonly untyped: number;
  readonly byStatus: ReadonlyMap<string, { total: number; untyped: number }>;
  /** Structural keys of the error shapes that *were* declared, with occurrence counts. */
  readonly declaredShapes: ReadonlyMap<string, { count: number; sample: JsonObject }>;
}

export function surveyErrorResponses(index: OperationIndex): ErrorResponseSurvey {
  const byStatus = new Map<string, { total: number; untyped: number }>();
  const declaredShapes = new Map<string, { count: number; sample: JsonObject }>();
  let total = 0;
  let untyped = 0;

  for (const op of index.operations) {
    for (const response of op.responses) {
      const code = response.statusCode;
      const isError = response.status === 'default' || (code !== undefined && code >= 400);
      if (!isError) continue;
      total += 1;
      const bucket = byStatus.get(response.status) ?? { total: 0, untyped: 0 };
      bucket.total += 1;
      if (!response.hasTypedSchema) {
        untyped += 1;
        bucket.untyped += 1;
      } else if (response.schema !== undefined && response.schemaRefs.length === 0) {
        const key = structuralKey(response.schema);
        const existing = declaredShapes.get(key);
        if (existing) existing.count += 1;
        else declaredShapes.set(key, { count: 1, sample: response.schema });
      }
      byStatus.set(response.status, bucket);
    }
  }

  return { total, untyped, byStatus, declaredShapes };
}

function renderShapeFix(shape: JsonObject): string {
  const properties = getObject(shape, 'properties');
  if (properties === undefined) return 'errors:\n  default: { schema: unknown }';
  const fields = Object.entries(properties).map(([key, value]) => {
    const type = getString(value, 'type') ?? 'unknown';
    return `${key}: ${type}`;
  });
  return ['errors:', `  default: { schema: { ${fields.join(', ')} } }`].join('\n');
}

function diagnoseErrorSchemas(index: OperationIndex): Diagnostic[] {
  const survey = surveyErrorResponses(index);
  if (survey.untyped === 0) return [];

  const statusBreakdown = [...survey.byStatus]
    .filter(([, v]) => v.untyped > 0)
    .sort((a, b) => b[1].untyped - a[1].untyped)
    .map(([status, v]) => `${status}: ${v.untyped}/${v.total} untyped`);

  // If the spec declared the shape anywhere, propose that shape rather than inventing one.
  const mostCommonShape = [...survey.declaredShapes.values()].sort((a, b) => b.count - a.count)[0];

  return [
    {
      severity: 'warn',
      code: DIAGNOSTIC_CODES.ERROR_SCHEMA_MISSING,
      message: `${survey.untyped} of ${survey.total} error responses declare no schema.`,
      detail: [
        ...truncate(statusBreakdown, 6),
        'Without a shape, the generated SDK cannot expose error bodies in a typed way.',
        ...(mostCommonShape
          ? [
              `The spec does declare a shape on ${mostCommonShape.count} response${
                mostCommonShape.count === 1 ? '' : 's'
              } — reusing it below.`,
            ]
          : []),
      ],
      fix: mostCommonShape
        ? renderShapeFix(mostCommonShape.sample)
        : 'errors:\n  default: { schema: { error: string } }',
      resolvedBy: ['errors.default'],
      count: survey.untyped,
    },
  ];
}

// ---------------------------------------------------------------------------
// M002 — objects with no required fields
// ---------------------------------------------------------------------------

export interface OptionalitySurvey {
  readonly name: string;
  readonly fieldCount: number;
  /** Real field names, so the suggested fix names fields that exist. */
  readonly sampleFields: readonly string[];
}

export function findAllOptionalObjects(resolved: ResolvedSpec): OptionalitySurvey[] {
  const result: OptionalitySurvey[] = [];
  for (const [name, schema] of resolved.schemas) {
    const properties = getObject(schema, 'properties');
    if (properties === undefined) continue;
    const fieldCount = Object.keys(properties).length;
    if (fieldCount === 0) continue;
    const required = getArray(schema, 'required') ?? [];
    if (required.length === 0) {
      result.push({ name, fieldCount, sampleFields: Object.keys(properties).slice(0, 4) });
    }
  }
  return result.sort((a, b) => b.fieldCount - a.fieldCount);
}

function diagnoseOptionality(resolved: ResolvedSpec): Diagnostic[] {
  const survey = findAllOptionalObjects(resolved);
  if (survey.length === 0) return [];
  const worst = survey[0]!;
  return [
    {
      severity: 'warn',
      code: DIAGNOSTIC_CODES.ALL_FIELDS_OPTIONAL,
      message: `${plural(survey.length, 'named schema', ['declares', 'declare'])} no required fields.`,
      detail: [
        `Worst: ${worst.name} — ${worst.fieldCount}/${worst.fieldCount} fields optional.`,
        'Under a strict typechecker every access needs a null check, which makes the SDK ' +
          'unpleasant to use even though it compiles.',
        ...truncate(
          survey.slice(1, 6).map((s) => `${s.name} — ${s.fieldCount} fields`),
          5,
        ),
      ],
      fix: [
        'models:',
        `  ${worst.name}:`,
        `    required: [${worst.sampleFields.slice(0, 2).join(', ')}]  # list the always-present fields`,
      ].join('\n'),
      resolvedBy: survey.map((entry) => `models.${entry.name}.required`),
      count: survey.length,
    },
  ];
}

// ---------------------------------------------------------------------------
// T001/T002 — union artifacts
// ---------------------------------------------------------------------------

export interface UnionSurvey {
  readonly phpEmptyMap: SchemaSite[];
  readonly scalarUnions: SchemaSite[];
  /** `oneOf` unions whose branches cannot be told apart. See {@link isAmbiguousOneOf}. */
  readonly ambiguousOneOf: SchemaSite[];
}

/** `oneOf: [{object…}, {type: array, maxItems: 0}]` — an empty map that serializes as `[]`. */
export function isPhpEmptyMapUnion(schema: JsonObject): boolean {
  const branches = getArray(schema, 'oneOf') ?? getArray(schema, 'anyOf');
  if (branches === undefined || branches.length !== 2) return false;
  const isEmptyArrayBranch = (b: Json): boolean =>
    isObject(b) && getString(b, 'type') === 'array' && b['maxItems'] === 0;
  const isObjectBranch = (b: Json): boolean => isObject(b) && getString(b, 'type') === 'object';
  const [first, second] = branches as [Json, Json];
  return (
    (isObjectBranch(first) && isEmptyArrayBranch(second)) ||
    (isEmptyArrayBranch(first) && isObjectBranch(second))
  );
}

/** `oneOf: [string, integer]` — loose scalar encoding, not a domain union. */
export function isScalarUnion(schema: JsonObject): boolean {
  const branches = getArray(schema, 'oneOf') ?? getArray(schema, 'anyOf');
  if (branches === undefined || branches.length < 2) return false;
  return branches.every((branch) => {
    if (!isObject(branch)) return false;
    const type = getString(branch, 'type');
    if (type === undefined || !SCALAR_TYPES.has(type)) return false;
    // Anything beyond a bare type means it carries real structure.
    return !['properties', 'items', 'enum', 'oneOf', 'anyOf', 'allOf', '$ref'].some(
      (key) => key in branch,
    );
  });
}

/**
 * A `oneOf` whose branches cannot be told apart at decode time.
 *
 * `oneOf` promises *exactly one* branch matches, and a consumer has to work out which. With a
 * `discriminator` that is trivial. Without one, the only remaining handle is structure — and when two
 * branches are `$ref`s, or share the same declared properties, there is nothing to decide on. Such a
 * union decodes ambiguously in every language, so besdk reports it rather than absorbing it.
 *
 * Deliberately narrow. A union of *differently shaped* branches is fine — `string | Widget` is
 * unambiguous — and flagging every discriminator-less `oneOf` would bury the real cases. This looks
 * only for the shape that genuinely cannot be resolved: two or more object-ish branches with no
 * discriminator.
 */
export function isAmbiguousOneOf(schema: JsonObject): boolean {
  const branches = getArray(schema, 'oneOf');
  if (branches === undefined || branches.length < 2) return false;
  if (getObject(schema, 'discriminator') !== undefined) return false;
  // An artifact or a loose-scalar union is already reported as itself; saying it twice is noise.
  if (isPhpEmptyMapUnion(schema) || isScalarUnion(schema)) return false;

  const objectish = branches.filter(
    (branch) =>
      isObject(branch) &&
      (getString(branch, '$ref') !== undefined ||
        getString(branch, 'type') === 'object' ||
        'properties' in branch),
  );
  return objectish.length >= 2;
}

export function surveyUnions(spec: JsonObject): UnionSurvey {
  const phpEmptyMap: SchemaSite[] = [];
  const scalarUnions: SchemaSite[] = [];
  const ambiguousOneOf: SchemaSite[] = [];
  for (const site of walkSchemas(spec)) {
    if (isPhpEmptyMapUnion(site.schema)) phpEmptyMap.push(site);
    else if (isScalarUnion(site.schema)) scalarUnions.push(site);
    else if (isAmbiguousOneOf(site.schema)) ambiguousOneOf.push(site);
  }
  return { phpEmptyMap, scalarUnions, ambiguousOneOf };
}

function diagnoseUnions(spec: JsonObject): Diagnostic[] {
  const { phpEmptyMap, scalarUnions, ambiguousOneOf } = surveyUnions(spec);
  const diagnostics: Diagnostic[] = [];

  if (phpEmptyMap.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: DIAGNOSTIC_CODES.PHP_EMPTY_MAP_COLLAPSED,
      message: `${phpEmptyMap.length} union${
        phpEmptyMap.length === 1 ? '' : 's'
      } look like an empty map serialized as \`[]\`; collapsing to a map.`,
      detail: [
        'A server that emits `[]` for an empty map is a serialization artifact, not a union.',
        'Modelling it as a union would force every caller to branch forever; the runtime ' +
          'coerces `[]` to `{}` instead.',
        ...truncate(phpEmptyMap.map((s) => s.pointer), 4),
      ],
      fix: 'normalize:\n  phpEmptyMap: true   # already the default; set false to keep the union',
      count: phpEmptyMap.length,
    });
  }

  if (scalarUnions.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: DIAGNOSTIC_CODES.SCALAR_UNION,
      message: `${scalarUnions.length} union${
        scalarUnions.length === 1 ? '' : 's'
      } combine only scalar types.`,
      detail: [
        'These usually mean the server is loose about encoding rather than that the value has ' +
          'two meanings.',
        ...truncate(scalarUnions.map((s) => s.pointer), 4),
      ],
      fix: 'normalize:\n  scalarUnion: widen   # or `coerce` to pick one type and convert',
      count: scalarUnions.length,
    });
  }

  if (ambiguousOneOf.length > 0) {
    diagnostics.push({
      severity: 'warn',
      code: DIAGNOSTIC_CODES.AMBIGUOUS_ONE_OF,
      message: `${ambiguousOneOf.length} \`oneOf\` union${
        ambiguousOneOf.length === 1 ? '' : 's'
      } cannot be told apart at decode time.`,
      detail: [
        '`oneOf` promises exactly one branch matches, but without a `discriminator` a consumer has ' +
          'nothing to decide on — these branches are all objects.',
        'Every language will guess, and they may guess differently. Adding a discriminator is the ' +
          'only fix that works everywhere.',
        ...truncate(ambiguousOneOf.map((s) => s.pointer), 4),
      ],
      fix:
        'discriminator:\n  propertyName: type\n  mapping:\n    a.value: "#/components/schemas/A"\n' +
        `# ${BRAND.name} narrows each branch on that property, so callers can switch on it.`,
      count: ambiguousOneOf.length,
    });
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// T003 — empty schemas
// ---------------------------------------------------------------------------

export function countEmptySchemas(index: OperationIndex): { total: number; sites: string[] } {
  const sites: string[] = [];
  for (const op of index.operations) {
    if (op.body !== undefined && op.body.schema !== undefined && !hasTypeInformation(op.body.schema)) {
      sites.push(`${op.verb.toUpperCase()} ${op.path} request body`);
    }
    for (const response of op.responses) {
      if (response.hasContent && !response.hasTypedSchema) {
        sites.push(`${op.verb.toUpperCase()} ${op.path} → ${response.status}`);
      }
    }
  }
  return { total: sites.length, sites };
}

function diagnoseEmptySchemas(index: OperationIndex): Diagnostic[] {
  const { total, sites } = countEmptySchemas(index);
  if (total === 0) return [];
  return [
    {
      severity: 'warn',
      code: DIAGNOSTIC_CODES.EMPTY_SCHEMA,
      message: `${total} request or response bod${total === 1 ? 'y' : 'ies'} declare content with no schema.`,
      detail: [
        'These become `unknown` — typed as opaque rather than as `any`, so callers must narrow ' +
          'before use.',
        ...truncate(sites, 5),
      ],
      fix: 'Add a schema to the spec, or accept `unknown` at these sites.',
      count: total,
    },
  ];
}

// ---------------------------------------------------------------------------
// H001 — constant header parameters
// ---------------------------------------------------------------------------

export interface ConstantHeader {
  readonly name: string;
  readonly value: string;
  readonly operationCount: number;
}

/**
 * Header parameters that carry the same default on (almost) every operation.
 *
 * Left in place these appear in every generated method signature. Hoisting them into runtime
 * defaults is the difference between a signature that reads hand-written and one that reads
 * mechanically transcribed.
 */
export function findConstantHeaders(index: OperationIndex, threshold = 0.9): ConstantHeader[] {
  const total = index.operations.length;
  if (total === 0) return [];

  const candidates = new Map<string, { values: Set<string>; count: number; required: boolean }>();
  for (const op of index.operations) {
    for (const param of op.parameters) {
      if (param.location !== 'header') continue;
      if (typeof param.defaultValue !== 'string') continue;
      const entry = candidates.get(param.name) ?? {
        values: new Set<string>(),
        count: 0,
        required: false,
      };
      entry.values.add(param.defaultValue);
      entry.count += 1;
      entry.required = entry.required || param.required;
      candidates.set(param.name, entry);
    }
  }

  const result: ConstantHeader[] = [];
  for (const [name, entry] of candidates) {
    if (entry.values.size !== 1) continue; // varies, so it is a real parameter
    if (entry.count / total < threshold) continue;
    result.push({ name, value: [...entry.values][0]!, operationCount: entry.count });
  }
  return result.sort((a, b) => b.operationCount - a.operationCount);
}

function diagnoseConstantHeaders(index: OperationIndex): Diagnostic[] {
  const headers = findConstantHeaders(index);
  if (headers.length === 0) return [];
  const total = index.operations.length;
  return [
    {
      severity: 'info',
      code: DIAGNOSTIC_CODES.CONST_HEADER_HOISTED,
      message: `${plural(headers.length, 'header parameter', ['is', 'are'])} constant across operations; hoisting into runtime defaults.`,
      detail: headers.map(
        (h) => `${h.name}: ${h.value} — on ${h.operationCount}/${total} operations`,
      ),
      fix: [
        'headers:',
        '  constant:',
        ...headers.map((h) => `    ${h.name}: ${h.value}`),
      ].join('\n'),
      count: headers.length,
    },
  ];
}

// ---------------------------------------------------------------------------
// P001 — pagination
// ---------------------------------------------------------------------------

/**
 * Whether the success response actually looks like a collection.
 *
 * Paging parameters alone are not evidence. In the first corpus entry the author pasted the
 * same `limit`/`offset` block onto all 33 GETs, including `reindex`, `analyze`, and
 * `syncclerk` — actions that return no collection at all. Emitting an iterator for
 * `assets.reindex()` because it accepts `offset` would be confidently wrong, so pagination
 * requires corroboration from the response shape.
 */
export type CollectionEvidence =
  /** The success response is an array. */
  | 'array'
  /** The response is an object wrapping an array, e.g. `{ data: [...], next_cursor }`. */
  | 'envelope'
  /** The response has no usable schema, so collection-ness cannot be determined. */
  | 'unknown'
  /** The response is a single object; paging params notwithstanding, this is not a list. */
  | 'none';

/** Property names conventionally holding the items of a paginated envelope. */
const ITEMS_PROPERTIES = ['data', 'items', 'results', 'records', 'entries', 'values', 'list'];

/** Property names conventionally holding the cursor for the next page. */
const CURSOR_PROPERTIES = [
  'next_cursor', 'nextCursor', 'next', 'cursor', 'next_page_token', 'nextPageToken',
  'next_token', 'nextToken', 'after', 'end_cursor', 'endCursor',
];

/** Property names conventionally holding a total count. */
const TOTAL_PROPERTIES = ['total', 'total_count', 'totalCount', 'count', 'total_results'];

export interface PaginationCandidate {
  readonly operation: OperationView;
  readonly limitParam: string;
  readonly offsetParam: string | undefined;
  readonly pageParam: string | undefined;
  readonly cursorParam: string | undefined;
  /** A response header named in prose but never declared in `responses.headers`. */
  readonly proseTotalHeader: string | undefined;
  readonly evidence: CollectionEvidence;
  /** Present when the response wraps its items in an envelope. */
  readonly envelope?: EnvelopeShape;
}

/**
 * Paging parameter names, normalized.
 *
 * Matching is case- and separator-insensitive because real specs disagree about both: Twilio uses
 * `PageSize`/`Page`/`PageToken`, others `page_size`, others `perPage`. A case-sensitive set silently
 * failed to detect pagination on all 75 Twilio resources.
 */
function normalizeParamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const LIMIT_NAMES = new Set(
  ['limit', 'per_page', 'pageSize', 'count', 'size', 'maxResults', 'max_results'].map(
    normalizeParamName,
  ),
);
const OFFSET_NAMES = new Set(['offset', 'skip', 'start', 'from'].map(normalizeParamName));
const PAGE_NAMES = new Set(['page', 'pageNumber', 'pageIndex'].map(normalizeParamName));
const CURSOR_NAMES = new Set(
  [
    'cursor', 'after', 'starting_after', 'next', 'pageToken', 'next_token', 'continuationToken',
  ].map(normalizeParamName),
);

/** Pull a header name out of prose, e.g. "the total comes back in `X-Content-Range`". */
export function extractProseHeader(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const match = /`(X-[A-Za-z0-9-]+)`/.exec(text) ?? /\b(X-[A-Za-z][A-Za-z0-9-]{2,})\b/.exec(text);
  return match?.[1];
}

/** What a paginated envelope looks like on the wire. */
export interface EnvelopeShape {
  /** Dotted path to the items array, e.g. `data`. */
  readonly itemsPath: string[];
  readonly cursorPath?: string[];
  readonly totalPath?: string[];
}

export interface CollectionAnalysis {
  readonly evidence: CollectionEvidence;
  /** Present when `evidence` is `'envelope'`. */
  readonly envelope?: EnvelopeShape;
}

/**
 * Classify the success response of an operation as a collection or not.
 *
 * Handles both shapes real APIs use: a bare array, and an envelope such as
 * `{ data: [...], next_cursor, has_more }`. Recognizing only bare arrays — as an earlier version
 * did — misses the entire cursor-paginated world, which is how most large APIs page.
 */
export function analyzeCollection(
  op: OperationView,
  resolveSchema: (ref: string) => Json | undefined,
): CollectionAnalysis {
  const success = op.responses.find(
    (r) => r.statusCode !== undefined && r.statusCode >= 200 && r.statusCode < 300,
  );
  if (success === undefined || !success.hasTypedSchema || success.schema === undefined) {
    return { evidence: 'unknown' };
  }

  let schema: JsonObject = success.schema;
  const ref = getString(schema, '$ref');
  if (ref !== undefined) {
    const target = resolveSchema(ref);
    if (!isObject(target)) return { evidence: 'unknown' };
    schema = target;
  }

  if (getString(schema, 'type') === 'array' || 'items' in schema) return { evidence: 'array' };

  const properties = getObject(schema, 'properties');
  if (properties === undefined) return { evidence: 'none' };

  const isArrayProperty = (value: Json | undefined): boolean =>
    isObject(value) && (getString(value, 'type') === 'array' || 'items' in value);

  // Prefer a conventionally-named items property; otherwise accept a lone array property, since
  // an envelope with exactly one array is unambiguous.
  const byNormalized = new Map(
    Object.keys(properties).map((key) => [normalizeParamName(key), key]),
  );
  const lookup = (candidates: readonly string[]): string | undefined => {
    for (const candidate of candidates) {
      const actual = byNormalized.get(normalizeParamName(candidate));
      if (actual !== undefined) return actual;
    }
    return undefined;
  };

  const namedKey = lookup(ITEMS_PROPERTIES);
  const named = namedKey !== undefined && isArrayProperty(properties[namedKey]) ? namedKey : undefined;
  const arrayKeys = Object.keys(properties).filter((key) => isArrayProperty(properties[key]));
  const itemsKey = named ?? (arrayKeys.length === 1 ? arrayKeys[0] : undefined);
  if (itemsKey === undefined) return { evidence: 'none' };

  const cursorKey = lookup(CURSOR_PROPERTIES);
  const totalKey = lookup(TOTAL_PROPERTIES);

  return {
    evidence: 'envelope',
    envelope: {
      itemsPath: [itemsKey],
      ...(cursorKey !== undefined ? { cursorPath: [cursorKey] } : {}),
      ...(totalKey !== undefined ? { totalPath: [totalKey] } : {}),
    },
  };
}

/** Back-compatible shorthand returning only the verdict. */
export function collectionEvidence(
  op: OperationView,
  resolveSchema: (ref: string) => Json | undefined,
): CollectionEvidence {
  return analyzeCollection(op, resolveSchema).evidence;
}

export function findPaginationCandidates(
  index: OperationIndex,
  resolveSchema: (ref: string) => Json | undefined = () => undefined,
): PaginationCandidate[] {
  const candidates: PaginationCandidate[] = [];
  for (const op of index.operations) {
    if (op.verb !== 'get') continue;
    const queryNames = op.parameters.filter((p) => p.location === 'query');
    const limit = queryNames.find((p) => LIMIT_NAMES.has(normalizeParamName(p.name)));
    if (limit === undefined) continue;
    const offset = queryNames.find((p) => OFFSET_NAMES.has(normalizeParamName(p.name)));
    const page = queryNames.find((p) => PAGE_NAMES.has(normalizeParamName(p.name)));
    const cursor = queryNames.find((p) => CURSOR_NAMES.has(normalizeParamName(p.name)));
    if (offset === undefined && page === undefined && cursor === undefined) continue;
    const collection = analyzeCollection(op, resolveSchema);

    // The total count is frequently documented in prose and never declared as a header.
    const prose = [limit.description, offset?.description, op.description]
      .filter((d): d is string => typeof d === 'string')
      .map(extractProseHeader)
      .find((h) => h !== undefined);

    candidates.push({
      operation: op,
      limitParam: limit.name,
      offsetParam: offset?.name,
      pageParam: page?.name,
      cursorParam: cursor?.name,
      proseTotalHeader: prose,
      evidence: collection.evidence,
      ...(collection.envelope !== undefined ? { envelope: collection.envelope } : {}),
    });
  }
  return candidates;
}

function diagnosePagination(
  index: OperationIndex,
  resolveSchema: (ref: string) => Json | undefined,
): Diagnostic[] {
  const candidates = findPaginationCandidates(index, resolveSchema);
  if (candidates.length === 0) return [];

  const isCollection = (c: PaginationCandidate): boolean =>
    c.evidence === 'array' || c.evidence === 'envelope';
  const confirmed = candidates.filter(isCollection);
  const unconfirmed = candidates.filter((c) => !isCollection(c));
  const diagnostics: Diagnostic[] = [];

  if (confirmed.length > 0) {
    const first = confirmed[0]!;
    const style =
      first.cursorParam !== undefined ? 'cursor' : first.pageParam !== undefined ? 'page' : 'offset';
    const totalHeader = confirmed.find((c) => c.proseTotalHeader !== undefined)?.proseTotalHeader;

    const fixLines = [
      'pagination:',
      '  default:',
      `    style: ${style}`,
      `    limit: ${first.limitParam}`,
    ];
    if (first.offsetParam !== undefined) fixLines.push(`    offset: ${first.offsetParam}`);
    if (first.pageParam !== undefined) fixLines.push(`    page: ${first.pageParam}`);
    if (first.cursorParam !== undefined) fixLines.push(`    cursor: ${first.cursorParam}`);
    // Envelope paths must appear in the fix, or the runtime has no way to find the items.
    const envelope = confirmed.find((c) => c.envelope !== undefined)?.envelope;
    if (envelope !== undefined) {
      fixLines.push(`    items: "body:${envelope.itemsPath.join('.')}"`);
      if (envelope.cursorPath !== undefined) {
        fixLines.push(`    cursorFrom: "body:${envelope.cursorPath.join('.')}"`);
      }
      if (envelope.totalPath !== undefined) {
        fixLines.push(`    total: "body:${envelope.totalPath.join('.')}"`);
      }
    }
    if (totalHeader !== undefined) fixLines.push(`    total: "header:${totalHeader}"`);

    const shape =
      envelope !== undefined
        ? `an envelope with items under \`${envelope.itemsPath.join('.')}\``
        : 'an array response';

    diagnostics.push({
      severity: 'warn',
      code: DIAGNOSTIC_CODES.PAGINATION_INFERRED,
      message: `${plural(confirmed.length, 'operation', ['returns', 'return'])} a collection with paging parameters but no declared pagination.`,
      detail: [
        `Inferred ${style} pagination from parameter names, corroborated by ${shape}.`,
        ...(totalHeader !== undefined
          ? [
              `Total count appears to arrive in \`${totalHeader}\`, mentioned in prose but not ` +
                'declared under `responses.headers`.',
            ]
          : []),
        'Without this, list methods return one page instead of an iterator.',
        ...truncate(
          confirmed.map((c) => `${c.operation.verb.toUpperCase()} ${c.operation.path}`),
          5,
        ),
      ],
      fix: fixLines.join('\n'),
      resolvedBy: ['pagination.default'],
      count: confirmed.length,
    });
  }

  if (unconfirmed.length > 0) {
    // Reported, not assumed. These accept paging parameters but give no evidence of returning
    // a collection, and guessing wrong here produces an iterator over a non-list.
    const unknown = unconfirmed.filter((c) => c.evidence === 'unknown');
    const single = unconfirmed.filter((c) => c.evidence === 'none');
    diagnostics.push({
      severity: 'info',
      code: DIAGNOSTIC_CODES.PAGINATION_UNRESOLVED,
      message: `${plural(unconfirmed.length, 'operation', ['accepts', 'accept'])} paging parameters but ${unconfirmed.length === 1 ? 'does' : 'do'} not appear to return a collection; not paginating ${unconfirmed.length === 1 ? 'it' : 'them'}.`,
      detail: [
        ...(unknown.length > 0
          ? [`${unknown.length} have no response schema, so collection-ness is undeterminable.`]
          : []),
        ...(single.length > 0 ? [`${single.length} return a single object.`] : []),
        'These usually mean a shared parameter block was applied to every operation.',
        ...truncate(
          unconfirmed.map(
            (c) =>
              `${c.operation.verb.toUpperCase()} ${c.operation.path}` +
              (c.operation.methodName !== undefined ? ` (${c.operation.methodName})` : ''),
          ),
          6,
        ),
      ],
      fix: [
        'pagination:',
        '  operations:',
        `    ${unconfirmed[0]!.operation.operationId ?? unconfirmed[0]!.operation.path}: none`,
        '    # …or name a scheme here if any of these really do paginate',
      ].join('\n'),
      count: unconfirmed.length,
    });
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// M003 — duplicated inline schemas
// ---------------------------------------------------------------------------

export function findDuplicateInlineSchemas(
  index: OperationIndex,
): Array<{ key: string; count: number; sample: JsonObject; pointers: string[] }> {
  const groups = new Map<string, { sample: JsonObject; pointers: string[] }>();
  for (const site of index.inlineSchemas) {
    const key = structuralKey(site.schema);
    const existing = groups.get(key);
    if (existing) existing.pointers.push(site.pointer);
    else groups.set(key, { sample: site.schema, pointers: [site.pointer] });
  }
  return [...groups]
    .filter(([, group]) => group.pointers.length > 1)
    .map(([key, group]) => ({ key, count: group.pointers.length, sample: group.sample, pointers: group.pointers }))
    .sort((a, b) => b.count - a.count);
}

function diagnoseDuplicateInline(index: OperationIndex): Diagnostic[] {
  const duplicates = findDuplicateInlineSchemas(index);
  if (duplicates.length === 0) return [];
  const totalSites = duplicates.reduce((sum, d) => sum + d.count, 0);
  const worst = duplicates[0]!;
  return [
    {
      severity: 'info',
      code: DIAGNOSTIC_CODES.STRUCTURAL_DEDUPE,
      message: `${plural(duplicates.length, 'inline schema shape', ['is', 'are'])} repeated across ${plural(totalSites, 'site')}; each becomes one named type.`,
      detail: [
        `Most repeated shape appears ${worst.count} times:`,
        ...truncate(worst.pointers, 4).map((p) => `  ${p}`),
      ],
      count: duplicates.length,
    },
  ];
}

// ---------------------------------------------------------------------------
// S002 — vendor extensions
// ---------------------------------------------------------------------------

function diagnoseVendorExtensions(index: OperationIndex, document: JsonObject): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const survey = surveyExtensions(document);

  const withGroup = index.operations.filter((op) => op.groupName !== undefined);
  const withMethod = index.operations.filter((op) => op.methodName !== undefined);

  if (withGroup.length > 0 || withMethod.length > 0) {
    const groups = new Set(withGroup.map((op) => op.groupName!));
    const keys = new Set(index.operations.flatMap((op) => op.nameKeys));
    const fromVendor = index.operations.some((op) => op.nameSource === 'vendor');
    diagnostics.push({
      severity: 'info',
      code: DIAGNOSTIC_CODES.VENDOR_EXTENSION_USED,
      message: `Reading SDK shape from spec extensions: ${withGroup.length}/${index.operations.length} operations grouped, ${withMethod.length} named.`,
      detail: [
        `Keys used: ${[...keys].sort().join(', ')}`,
        `${groups.size} resource groups: ${truncate([...groups].sort(), 8).join(', ')}`,
        ...(fromVendor
          ? [
              `These are another generator’s extensions. ${BRAND.title} honours them because they state the`,
              'API owner’s intent, which does not stop being true for having been written for a',
              `different tool. \`${BRAND.extensionPrefix}-*\` and \`${BRAND.configFile}\` both take precedence.`,
            ]
          : []),
      ],
    });
  }

  const ignored = index.operations.filter((op) => op.ignored);
  if (ignored.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: DIAGNOSTIC_CODES.VENDOR_EXTENSION_USED,
      message: `${plural(ignored.length, 'operation', ['is', 'are'])} excluded from the SDK by an extension.`,
      detail: truncate(
        ignored.map((op) => `${op.verb.toUpperCase()} ${op.path}`),
        6,
      ),
      count: ignored.length,
    });
  }

  if (survey.unhandled.size > 0) {
    // Saying nothing here would let a spec author believe an annotation took effect. Their
    // semantics differ enough between vendors that guessing would produce a wrong SDK.
    diagnostics.push({
      severity: 'warn',
      code: DIAGNOSTIC_CODES.VENDOR_EXTENSION_USED,
      message: `${plural(survey.unhandled.size, 'extension', ['is', 'are'])} recognized but not acted on.`,
      detail: [...survey.unhandled]
        .sort()
        .map(([key, count]) => `${key} (${count}×) → configure via ${UNHANDLED_EXTENSIONS[key]}`),
      count: survey.unhandled.size,
    });
  }

  if (survey.unknown.size > 0) {
    const listed = [...survey.unknown].sort((a, b) => b[1] - a[1]);
    diagnostics.push({
      severity: 'info',
      code: DIAGNOSTIC_CODES.VENDOR_EXTENSION_USED,
      message: `${plural(survey.unknown.size, 'extension', ['was', 'were'])} not recognized and ignored.`,
      detail: [
        ...truncate(listed.map(([key, count]) => `${key} (${count}×)`), 8),
        `Harmless, but a typo in an \`${BRAND.extensionPrefix}-*\` key would look exactly like this.`,
      ],
      count: survey.unknown.size,
    });
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface AnalysisSummary {
  readonly operationCount: number;
  readonly resourceCount: number;
  readonly namedSchemaCount: number;
  readonly inlineSchemaCount: number;
}

export interface AnalysisResult {
  readonly summary: AnalysisSummary;
  readonly diagnostics: Diagnostic[];
}

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const;

export function analyze(resolved: ResolvedSpec, index: OperationIndex): AnalysisResult {
  const groups = new Set<string>();
  for (const op of index.operations) groups.add(resourceGroupOf(op));

  const diagnostics = [
    ...diagnoseReadWriteConflation(index),
    ...diagnoseErrorSchemas(index),
    ...diagnoseOptionality(resolved),
    ...diagnosePagination(index, resolved.resolve),
    ...diagnoseEmptySchemas(index),
    ...diagnoseUnions(resolved.spec.document),
    ...diagnoseConstantHeaders(index),
    ...diagnoseDuplicateInline(index),
    ...diagnoseVendorExtensions(index, resolved.spec.document),
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    summary: {
      operationCount: index.operations.length,
      resourceCount: groups.size,
      namedSchemaCount: resolved.schemas.size,
      inlineSchemaCount: index.inlineSchemas.length,
    },
    diagnostics,
  };
}

/** Convenience: everything `besdk check` needs, from a loaded spec. */
export function checkSpec(
  resolved: ResolvedSpec,
  index: OperationIndex,
  carried: readonly Diagnostic[] = [],
): AnalysisResult {
  const result = analyze(resolved, index);
  return {
    summary: result.summary,
    diagnostics: [...carried, ...result.diagnostics].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    ),
  };
}

export { entriesOf };
