/**
 * The HTTP transport.
 *
 * Everything generated code does eventually funnels through {@link BaseClient.request}. It is
 * hand-written because this is where SDK quality actually lives (SPEC.md §3.3) — retries,
 * timeouts, abort propagation, and query serialization are subtle, and a generator emitting
 * them per-endpoint would get them subtly wrong 121 times instead of right once.
 */

import { authHeaders, authQuery, type Auth } from './auth.js';
import { isAuthFailure, type TokenSource } from './oauth2.js';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  errorFromStatus,
  parseRetryAfter,
  type APIError,
} from './errors.js';
import { enforce, type Schema, type SchemaTable, type ValidationMode } from './validate.js';

/** A value usable as a query parameter. */
/**
 * A value usable as a query parameter. Documentary: see {@link InternalRequest.query} for why the
 * internal slot is typed loosely.
 *
 * Nested objects are included because OpenAPI's `style: deepObject` is widely used for range and
 * filter queries — Stripe spells `created[gte]=1699999999` that way.
 */
export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  // Recursive: real specs put arrays of objects in the query string (Box's search filters), not
  // only arrays of scalars.
  | ReadonlyArray<QueryValue>
  | { readonly [key: string]: QueryValue };

export interface RequestOptions {
  /** Abort the request from caller code. Composed with the client timeout. */
  readonly signal?: AbortSignal;
  /** Override the client's per-request timeout, in milliseconds. */
  readonly timeout?: number;
  /** Override the client's retry count for this call. */
  readonly maxRetries?: number;
  /** Extra headers, merged over the client defaults. */
  readonly headers?: Record<string, string>;
  /**
   * An idempotency key, which makes a `POST` or `PATCH` safe to retry.
   *
   * Without one, those methods are **not** retried: deduplication has to happen on the server, and a
   * client cannot make a replay safe by itself. Supply the same key to mean the same logical request —
   * one key per request, never one per attempt, or the server has nothing to recognise.
   */
  readonly idempotencyKey?: string;
  /**
   * Sent as `Last-Event-ID`, to resume a stream from the last event you processed.
   *
   * A request option rather than automatic behaviour: graft does not reconnect, deliberately. Nothing in
   * OpenAPI says whether replaying from an id yields the missed events or restarts the stream, and
   * reconnecting on that assumption silently duplicates or drops them (SPEC.md §3.4.1.2). Take the id from
   * `streamEvents()` and pass it here on the next call.
   */
  readonly lastEventId?: string;
}

export interface ClientOptions {
  /** Base URL. A trailing slash is tolerated. */
  readonly baseURL?: string;
  readonly auth?: Auth;
  /** Per-request timeout in milliseconds. Default 60_000. */
  readonly timeout?: number;
  /** Retry attempts *after* the first try. Default 2. */
  readonly maxRetries?: number;
  /** Headers sent on every request. Hoisted constants land here. */
  readonly defaultHeaders?: Record<string, string>;
  /** Injection point for tests and for runtimes with a non-global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * How strictly to enforce that responses match the shape the spec declared.
   *
   * `strict` (the default) throws a {@link ResponseValidationError} naming the offending field.
   * `warn` logs and continues. `off` skips the check entirely.
   *
   * Strict is the default because a missing required field crashes the caller either way — the only
   * question is whether they learn it at the SDK boundary, with the API's own violation named, or
   * three frames later in their own code. See SPEC.md §3.4.1.1.
   */
  readonly validation?: ValidationMode;
  /**
   * Header the API expects an idempotency key in. Defaults to {@link DEFAULT_IDEMPOTENCY_HEADER}.
   *
   * Configurable because it is not standardised; a generated client sets it from the spec's own
   * convention where `graft.yaml` names one.
   */
  readonly idempotencyHeader?: string;
}

/**
 * How to interpret a successful response body.
 *
 * Explicit rather than sniffed from `content-type`, because the IR already knows: the spec
 * declared it. Sniffing would make the return type depend on what the server happens to send.
 */
export type ResponseType = 'json' | 'text' | 'binary' | 'stream';

