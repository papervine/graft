/**
 * Safe access into an untrusted spec document.
 *
 * Deliberately *not* a validated model. Real specs violate OpenAPI in ways that must be
 * absorbed rather than rejected (SPEC.md §3.1: "Absorb real-world spec violations without
 * crashing"), so the loader keeps the document as plain JSON and every read goes through a
 * guard. A strict up-front parse would fail on exactly the specs graft exists to handle.
 *
 * The tradeoff is accepted knowingly: verbosity here buys tolerance at the edges.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isArray(value: unknown): value is Json[] {
  return Array.isArray(value);
}

/** Read a string property, or `undefined` if absent or the wrong type. */
export function getString(source: unknown, key: string): string | undefined {
  if (!isObject(source)) return undefined;
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

export function getNumber(source: unknown, key: string): number | undefined {
  if (!isObject(source)) return undefined;
  const value = source[key];
  return typeof value === 'number' ? value : undefined;
}

export function getBoolean(source: unknown, key: string): boolean | undefined {
  if (!isObject(source)) return undefined;
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function getObject(source: unknown, key: string): JsonObject | undefined {
  if (!isObject(source)) return undefined;
  const value = source[key];
  return isObject(value) ? value : undefined;
}

export function getArray(source: unknown, key: string): Json[] | undefined {
  if (!isObject(source)) return undefined;
  const value = source[key];
  return isArray(value) ? value : undefined;
}

/**
 * Entries of an object property, or `[]`. Convenient for the many
 * `Record<string, Something>` shapes in OpenAPI (`paths`, `properties`, `responses`).
 */
export function entriesOf(source: unknown, key: string): Array<[string, Json]> {
  const obj = getObject(source, key);
  return obj ? Object.entries(obj) : [];
}

// ---------------------------------------------------------------------------
// JSON pointers (RFC 6901)
// ---------------------------------------------------------------------------

/** Escape a single path segment for inclusion in a JSON pointer. */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function pointer(...segments: Array<string | number>): string {
  if (segments.length === 0) return '#';
  return `#/${segments.map((s) => escapePointerSegment(String(s))).join('/')}`;
}

/**
 * Resolve a local JSON pointer against a document root.
 *
 * Only same-document pointers are supported; external `$ref` targets return `undefined` so
 * the caller can report them rather than silently producing a broken type.
 */
export function resolvePointer(root: Json, ref: string): Json | undefined {
  if (!ref.startsWith('#')) return undefined;
  const path = ref.slice(1);
  if (path === '' || path === '/') return root;
  if (!path.startsWith('/')) return undefined;

  let current: Json = root;
  for (const rawSegment of path.slice(1).split('/')) {
    const segment = unescapePointerSegment(rawSegment);
    if (isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index] as Json;
    } else if (isObject(current)) {
      if (!(segment in current)) return undefined;
      current = current[segment] as Json;
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Structural hash of a JSON value, with object keys sorted so key order does not affect the
 * result. Backs `structuralDedupe` (SPEC.md §3.1.2) — the first corpus entry repeats an
 * identical inline `{error: string}` schema four times instead of naming it once.
 */
export function structuralKey(value: Json): string {
  if (value === null) return 'null';
  if (isArray(value)) return `[${value.map(structuralKey).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${structuralKey(value[k] as Json)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
