/**
 * A flat, uniform view of the operations in a spec.
 *
 * OpenAPI scatters what an SDK needs across `paths`, path-level vs operation-level
 * `parameters`, `requestBody.content.<media-type>`, and per-status `responses`. Every analysis
 * and every normalizer rule would otherwise re-walk that structure and disagree slightly about
 * edge cases. This module walks it exactly once.
 *
 * Still spec-shaped, not IR-shaped — this is an *indexing* convenience, not the semantic model.
 */

import {
  entriesOf,
  getArray,
  getBoolean,
  getObject,
  getString,
  isObject,
  pointer,
  type Json,
  type JsonObject,
} from './json.js';
import { componentSchemaName, walkRefs } from './resolve.js';
import { readOperationExtensions, type HintSource, type PaginationHint } from './extensions.js';
import type { LoadedSpec } from './load.js';

export const HTTP_VERBS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export type HttpVerbName = (typeof HTTP_VERBS)[number];

/** Where a schema was used. Drives read/write conflation detection (SPEC.md §3.1.1). */
export type SchemaPosition = 'request' | 'response';

export interface ParameterView {
  readonly name: string;
  readonly location: string;
  readonly required: boolean;
  readonly description: string | undefined;
  readonly schema: JsonObject | undefined;
  /** A `default` on the schema, when present — used to spot constant headers. */
  readonly defaultValue: Json | undefined;
  readonly pointer: string;
}

export interface BodyView {
  readonly contentType: string;
  readonly required: boolean;
  readonly schema: JsonObject | undefined;
  /** Component schema names referenced from this body. */
  readonly schemaRefs: readonly string[];
  readonly pointer: string;
}

export interface ResponseView {
  /** `'200'`, `'default'`, etc. — verbatim, since specs use both numbers and `default`. */
  readonly status: string;
  readonly statusCode: number | undefined;
  readonly description: string | undefined;
  /** True when the response declares a content object at all. */
  readonly hasContent: boolean;
  /** True when it declares content whose schema is meaningfully typed. */
  readonly hasTypedSchema: boolean;
  readonly contentType: string | undefined;
  readonly schema: JsonObject | undefined;
  readonly schemaRefs: readonly string[];
  readonly pointer: string;
}

export interface OperationView {
  readonly path: string;
  readonly verb: HttpVerbName;
  readonly operationId: string | undefined;
  readonly summary: string | undefined;
  readonly description: string | undefined;
  readonly deprecated: boolean;
  readonly tags: readonly string[];
  /** Resource group from an extension, when one declares it (SPEC.md §3.1.5). */
  readonly groupName: string | undefined;
  /** Method name from an extension, when one declares it. */
  readonly methodName: string | undefined;
  /** Which extension tier supplied `groupName`/`methodName`, for reporting. */
  readonly nameSource: HintSource | undefined;
  /** Extension keys that supplied the names, for reporting. */
  readonly nameKeys: readonly string[];
  /** True when an extension asks for this operation to be left out of the SDK. */
  readonly ignored: boolean;
  /** Inline pagination declared by `x-graft-pagination`. */
  readonly paginationHint: PaginationHint | undefined;
  readonly parameters: readonly ParameterView[];
  readonly body: BodyView | undefined;
  readonly responses: readonly ResponseView[];
  readonly pointer: string;
}

/** A schema that appears inline rather than as a named component. */
export interface InlineSchemaSite {
  readonly pointer: string;
  readonly schema: JsonObject;
  readonly position: SchemaPosition;
}

export interface OperationIndex {
  readonly operations: readonly OperationView[];
  /** Component schema name → the set of positions it was used in. */
  readonly schemaPositions: ReadonlyMap<string, ReadonlySet<SchemaPosition>>;
  readonly inlineSchemas: readonly InlineSchemaSite[];
}

function isHttpVerb(key: string): key is HttpVerbName {
  return (HTTP_VERBS as readonly string[]).includes(key);
}

/**
 * A schema is "meaningfully typed" when it says something a generator can act on. `{}` says
 * nothing (SPEC.md §3.1.2 `emptySchema`), and neither does a node carrying only annotations.
 */
