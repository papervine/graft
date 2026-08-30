/**
 * Vendor extensions — `x-graft-*` and other generators' equivalents.
 *
 * **Why extensions exist at all.** A spec cannot say "group these operations under `users`",
 * "this endpoint paginates by cursor", or "the server assigns this field". That information has to
 * come from somewhere, and every serious generator invented extensions for it. So did we.
 *
 * **Why we read other vendors' extensions.** `x-fern-sdk-method-name: list` is the API owner
 * stating, unambiguously, that they want this method called `list`. That intent does not stop
 * being true because it was written for a different generator. Ignoring it would make graft
 * produce worse names than the spec already asks for, and would force a migrating user to
 * re-annotate a spec that is already annotated.
 *
 * **Extensions and config serve different owners**, which is why graft supports both:
 *   - If you own the spec, annotating it is natural and the intent travels with the API.
 *   - If you are generating from someone else's spec you cannot edit it, so config is the only
 *     option.
 *
 * Precedence, therefore:
 *
 *   1. `graft.yaml`      — the consumer's explicit override, closest to the person running graft
 *   2. `x-graft-*`       — the spec owner's explicit intent *for graft*
 *   3. other vendors' `x-*` — the spec owner's intent for *some* generator; still intent
 *   4. inference         — graft guessing
 *
 * **An extension we half-understand is worse than one we ignore**, because the user assumes it was
 * applied. Simple naming keys are read confidently. Complex nested ones whose semantics differ
 * between vendors (pagination configs, most notably) are *reported as unhandled* rather than
 * guessed at — see {@link UNHANDLED_EXTENSIONS}.
 */

import { BRAND, extensionKey } from '@graft/protocol';
import { getBoolean, getObject, getString, isObject, type Json, type JsonObject } from './json.js';

/** Which layer supplied a value. Reported so a surprising name can be traced to its source. */
export type HintSource = 'own' | 'vendor' | 'inferred';

export interface Hint<T> {
  readonly value: T;
  readonly source: HintSource;
  /** The extension key that supplied it, for diagnostics. */
  readonly key: string;
}

/**
 * Keys read for each concept, in precedence order within their tier.
 *
 * Only keys whose meaning is unambiguous appear here. A key that means something subtly different
 * in its own generator does not belong — see {@link UNHANDLED_EXTENSIONS}.
 */
const OPERATION_KEYS = {
  group: {
    own: [extensionKey('group')],
    vendor: ['x-fern-sdk-group-name', 'x-speakeasy-group'],
  },
  method: {
    own: [extensionKey('method')],
    vendor: ['x-fern-sdk-method-name', 'x-speakeasy-name-override'],
  },
} as const;

/**
 * Boolean keys meaning "leave this out of the SDK".
 *
 * `x-internal` is not a generator extension at all — it is a widely-used convention (Redocly and
 * others) for "do not publish this". Honoring it is what the spec author expects.
 */
const IGNORE_KEYS = {
  own: [extensionKey('ignore')],
  vendor: ['x-fern-ignore', 'x-speakeasy-ignore', 'x-internal'],
} as const;

/** Keys marking a property as assigned by the server. */
const SERVER_OWNED_KEYS = {
  own: [extensionKey('server-owned')],
  vendor: [] as readonly string[],
} as const;

/** Keys renaming a schema. */
const SCHEMA_NAME_KEYS = {
  own: [extensionKey('name')],
  vendor: [] as readonly string[],
} as const;

/**
 * Extensions graft recognizes but does not act on.
 *
 * Reported rather than silently ignored: a spec author who wrote `x-fern-pagination` reasonably
 * expects *some* pagination to happen, and saying nothing lets them believe it did. Their
 * semantics vary enough between vendors that mapping them without care would produce a
 * confidently wrong SDK, so the honest move is to name them and point at the config equivalent.
 */
export const UNHANDLED_EXTENSIONS: Record<string, string> = {
  'x-fern-pagination': 'pagination.default / pagination.operations',
  'x-speakeasy-pagination': 'pagination.default / pagination.operations',
  'x-fern-sdk-return-value': `not supported; ${BRAND.title} returns the whole response body`,
  'x-fern-examples': 'examples are generated from the spec’s own `example` fields',
  'x-speakeasy-retries': 'retries are a runtime concern; configure them on the client',
  'x-speakeasy-usage-example': 'examples are generated automatically',
  'x-fern-audiences': 'not supported',
  'x-speakeasy-max-method-params': 'not supported',
};

function readString(node: JsonObject, keys: readonly string[], source: HintSource): Hint<string> | undefined {
  for (const key of keys) {
    const value = getString(node, key);
    if (value !== undefined && value.trim() !== '') {
      return { value: value.trim(), source, key };
    }
  }
  return undefined;
}

function readBoolean(node: JsonObject, keys: readonly string[], source: HintSource): Hint<boolean> | undefined {
  for (const key of keys) {
    const value = getBoolean(node, key);
    if (value !== undefined) return { value, source, key };
  }
  return undefined;
}

/** Read a string hint honoring the own-before-vendor tier order. */
function tieredString(
  node: JsonObject,
  keys: { own: readonly string[]; vendor: readonly string[] },
): Hint<string> | undefined {
  return readString(node, keys.own, 'own') ?? readString(node, keys.vendor, 'vendor');
}

