/**
 * Synthesize plausible example data for every operation, as language-neutral JSON.
 *
 * This is the shared half of examples and generated tests (SPEC.md §3.11). Deciding *what* value stands
 * for a field — the spec's own `example` when it has one, the first enum member, required fields before
 * optional ones — is a judgment every language makes identically, so it is made once here. Rendering it
 * into `{ name: 'Sprocket' }` or `{"name": "Sprocket"}` or `WidgetCreate.builder().name("Sprocket")` is
 * the target's job, and the only part that differs.
 *
 * The alternative — each target synthesizing from the type graph, which is what the TypeScript target did
 * alone — puts one decision in six places. That pattern has produced a bug every time it has appeared in
 * this project, and here the divergence would be *invisible*: a Python example picking a different enum
 * member than the TypeScript example is not a test failure, just two documents disagreeing.
 */

import type {
  IR,
  Method,
  MethodExample,
  NamedType,
  PaginationScheme,
  TypeRef,
} from '@graft/protocol';

/** JSON, as it would appear on the wire. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * How deep to descend into nested objects.
 *
 * Three levels covers every real example and terminates on a cyclic type without needing cycle detection
 * — a self-referencing schema is common enough (a comment with replies, a category with children) that
 * relying on the IR's cycle flags here would be one more thing to keep in step.
 */
const MAX_DEPTH = 3;

/** Fields to show when a schema declares nothing required. */
const UNREQUIRED_FIELD_LIMIT = 3;

/**
 * Optional fields to show at most, so a 40-field model does not produce an unreadable example.
 *
 * Applies **only** where nothing is required. A required field is never dropped: the same value feeds a
 * generated test, and the SDK validates its own responses — so truncating one produces a fixture that
 * fails validation with "revokedAt is required but was absent", which is the fixture being wrong rather
 * than the SDK. Found by running the generated suite against a 121-operation spec; the two operations whose
 * models had more than six required fields were the only two that failed.
 */
const FIELD_LIMIT = 6;

/**
 * Placeholders are deliberately unmistakable.
 *
 * `'...'` cannot be mistaken for a real id the way `507f1f77bcf86cd799439011` can, so a reader who copies
 * one and runs it gets an obvious failure rather than a subtle one. Formats that have an unambiguous
 * shape — a timestamp, an email — get a real-looking value instead, because `'...'` in a `date-time`
 * field would fail the SDK's own response validation and teach the wrong lesson.
 */
const PLACEHOLDER = '...';

function formatPlaceholder(format: string | undefined): string {
  switch (format) {
    case 'date-time':
      return '2024-01-01T00:00:00Z';
    case 'date':
      return '2024-01-01';
    case 'email':
      return 'you@example.com';
    case 'uri':
    case 'url':
      return 'https://example.com';
    case 'uuid':
      return '00000000-0000-0000-0000-000000000000';
    default:
      return PLACEHOLDER;
  }
}

/**
 * A value for one type reference.
 *
 * `specExample` wins whenever the spec supplied a scalar, because the API author's own example is better
 * than anything synthesized — they know what a real id looks like. Non-scalar spec examples are ignored:
 * they are frequently a whole response envelope attached to a field, and pasting one in produces an
 * example that does not typecheck.
 */
function valueFor(ir: IR, ref: TypeRef, specExample: unknown, depth: number): Json {
  if (
    specExample !== undefined &&
    (typeof specExample === 'string' ||
      typeof specExample === 'number' ||
      typeof specExample === 'boolean')
  ) {
    return specExample;
  }
  if (depth > MAX_DEPTH) return null;

  switch (ref.kind) {
    case 'primitive':
      if (ref.type === 'boolean') return true;
      if (ref.type === 'string') return formatPlaceholder(ref.format);
      // `1` rather than `0`: a zero limit or a zero page is a plausible *bug* in a copied example, and a
      // one is never one.
      return 1;
    case 'literal':
      return ref.value as Json;
    case 'array':
      // One element, not zero. An empty array exercises nothing — no decoding of the element type — and
      // a generated test asserting `items.length === 0` proves the SDK can parse `[]`.
      return [valueFor(ir, ref.items, undefined, depth + 1)];
    case 'map':
      return { key: valueFor(ir, ref.values, undefined, depth + 1) };
    case 'binary':
      return PLACEHOLDER;
    case 'nullable':
      // The present case, not null. A null teaches nothing about the shape and would make a generated
      // test assert that the SDK can decode an absence.
      return valueFor(ir, ref.inner, undefined, depth);
    case 'unknown':
      return {};
    case 'union': {
      const first = ref.variants[0];
      return first === undefined ? null : valueFor(ir, first, undefined, depth);
    }
    case 'named': {
      const type = ir.types.find((candidate) => candidate.id === ref.id);
      return type === undefined ? null : namedValueFor(ir, type, depth);
    }
    default:
      return null;
  }
}

function namedValueFor(ir: IR, type: NamedType, depth: number): Json {
  if (type.kind === 'enum') {
    const first = type.members[0];
    return first === undefined ? PLACEHOLDER : (first.wireValue as Json);
  }
  if (type.kind === 'alias') return valueFor(ir, type.target, undefined, depth + 1);

  // Required fields in preference to optional ones: a minimal valid payload is what a reader wants, and
  // listing forty optional fields buries the shape. But when nothing is required — the common case, since
  // most specs declare no `required` at all — an empty object teaches nothing, so show a few scalar
  // fields. The names come from the spec; only the values are synthesized.
  const required = type.fields.filter((field) => field.required);
  const shown =
    required.length > 0
      ? required
      : type.fields
          .filter((field) => field.type.kind === 'primitive')
          .slice(0, UNREQUIRED_FIELD_LIMIT);

  // Required fields in full; the cap is for the no-required-fields case only.
  const fields = required.length > 0 ? shown : shown.slice(0, FIELD_LIMIT);
  const out: { [key: string]: Json } = {};
  for (const field of fields) {
    out[field.wireName] = valueFor(ir, field.type, field.docs.example, depth + 1);
  }
  return out;
}