export function hasTypeInformation(schema: Json | undefined): boolean {
  if (!isObject(schema)) return false;
  const meaningful = [
    '$ref',
    'type',
    'properties',
    'items',
    'oneOf',
    'anyOf',
    'allOf',
    'not',
    'enum',
    'const',
    'additionalProperties',
    'patternProperties',
    'prefixItems',
    'format',
  ];
  return meaningful.some((key) => key in schema);
}

/**
 * Segments that version or namespace an API rather than naming a resource.
 *
 * Matches `v1`, `v2beta`, `2010-04-01`, and bare `api`/`rest` prefixes.
 */
function isVersionSegment(segment: string): boolean {
  if (/^v\d+([._-]?\d+)*[a-z]*\d*$/i.test(segment)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(segment)) return true;
  return ['api', 'rest', 'apis', 'public', 'openapi'].includes(segment.toLowerCase());
}

/** Resource name inferred from a path: the first segment that names something. */
export function resourceFromPath(path: string): string {
  for (const segment of path.split('/')) {
    if (segment === '' || segment.startsWith('{') || isVersionSegment(segment)) continue;
    const cleaned = segment.replace(/\.[A-Za-z0-9]+$/, '');
    if (cleaned !== '') return cleaned;
  }
  return 'default';
}

/**
 * The resource an operation belongs to, before any config rename.
 *
 * **The single definition.** `check` and `generate` previously each decided this, and they drifted:
 * after the path fallback learned to skip version prefixes, `check` still reported Stripe as one
 * resource while `generate` produced seventy-six. Two implementations of one decision always drift.
 */
export function resourceGroupOf(op: OperationView): string {
  return op.groupName ?? op.tags[0] ?? resourceFromPath(op.path);
}

/** `{ type: array, items: { $ref: … } }` — a wrapper around a named type, not a new type. */
export function isArrayOfRef(schema: JsonObject): boolean {
  if (getString(schema, 'type') !== 'array') return false;
  const items = getObject(schema, 'items');
  if (items === undefined) return false;
  return getString(items, '$ref') !== undefined && Object.keys(items).length === 1;
}