function tieredBoolean(
  node: JsonObject,
  keys: { own: readonly string[]; vendor: readonly string[] },
): Hint<boolean> | undefined {
  return readBoolean(node, keys.own, 'own') ?? readBoolean(node, keys.vendor, 'vendor');
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Pagination declared inline on an operation via `x-graft-pagination`. */
export interface PaginationHint {
  /** `'none'` disables pagination for an operation that merely accepts paging parameters. */
  readonly disabled: boolean;
  readonly style?: 'offset' | 'cursor' | 'page';
  readonly limit?: string;
  readonly offset?: string;
  readonly page?: string;
  readonly cursor?: string;
  readonly items?: string;
  readonly cursorFrom?: string;
  readonly total?: string;
}

export interface OperationExtensions {
  readonly group: Hint<string> | undefined;
  readonly method: Hint<string> | undefined;
  readonly ignore: Hint<boolean> | undefined;
  readonly pagination: Hint<PaginationHint> | undefined;
}

const PAGINATION_STYLES = new Set(['offset', 'cursor', 'page']);

function readPaginationHint(node: JsonObject): Hint<PaginationHint> | undefined {
  for (const key of [extensionKey('pagination')]) {
    const raw = node[key];
    if (raw === undefined) continue;
    if (raw === 'none' || raw === false) {
      return { value: { disabled: true }, source: 'own', key };
    }
    if (!isObject(raw)) continue;
    const style = getString(raw, 'style');
    const value: PaginationHint = {
      disabled: false,
      ...(style !== undefined && PAGINATION_STYLES.has(style)
        ? { style: style as PaginationHint['style'] }
        : {}),
      ...pick(raw, 'limit', 'offset', 'page', 'cursor', 'items', 'cursorFrom', 'total'),
    };
    return { value, source: 'own', key };
  }
  return undefined;
}

function pick(node: JsonObject, ...keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = getString(node, key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function readOperationExtensions(operation: JsonObject): OperationExtensions {
  return {
    group: tieredString(operation, OPERATION_KEYS.group),
    method: tieredString(operation, OPERATION_KEYS.method),
    ignore: tieredBoolean(operation, IGNORE_KEYS),
    pagination: readPaginationHint(operation),
  };
}

// ---------------------------------------------------------------------------
// Schemas and properties
// ---------------------------------------------------------------------------

export interface SchemaExtensions {
  readonly name: Hint<string> | undefined;
  readonly ignore: Hint<boolean> | undefined;
}

export function readSchemaExtensions(schema: JsonObject): SchemaExtensions {
  return {
    name: tieredString(schema, SCHEMA_NAME_KEYS),
    ignore: tieredBoolean(schema, IGNORE_KEYS),
  };
}

export interface PropertyExtensions {
  /**
   * Whether the server assigns this field.
   *
   * The single most valuable thing an extension can express: it is what graft cannot infer, and
   * the API owner knows it for certain. Marking it in the spec beats listing field names in
   * config because it lives next to the field and cannot drift.
   */
  readonly serverOwned: Hint<boolean> | undefined;
  readonly ignore: Hint<boolean> | undefined;
}

export function readPropertyExtensions(property: JsonObject): PropertyExtensions {
  return {
    serverOwned: tieredBoolean(property, SERVER_OWNED_KEYS),
    ignore: tieredBoolean(property, IGNORE_KEYS),
  };
}

// ---------------------------------------------------------------------------
// Surveying a whole document
// ---------------------------------------------------------------------------

export interface ExtensionUsage {
  /** Extension key → how many nodes carry it. */
  readonly used: ReadonlyMap<string, number>;
  /** Recognized but unacted-on keys, with the config setting that would work instead. */
  readonly unhandled: ReadonlyMap<string, number>;
  /** `x-*` keys graft does not recognize at all, so the user can spot a typo. */
  readonly unknown: ReadonlyMap<string, number>;
}

const HANDLED_KEYS = new Set<string>([
  ...OPERATION_KEYS.group.own,
  ...OPERATION_KEYS.group.vendor,
  ...OPERATION_KEYS.method.own,
  ...OPERATION_KEYS.method.vendor,
  ...IGNORE_KEYS.own,
  ...IGNORE_KEYS.vendor,
  ...SERVER_OWNED_KEYS.own,
  ...SCHEMA_NAME_KEYS.own,
  extensionKey('pagination'),
  // Read elsewhere, but recognized so they are not reported as unknown.
  'x-fern-server-name',
  extensionKey('server-name'),
  extensionKey('client-name'),
]);

/** Walk every node, counting `x-` keys by how graft treats them. */
export function surveyExtensions(document: Json): ExtensionUsage {
  const used = new Map<string, number>();
  const unhandled = new Map<string, number>();
  const unknown = new Map<string, number>();

  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  const walk = (node: Json): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('x-')) {
        if (HANDLED_KEYS.has(key)) bump(used, key);
        else if (key in UNHANDLED_EXTENSIONS) bump(unhandled, key);
        else bump(unknown, key);
      }
      walk(value as Json);
    }
  };

  walk(document);
  return { used, unhandled, unknown };
}

/** Every `x-graft-*` key graft understands, for `--help` and documentation. */
export function supportedExtensions(): Array<{ key: string; where: string; description: string }> {
  return [
    { key: extensionKey('group'), where: 'operation', description: 'Resource to group under; dotted for nesting (`orgs.invoices`).' },
    { key: extensionKey('method'), where: 'operation', description: 'Method name.' },
    { key: extensionKey('ignore'), where: 'operation, schema, property', description: 'Leave it out of the SDK.' },
    { key: extensionKey('pagination'), where: 'operation', description: '`none`, or `{ style, limit, offset, cursor, items, cursorFrom, total }`.' },
    { key: extensionKey('name'), where: 'schema', description: 'Rename the generated type.' },
    { key: extensionKey('server-owned'), where: 'property', description: 'The server assigns this field, so it is omitted from write models.' },
    { key: extensionKey('server-name'), where: 'server', description: 'Name for this server entry.' },
    { key: extensionKey('client-name'), where: 'document root', description: 'Name of the generated client class. Overridden by `name` in graft.yaml.' },
  ];
}

export { getObject };