/** How to encode the request body. */
/**
 * How to encode the request body.
 *
 * `form` is `application/x-www-form-urlencoded`, and it is not an exotic case: every one of Twilio's 62
 * write operations declares it, and before this existed all 62 were sent as JSON — a request Twilio
 * rejects. The spec says which encoding an operation wants, so honouring it is not a heuristic.
 */
export type BodyKind = 'json' | 'multipart' | 'form';

export interface InternalRequest {
  readonly method: string;
  /** Path with parameters already interpolated, e.g. `/assets/abc123`. */
  readonly path: string;
  /**
   * Query parameters, typed `unknown` rather than {@link QueryValue}.
   *
   * TypeScript does not give an `interface` an implicit index signature, so a generated
   * `interface Created { gte?: number }` can never satisfy `Record<string, QueryValue>` however
   * correct it is — Stripe hit this on 40+ operations. Callers are still fully typed by the
   * generated `*Params` interfaces; this is graft's own plumbing, and {@link buildQuery} validates
   * every value at runtime regardless.
   */
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly bodyKind?: BodyKind;
  readonly responseType?: ResponseType;
  readonly headers?: Record<string, string>;
  readonly options?: RequestOptions;
}

/** A decoded response plus the envelope generated code sometimes needs (pagination totals). */
export interface RawResponse<T> {
  readonly data: T;
  readonly response: Response;
}

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_RETRIES = 2;
/**
 * Methods HTTP defines as idempotent, which are therefore safe to replay.
 *
 * `DELETE` belongs here: deleting twice leaves the resource deleted, and a 404 on the second attempt is
 * the correct answer rather than a failure.
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

/**
 * Default header for an idempotency key.
 *
 * Not standardised — `Idempotency-Key`, `X-Idempotency-Key`, and `Idempotency-Token` are all in real use
 * — so a generated client overrides it from `graft.yaml`.
 */
export const DEFAULT_IDEMPOTENCY_HEADER = 'Idempotency-Key';

const RETRYABLE_STATUSES = new Set([408, 409, 429]);

/**
 * Serialize query parameters.
 *
 * `undefined` is omitted so callers can spread optional params without guarding each one;
 * `null` is sent as an empty value, since a caller writing `null` meant something by it.
 * Arrays repeat the key, which is the `explode: true` default and what almost every server
 * expects for `?type=a&type=b`.
 */
export function buildQuery(query: Record<string, unknown> | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();

  /**
   * Append one value, recursing into objects as `key[sub]=value`.
   *
   * That bracket form is OpenAPI's `style: deepObject`, and it is what servers using nested filter
   * or range queries expect. Depth is bounded: a cyclic value would otherwise hang the request.
   */
  const append = (key: string, value: unknown, depth = 0): void => {
    if (value === undefined) return;
    if (value === null) {
      params.append(key, '');
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        // Scalars repeat the key (`type=a&type=b`); structured elements need an index so the
        // server can tell them apart (`filter[0][field]=x`).
        if (item !== null && typeof item === 'object') {
          if (depth >= 4) continue;
          append(`${key}[${index}]`, item, depth + 1);
        } else if (item !== undefined) {
          params.append(key, item === null ? '' : String(item));
        }
      }
      return;
    }
    if (typeof value === 'object') {
      if (depth >= 4) return;
      for (const [sub, nested] of Object.entries(value)) {
        append(`${key}[${sub}]`, nested, depth + 1);
      }
      return;
    }
    // Only stringify what has a meaningful string form. A symbol would throw, and a function or
    // class instance in a query string is a caller mistake better dropped than mangled.
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      params.append(key, String(value));
    }
  };

  for (const [key, value] of Object.entries(query)) append(key, value);

  const serialized = params.toString();
  return serialized === '' ? '' : `?${serialized}`;
}