function collectSchemaRefs(node: Json | undefined): string[] {
  if (node === undefined) return [];
  const names = new Set<string>();
  for (const { ref } of walkRefs(node)) {
    const name = componentSchemaName(ref);
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

function readParameters(
  container: JsonObject | undefined,
  basePointer: string,
  resolve: (ref: string) => Json | undefined,
): ParameterView[] {
  const raw = getArray(container, 'parameters') ?? [];
  const result: ParameterView[] = [];
  raw.forEach((entry, index) => {
    let param = entry;
    // A parameter can itself be a `$ref` into `components/parameters`.
    const ref = getString(param, '$ref');
    if (ref !== undefined) {
      const target = resolve(ref);
      if (isObject(target)) param = target;
    }
    if (!isObject(param)) return;
    const name = getString(param, 'name');
    const location = getString(param, 'in');
    if (name === undefined || location === undefined) return;
    const schema = getObject(param, 'schema');
    result.push({
      name,
      location,
      required: getBoolean(param, 'required') ?? false,
      description: getString(param, 'description'),
      schema,
      defaultValue: schema && 'default' in schema ? (schema['default'] as Json) : undefined,
      pointer: `${basePointer}/parameters/${index}`,
    });
  });
  return result;
}

/**
 * Pick the media type to model. JSON wins when offered; otherwise the first entry, so a
 * JSON-plus-legacy-XML endpoint does not get modelled as XML.
 */
function selectContent(content: JsonObject | undefined): [string, JsonObject] | undefined {
  if (content === undefined) return undefined;
  const entries = Object.entries(content).filter((entry): entry is [string, JsonObject] =>
    isObject(entry[1]),
  );
  if (entries.length === 0) return undefined;
  const json = entries.find(([type]) => /\bjson\b/i.test(type));
  return json ?? entries[0];
}

export function indexOperations(
  spec: LoadedSpec,
  resolve: (ref: string) => Json | undefined,
): OperationIndex {
  const operations: OperationView[] = [];
  const schemaPositions = new Map<string, Set<SchemaPosition>>();
  const inlineSchemas: InlineSchemaSite[] = [];

  const notePosition = (names: readonly string[], position: SchemaPosition): void => {
    for (const name of names) {
      const set = schemaPositions.get(name) ?? new Set<SchemaPosition>();
      set.add(position);
      schemaPositions.set(name, set);
    }
  };

  const noteInline = (
    schema: JsonObject | undefined,
    at: string,
    position: SchemaPosition,
  ): void => {
    // Only count it as inline if it is not simply a reference to a named component.
    if (schema === undefined) return;
    if (getString(schema, '$ref') !== undefined) return;
    if (!hasTypeInformation(schema)) return;
    // An `array` whose `items` is a bare `$ref` is a wrapper, not an anonymous type: it needs
    // no synthesized name, and counting it would overstate how much naming work a spec
    // actually requires. `List<Asset>` is spelled by the target, not named by the normalizer.
    if (isArrayOfRef(schema)) return;
    inlineSchemas.push({ pointer: at, schema, position });
  };

  for (const [path, pathItemRaw] of entriesOf(spec.document, 'paths')) {
    if (!isObject(pathItemRaw)) continue;
    const pathPointer = pointer('paths', path);
    const sharedParameters = readParameters(pathItemRaw, pathPointer, resolve);

    for (const [key, operationRaw] of Object.entries(pathItemRaw)) {
      if (!isHttpVerb(key) || !isObject(operationRaw)) continue;
      const operationPointer = `${pathPointer}/${key}`;
      const extensions = readOperationExtensions(operationRaw);

      // Operation-level parameters override path-level ones with the same name+location.
      const own = readParameters(operationRaw, operationPointer, resolve);
      const ownKeys = new Set(own.map((p) => `${p.location}:${p.name}`));
      const parameters = [
        ...sharedParameters.filter((p) => !ownKeys.has(`${p.location}:${p.name}`)),
        ...own,
      ];

      let body: BodyView | undefined;
      const requestBody = getObject(operationRaw, 'requestBody');
      if (requestBody !== undefined) {
        const bodyPointer = `${operationPointer}/requestBody`;
        const selected = selectContent(getObject(requestBody, 'content'));
        const schema = selected ? getObject(selected[1], 'schema') : undefined;
        const schemaRefs = collectSchemaRefs(schema);
        notePosition(schemaRefs, 'request');
        noteInline(schema, `${bodyPointer}/content/${selected?.[0] ?? '?'}/schema`, 'request');
        body = {
          contentType: selected?.[0] ?? 'application/json',
          required: getBoolean(requestBody, 'required') ?? false,
          schema,
          schemaRefs,
          pointer: bodyPointer,
        };
      }

      const responses: ResponseView[] = [];
      for (const [status, responseRaw] of entriesOf(operationRaw, 'responses')) {
        if (!isObject(responseRaw)) continue;
        const responsePointer = `${operationPointer}/responses/${status}`;
        const content = getObject(responseRaw, 'content');
        const selected = selectContent(content);
        const schema = selected ? getObject(selected[1], 'schema') : undefined;
        const schemaRefs = collectSchemaRefs(schema);
        notePosition(schemaRefs, 'response');
        noteInline(schema, `${responsePointer}/content/${selected?.[0] ?? '?'}/schema`, 'response');
        const parsedStatus = Number(status);
        responses.push({
          status,
          statusCode: Number.isInteger(parsedStatus) ? parsedStatus : undefined,
          description: getString(responseRaw, 'description'),
          hasContent: content !== undefined,
          hasTypedSchema: hasTypeInformation(schema),
          contentType: selected?.[0],
          schema,
          schemaRefs,
          pointer: responsePointer,
        });
      }

      operations.push({
        path,
        verb: key,
        operationId: getString(operationRaw, 'operationId'),
        summary: getString(operationRaw, 'summary'),
        description: getString(operationRaw, 'description'),
        deprecated: getBoolean(operationRaw, 'deprecated') ?? false,
        tags: (getArray(operationRaw, 'tags') ?? []).filter(
          (t): t is string => typeof t === 'string',
        ),
        groupName: extensions.group?.value,
        methodName: extensions.method?.value,
        nameSource: extensions.group?.source ?? extensions.method?.source,
        nameKeys: [extensions.group?.key, extensions.method?.key].filter(
          (key): key is string => key !== undefined,
        ),
        ignored: extensions.ignore?.value === true,
        paginationHint: extensions.pagination?.value,
        parameters,
        body,
        responses,
        pointer: operationPointer,
      });
    }
  }

  return { operations, schemaPositions, inlineSchemas };
}