/**
 * Whether the method's response type declares the field at `path`, so a fixture may carry it.
 *
 * Only the single-segment case is answered, which is every real cursor placement; a nested one returns
 * false and the fixture simply omits the cursor, terminating anyway.
 */
function declaresField(ir: IR, method: Method, path: readonly string[]): boolean {
  if (path.length !== 1 || method.response.kind !== 'json') return false;
  const ref = method.response.type;
  if (ref.kind !== 'named') return false;
  const type = ir.types.find((candidate) => candidate.id === ref.id);
  if (type === undefined || type.kind !== 'object') return false;
  return type.fields.some((field) => field.wireName === path[0]);
}

/**
 * Force a paginated fixture to be the *last* page.
 *
 * `Method.response.type` for a paginated method is already the envelope the server returns — the first
 * version of this code assumed it was the item and wrapped it again, producing
 * `{data: [{data: [...], next_cursor: null}]}`: a shape no API returns, which a generated test would then
 * assert. Checked against the IR rather than remembered.
 *
 * What *is* needed is termination. `next_cursor` is declared nullable, and `valueFor` deliberately returns
 * the present case for a nullable — so the synthesized envelope carries a real cursor, and a generated
 * test draining the paginator would request a second page the fixture cannot serve. Nulling the cursor the
 * scheme actually names is the difference between a test that terminates and a test that hangs.
 *
 * Offset and page styles need nothing: the fixture holds one item, which is fewer than any limit the
 * example requests, and a short page is how those schemes detect the end.
 */
function lastPage(ir: IR, method: Method, value: Json, scheme: PaginationScheme): Json {
  const source = scheme.cursorSource;
  if (source?.kind !== 'body') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;

  // Walk to the parent of the cursor field, cloning as we go so the fixture is not shared structure.
  const out: { [key: string]: Json } = { ...value };
  let cursor = out;
  for (const segment of source.path.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return out;
    const copy: { [key: string]: Json } = { ...next };
    cursor[segment] = copy;
    cursor = copy;
  }
  const key = source.path[source.path.length - 1];
  if (key === undefined) return out;
  // Set it even when `namedValueFor` skipped it for being optional — which is the common case, since a
  // `next_cursor` is nullable by nature. An *absent* cursor and an explicit `null` terminate identically,
  // but only the explicit one tells a reader why the test asserts a single page. That matters when the
  // envelope also carries a `has_more`-style flag the scheme does not read: `has_more: true` beside nothing
  // reads as a bug in the SDK, and beside `next_cursor: null` reads as what it is, an API that offers two
  // signals of which graft uses the authoritative one.
  //
  // Guarded on the field being *declared*, because inventing one would make the fixture fail the SDK's own
  // response validation — a confusing way to learn about pagination.
  if (key in cursor || declaresField(ir, method, source.path)) cursor[key] = null;
  return out;
}

/** The response body a generated test should feed back, or undefined when there is nothing to decode. */
function responseFor(ir: IR, method: Method): Json | undefined {
  const response = method.response;
  switch (response.kind) {
    case 'json': {
      const value = valueFor(ir, response.type, undefined, 0);
      if (method.paginationId === undefined) return value;
      const scheme = ir.pagination.find((candidate) => candidate.id === method.paginationId);
      return scheme === undefined ? value : lastPage(ir, method, value, scheme);
    }
    case 'text':
      return PLACEHOLDER;
    // Empty, binary, and streamed responses have nothing a target could assert decoding on. Returning
    // undefined rather than a placeholder keeps `example.response !== undefined` a usable test for
    // "there is a body worth checking".
    default:
      return undefined;
  }
}

/**
 * Example data for one method.
 *
 * Path parameters are always included because a call cannot be made without them. Query and header
 * parameters are included only when required, so the example shows a minimal call — and so a generated
 * test can assert that an omitted optional parameter does not reach the wire, which is a real bug this
 * project has fixed once already.
 */
export function exampleFor(ir: IR, method: Method): MethodExample {
  const params: Record<string, unknown> = {};
  for (const param of method.http.params) {
    if (param.location !== 'path' && !param.required) continue;
    // A cookie parameter is not something a generated example should teach anyone to set by hand.
    if (param.location === 'cookie') continue;
    params[param.wireName] = valueFor(ir, param.type, param.docs.example, 0);
  }

  const body =
    method.body === undefined ? undefined : valueFor(ir, method.body.type, undefined, 0);
  const response = responseFor(ir, method);

  return {
    params,
    ...(body !== undefined ? { body } : {}),
    ...(response !== undefined ? { response } : {}),
  };
}

/**
 * Populate `example` on every method in the IR, in place of returning a parallel structure.
 *
 * Attached to the method rather than kept in a side table because a target reaching for an example
 * already has the method in hand, and a lookup by operation id is one more thing to get wrong.
 */
export function attachExamples(ir: IR): IR {
  const walk = (resources: IR['resources']): IR['resources'] =>
    resources.map((resource) => ({
      ...resource,
      methods: resource.methods.map((method) => ({ ...method, example: exampleFor(ir, method) })),
      subresources: walk(resource.subresources),
    }));
  return { ...ir, resources: walk(ir.resources) };
}