/** Full jitter exponential backoff, capped. Prevents synchronized retry storms. */
export function retryDelay(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1000, 60_000);
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return Math.random() * base;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new APIUserAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new APIUserAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class BaseClient {
  protected readonly baseURL: string;
  protected readonly auth: Auth;
  protected readonly timeout: number;
  protected readonly maxRetries: number;
  protected readonly defaultHeaders: Record<string, string>;
  /**
   * How strictly to enforce the declared response shape. Read by generated methods, which are the
   * only code that knows a response's schema.
   *
   * Public, not protected — for the second time in this file. A generated resource class *holds* a
   * client rather than extending one, so anything generated code needs is reachable only through the
   * instance. Composition, not inheritance, is the shape of the generated surface.
   */
  readonly validationMode: ValidationMode;
  private readonly idempotencyHeader: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ClientOptions = {}) {
    this.baseURL = (options.baseURL ?? '').replace(/\/+$/, '');
    this.auth = options.auth ?? { type: 'none' };
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.validationMode = options.validation ?? 'strict';
    this.idempotencyHeader = options.idempotencyHeader ?? DEFAULT_IDEMPOTENCY_HEADER;
    const resolved = options.fetch ?? globalThis.fetch;
    if (typeof resolved !== 'function') {
      throw new Error(
        'No fetch implementation found. Pass `fetch` in the client options, or run on Node 18+.',
      );
    }
    this.fetchImpl = resolved;
  }

  /** Issue a request, decode the body, and throw a typed error on failure. */
  async request<T>(request: InternalRequest): Promise<T> {
    return (await this.requestRaw<T>(request)).data;
  }

  /**
   * Issue a request and check the decoded body against the schema the spec declared.
   *
   * Called by generated methods rather than from inside {@link request}, because only generated code
   * knows which schema belongs to which operation — passing schemas down into the transport would put
   * type knowledge in the runtime, which is the boundary this design exists to keep.
   *
   * `operation` names the method in the error message: a validation failure that does not say where it
   * happened is most of the way to useless.
   *
   * Public, not protected: a generated resource class *holds* a client rather than extending one, so a
   * protected member would be unreachable from exactly the code that needs it.
   */
  async requestValidated<T>(
    request: InternalRequest,
    schema: Schema | undefined,
    table: SchemaTable,
    operation: string,
  ): Promise<T> {
    const data = await this.request<T>(request);
    return enforce(data, schema, table, operation, this.validationMode);
  }

  /** A response the spec declares as text — `text/csv`, `text/plain`. */
  async requestText(request: InternalRequest): Promise<string> {
    const { data } = await this.requestRaw<string>({ ...request, responseType: 'text' });
    return data ?? '';
  }

  /** A response the spec declares as opaque bytes. */
  async requestBinary(request: InternalRequest): Promise<Blob> {
    const { data } = await this.requestRaw<Blob>({ ...request, responseType: 'binary' });
    return data;
  }

  /**
   * A streaming response, handed back undecoded.
   *
   * The body must not be read here — generated code passes the `Response` to `streamSSE` or
   * `streamJSONLines`, which consume it incrementally.
   */
  async requestStream(request: InternalRequest): Promise<Response> {
    const { response } = await this.requestRaw<undefined>({ ...request, responseType: 'stream' });
    return response;
  }

  /**
   * As {@link request}, but also hands back the raw `Response`.
   *
   * Pagination needs response *headers* (the total count arrives in one), and callers
   * occasionally need them too. Kept separate so the common path returns just the data and
   * generated method signatures stay clean.
   */
  async requestRaw<T>(request: InternalRequest): Promise<RawResponse<T>> {
    const maxRetries = request.options?.maxRetries ?? this.maxRetries;
    let lastError: unknown;
    /**
     * A 401 buys one forced token refresh and one retry — never more.
     *
     * Expiry arithmetic is necessary but not sufficient: clocks disagree and servers revoke tokens
     * early, so a token believed valid can still be rejected. Retrying more than once would turn a
     * genuinely revoked credential into a loop against the authorization server.
     *
     * Counted outside the retry loop so it composes with, rather than consumes, the retry budget:
     * a 401 followed by a 503 should still get its normal retries.
     */
    let authRefreshed = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const retryAfter =
          lastError !== null && typeof lastError === 'object' && 'headers' in lastError
            ? parseRetryAfter((lastError as APIError).headers)
            : undefined;
        await sleep(retryDelay(attempt - 1, retryAfter), request.options?.signal);
      }

      try {
        return await this.attempt<T>(request);
      } catch (error) {
        lastError = error;
        // A caller-initiated abort is a decision, not a failure to retry through.
        if (error instanceof APIUserAbortError) throw error;

        if (!authRefreshed && this.auth.type === 'oauth2' && isAuthFailure(error)) {
          authRefreshed = true;
          try {
            await this.auth.source.forceRefresh();
          } catch (refreshError) {
            // A refresh that fails is more informative than the 401 it was trying to fix: it says
            // the credentials themselves are wrong, not that a token went stale.
            throw refreshError;
          }
          // Retried immediately: the failure was a stale token, not a busy server, so backing off
          // would only add latency.
          attempt -= 1;
          continue;
        }

        if (attempt === maxRetries || !this.shouldRetry(error, request)) throw error;
      }
    }

    throw lastError;
  }

  /** Whether an error is worth another attempt. */
  protected shouldRetry(error: unknown, request?: InternalRequest): boolean {
    // Whether the *failure* is retryable at all.
    let failureIsRetryable = false;
    if (error instanceof APIConnectionError) {
      // Connection failures and timeouts are the canonical retryable case.
      failureIsRetryable = true;
    } else if (error !== null && typeof error === 'object' && 'status' in error) {
      const status = (error as APIError).status;
      // 5xx is retryable; 501 is not, since an unimplemented method stays unimplemented.
      failureIsRetryable = RETRYABLE_STATUSES.has(status) || (status >= 500 && status !== 501);
    }
    if (!failureIsRetryable) return false;

    return request === undefined || this.requestIsReplayable(request);
  }

  /**
   * Whether replaying this request is safe.
   *
   * This check did not exist, and its absence was a bug rather than a missing feature: a
   * `POST /charges` that returned 503 was sent three times, and whether the server processed the first
   * one is unknowable from here. The plausible outcome is three charges.
   *
   * `GET`, `HEAD`, `PUT`, `DELETE`, and `OPTIONS` are idempotent by HTTP's definition, so a replay is
   * safe whether or not the first attempt landed — `DELETE` included, because a second delete returning
   * 404 is a correct outcome rather than a failure.
   *
   * `POST` and `PATCH` are replayable only with an idempotency key, because deduplication has to happen
   * on the *server*. A client cannot make a replay safe by itself, and pretending otherwise is worse
   * than not retrying: the belief is what stops someone thinking about it.
   */
  private requestIsReplayable(request: InternalRequest): boolean {
    if (IDEMPOTENT_METHODS.has(request.method.toUpperCase())) return true;
    return this.idempotencyKeyFor(request) !== undefined;
  }

  /** The idempotency key for a request, if the caller supplied one. */
  private idempotencyKeyFor(request: InternalRequest): string | undefined {
    return request.options?.idempotencyKey ?? undefined;
  }

  private async attempt<T>(request: InternalRequest): Promise<RawResponse<T>> {
    // An `in: query` API key merges with the request's own parameters.
    const query: Record<string, unknown> = { ...request.query, ...authQuery(this.auth) };
    const url = `${this.baseURL}${request.path}${buildQuery(query)}`;
    const timeout = request.options?.timeout ?? this.timeout;

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...lowercaseKeys(this.defaultHeaders),
      ...(await authHeaders(this.auth)),
      ...lowercaseKeys(request.headers ?? {}),
      ...lowercaseKeys(request.options?.headers ?? {}),
    };

    const idempotencyKey = this.idempotencyKeyFor(request);
    if (idempotencyKey !== undefined) {
      headers[this.idempotencyHeader.toLowerCase()] = idempotencyKey;
    }

    // `Last-Event-ID` is fixed by the SSE specification, unlike the idempotency header — so it is not
    // configurable, and making it so would invite a value no SSE server reads.
    if (request.options?.lastEventId !== undefined) {
      headers['last-event-id'] = request.options.lastEventId;
    }

    let payload: string | FormData | undefined;
    if (request.body !== undefined) {
      if (request.bodyKind === 'multipart') {
        payload = toFormData(request.body);
        // Deliberately not set: fetch must generate the multipart boundary itself, and an
        // explicit content-type here produces a request the server cannot parse.
        delete headers['content-type'];
      } else if (request.bodyKind === 'form') {
        payload = toUrlEncoded(request.body);
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
      } else {
        payload = JSON.stringify(request.body);
        headers['content-type'] ??= 'application/json';
      }
    }

    // Compose the caller's signal with our timeout so whichever fires first wins, and so a
    // caller abort is distinguishable from a timeout in the thrown error.
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort('caller');
    request.options?.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = timeout > 0 ? setTimeout(() => controller.abort('timeout'), timeout) : undefined;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method.toUpperCase(),
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: controller.signal,
      });
    } catch (cause) {
      if (request.options?.signal?.aborted === true) throw new APIUserAbortError();
      if (controller.signal.reason === 'timeout' || isAbortError(cause)) {
        throw new APIConnectionTimeoutError(`Request to ${request.path} timed out after ${timeout}ms`);
      }
      throw new APIConnectionError(`Could not reach ${this.baseURL}`, { cause });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      request.options?.signal?.removeEventListener('abort', onCallerAbort);
    }

    if (!response.ok) {
      // An error body is always decoded as JSON-or-text regardless of the declared success
      // type: a 500 is HTML far more often than it is the shape the spec promised.
      throw errorFromStatus(response.status, await decodeBody(response), response.headers);
    }

    switch (request.responseType) {
      case 'stream':
        // Leave the body unread for the caller to consume incrementally.
        return { data: undefined as T, response };
      case 'binary':
        return { data: (await response.blob()) as T, response };
      case 'text':
        return { data: (await response.text()) as T, response };
      default:
        return { data: (await decodeBody(response)) as T, response };
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { name?: string }).name === 'AbortError';
}

