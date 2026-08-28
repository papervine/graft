/**
 * Error taxonomy.
 *
 * Hand-written, and shaped by what callers actually do with errors:
 *
 *   - `instanceof` is the idiomatic TypeScript check, so the hierarchy is real classes rather
 *     than a tagged union or an error-code enum.
 *   - Narrowing by status is common (`err.status === 409`), so `status` is on the base and
 *     literal-typed on each subclass. `catch (err) { if (err instanceof NotFoundError) }`
 *     needs no cast.
 *   - Connection failures are errors too, but they have no status. They get their own branch
 *     so `status` can stay `number` on everything that came back from a server.
 */

/**
 * Base for every error this SDK throws. Lets callers distinguish SDK from non-SDK failures.
 *
 * Named for the *role*, never for the generator that produced it. A generator-branded base class
 * would put the tool's name into every consumer's catch block, which makes renaming the tool a
 * breaking change for every SDK it ever produced. Generated code additionally re-exports this
 * under a brand-specific alias, the way `OpenAIError` names the same idea.
 */
export class SDKError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) this.cause = options.cause;
    // Required for `instanceof` to survive compilation down to ES5 targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** An error the server returned. Always carries a status. */
export class APIError<TBody = unknown> extends SDKError {
  /** HTTP status code. */
  readonly status: number;
  /** Response headers, for rate-limit inspection and request correlation. */
  readonly headers: Headers;
  /** Parsed response body, when the server sent one this SDK could decode. */
  readonly body: TBody;
  /** Value of `x-request-id`, when present. Worth quoting in a support ticket. */
  readonly requestId: string | undefined;

  constructor(status: number, body: TBody, headers: Headers, message?: string) {
    super(message ?? APIError.defaultMessage(status, body));
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.requestId = headers.get('x-request-id') ?? undefined;
  }

  private static defaultMessage(status: number, body: unknown): string {
    // Prefer the server's own words, and *only* those words. Most APIs put them in one of a few
    // well-known places.
    //
    // The status is deliberately **not** prefixed. It used to be — `404 Organisation not found` —
    // and the cross-language conformance suite caught the divergence: the Python and Go runtimes
    // keep `message` as what the server said and add the status when *rendering* the error. Three
    // SDKs from one spec have to agree on what `message` means, and the server's message is the
    // honest answer: the status is already on `.status`, and duplicating it made a caller who logs
    // both print it twice.
    //
    // The class name carries the status for a reader — `NotFoundError: Organisation not found` — so
    // nothing is lost in a stack trace.
    return extractMessage(body) ?? `HTTP ${status}`;
  }
}

/** Pull a human-readable message out of an error body without assuming its shape. */
function extractMessage(body: unknown): string | undefined {
  if (typeof body === 'string' && body.trim() !== '') return body.trim();
  if (body === null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'error_description', 'title']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    // `{ error: { message: … } }` is common enough to be worth one level of recursion.
    if (value !== null && typeof value === 'object') {
      const nested = extractMessage(value);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export class BadRequestError<TBody = unknown> extends APIError<TBody> {
  override readonly status = 400 as const;
}
export class AuthenticationError<TBody = unknown> extends APIError<TBody> {
  override readonly status = 401 as const;
}
export class PermissionDeniedError<TBody = unknown> extends APIError<TBody> {
  override readonly status = 403 as const;
}
export class NotFoundError<TBody = unknown> extends APIError<TBody> {
  override readonly status = 404 as const;
}
export class ConflictError<TBody = unknown> extends APIError<TBody> {
  override readonly status = 409 as const;
}
export class UnprocessableEntityError<TBody = unknown> extends APIError<TBody> {
  override readonly status = 422 as const;
}

export class RateLimitError<TBody = unknown> extends APIError<TBody> {
  override readonly status = 429 as const;

  /** Seconds to wait, from `retry-after`, when the server said so. */
  get retryAfterSeconds(): number | undefined {
    return parseRetryAfter(this.headers);
  }
}

export class InternalServerError<TBody = unknown> extends APIError<TBody> {}

/** The request never completed: DNS failure, connection reset, offline. No status exists. */
export class APIConnectionError extends SDKError {
  constructor(message = 'Connection error', options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class APIConnectionTimeoutError extends APIConnectionError {
  constructor(message = 'Request timed out') {
    super(message);
  }
}

/** The caller aborted via their own `AbortSignal`. Distinct from a timeout. */
export class APIUserAbortError extends SDKError {
  constructor(message = 'Request was aborted') {
    super(message);
  }
}

/** Parse `retry-after`, which may be seconds or an HTTP date. */
export function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, (date - Date.now()) / 1000);
}

/** Construct the most specific error class for a status. */
export function errorFromStatus(status: number, body: unknown, headers: Headers): APIError {
  switch (status) {
    case 400:
      return new BadRequestError(status, body, headers);
    case 401:
      return new AuthenticationError(status, body, headers);
    case 403:
      return new PermissionDeniedError(status, body, headers);
    case 404:
      return new NotFoundError(status, body, headers);
    case 409:
      return new ConflictError(status, body, headers);
    case 422:
      return new UnprocessableEntityError(status, body, headers);
    case 429:
      return new RateLimitError(status, body, headers);
    default:
      return status >= 500
        ? new InternalServerError(status, body, headers)
        : new APIError(status, body, headers);
  }
}

/**
 * Type guard for anything this SDK threw from a server response.
 *
 * Provided alongside `instanceof` because a bundler duplicating the runtime can break
 * `instanceof` across module instances, and because it narrows cleanly from `unknown` in a
 * `catch` block without a cast.
 */
export function isAPIError(value: unknown): value is APIError {
  return value instanceof APIError;
}

export function isSDKError(value: unknown): value is SDKError {
  return value instanceof SDKError;
}
