/**
 * Wire-level coercions.
 *
 * These exist so that a server's serialization quirks never reach the caller's type. Each one
 * corresponds to a normalizer decision: the IR already declared the *intended* shape, and this
 * is where the wire value is bent to match it.
 */

/**
 * Coerce an empty-array-as-empty-map.
 *
 * Some servers — notably PHP ones, where `[]` is both an empty list and an empty associative
 * array — serialize an empty map as `[]` instead of `{}`. The IR models these as maps with
 * `emptyWireValue: 'array'` rather than as a union, precisely so that this one function absorbs
 * the quirk and callers write `Object.keys(x)` unconditionally forever after.
 *
 * A non-empty array is left alone and returned as-is: that would mean the server sent something
 * genuinely unexpected, and silently discarding data is worse than a type error downstream.
 */
export function mapFromWire<T>(value: unknown): Record<string, T> {
  if (Array.isArray(value)) {
    return value.length === 0 ? {} : (value as unknown as Record<string, T>);
  }
  if (value === null || value === undefined) return {};
  return value as Record<string, T>;
}

/** Parse a `Content-Range`-style total, e.g. `items 0-49/1275` or a bare `1275`. */
export function parseTotalCount(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const slash = raw.lastIndexOf('/');
  const candidate = slash >= 0 ? raw.slice(slash + 1) : raw;
  const total = Number(candidate.trim());
  return Number.isFinite(total) && total >= 0 ? total : undefined;
}

/** Read a dotted path out of a decoded body, for pagination metadata. */
export function valueAtPath(body: unknown, path: readonly string[]): unknown {
  let current: unknown = body;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