/** Lowercase header keys so caller overrides reliably replace defaults. */
function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) result[key.toLowerCase()] = value;
  return result;
}

/**
 * Decode a response body.
 *
 * Returns `undefined` for 204 and for empty bodies, so a `delete()` that declares no response
 * resolves to `undefined` rather than throwing on a JSON parse of `''`. A non-JSON body comes
 * back as text rather than an error, because error responses are frequently HTML even when the
 * spec promises JSON.
 */
async function decodeBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text === '') return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (!/\bjson\b/i.test(contentType)) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Drop `undefined` entries from a header map.
 *
 * Generated code builds header objects from optional parameters, and `fetch` would otherwise
 * send the literal string `"undefined"` as a header value.
 */
export function compact(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    // `null` and `undefined` are dropped rather than sent as the strings "null"/"undefined", and
    // anything without a sensible string form is dropped too.
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    result[key] = String(value);
  }
  return result;
}

/**
 * Build an `application/x-www-form-urlencoded` body from a plain object.
 *
 * `URLSearchParams` rather than hand-rolled escaping, because form encoding has two rules that are easy
 * to get wrong by hand — a space is `+`, not `%20`, and everything else is percent-encoded — and the
 * platform already implements both.
 *
 * A repeated key per array element, which is what every form-encoded API this project has seen expects;
 * `key[]=` is a PHP convention and `key=a,b` is a third. Objects are JSON-encoded, matching how the
 * multipart encoder handles a structured field: there is no canonical nesting for form encoding, and
 * inventing one would send something no server asked for.
 *
 * `undefined` and `null` are omitted rather than sent as the strings `"undefined"` and `"null"` — the
 * same bug the query encoder had, in a second place.
 */
function toUrlEncoded(body: unknown): string {
  const params = new URLSearchParams();
  if (body === null || typeof body !== 'object') return '';
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
      }
    } else if (typeof value === 'object') {
      params.append(key, JSON.stringify(value));
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

/**
 * Build a `FormData` body from a plain object.
 *
 * `Blob`/`File` values pass through so a caller can upload directly; everything else is
 * stringified, with objects JSON-encoded because that is what servers expect for a structured
 * field inside a multipart request. `undefined` fields are omitted rather than sent as the
 * string `"undefined"`.
 */
function toFormData(body: unknown): FormData {
  const form = new FormData();
  if (body === null || typeof body !== 'object') return form;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Blob) {
      form.append(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        form.append(key, item instanceof Blob ? item : String(item));
      }
    } else if (typeof value === 'object') {
      form.append(key, JSON.stringify(value));
    } else {
      form.append(key, String(value));
    }
  }
  return form;
}
