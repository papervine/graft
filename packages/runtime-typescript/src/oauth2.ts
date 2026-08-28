/**
 * OAuth2 token acquisition.
 *
 * Only the flows an SDK can honestly own (SPEC.md §3.1.6): `clientCredentials`, where the SDK holds
 * the credentials and is entirely responsible; and refreshing a token the caller obtained elsewhere.
 * The authorization-code redirect needs a browser and a human, so it stays the application's job.
 *
 * The token request itself is the easy part. What earns this file are the three things around it:
 * single-flight refresh, proactive expiry, and retrying a 401 exactly once.
 */

import { APIError, SDKError } from './errors.js';

/** How the SDK obtains a token. */
export type OAuth2Config =
  | {
      readonly flow: 'clientCredentials';
      readonly tokenUrl: string;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly scopes?: readonly string[];
      /**
       * `basic` sends the credentials in an Authorization header, `body` in the form body.
       *
       * RFC 6749 requires servers to support `basic` and says `body` *may* be supported, so `basic`
       * is the default — but real servers get this wrong in both directions, which is why it is an
       * option rather than a constant.
       */
      readonly clientAuth?: 'basic' | 'body';
      readonly extraParams?: Readonly<Record<string, string>>;
    }
  | {
      readonly flow: 'refreshToken';
      readonly tokenUrl: string;
      readonly refreshToken: string;
      readonly clientId?: string;
      readonly clientSecret?: string;
      readonly scopes?: readonly string[];
      readonly clientAuth?: 'basic' | 'body';
      readonly extraParams?: Readonly<Record<string, string>>;
    };

/** A token and when it stops being usable. */
interface CachedToken {
  readonly accessToken: string;
  /** Epoch milliseconds, already adjusted by {@link EXPIRY_SKEW_MS}. Undefined means no expiry. */
  readonly usableUntil: number | undefined;
  /** A rotated refresh token, when the server issued one. */
  readonly refreshToken: string | undefined;
}

/**
 * How early to treat a token as expired.
 *
 * Refreshing only once a token has *already* expired guarantees at least one failed request first.
 * Thirty seconds covers ordinary clock skew and the time a request spends in flight.
 */
const EXPIRY_SKEW_MS = 30_000;

/** Raised when the authorization server refuses to issue a token. */
export class OAuth2Error extends SDKError {
  /** HTTP status from the token endpoint. */
  readonly status: number;
  /** RFC 6749 `error` code, e.g. `invalid_client`. */
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'OAuth2Error';
    this.status = status;
    this.code = code;
  }
}

/**
 * Acquires and caches OAuth2 tokens.
 *
 * One instance per client, so a client used across a request handler shares one token rather than one
 * per call.
 */
export class TokenSource {
  private cached: CachedToken | undefined;
  /**
   * The refresh currently in flight, if any.
   *
   * This is the single-flight mechanism, and it is the reason this class exists rather than a
   * function. Ten concurrent calls on a cold client must produce **one** token request: without it,
   * the first thing a new SDK does under load is hammer the authorization server, and the symptom is
   * unexplained 429s from a host the caller never configured.
   */
  private inFlight: Promise<CachedToken> | undefined;

  constructor(
    private readonly config: OAuth2Config,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  /** A usable access token, fetching or refreshing only when necessary. */
  async token(): Promise<string> {
    const current = this.cached;
    if (current !== undefined && !isExpired(current)) return current.accessToken;
    return (await this.refresh()).accessToken;
  }

  /**
   * Discard the cached token and fetch a new one.
   *
   * Called on a 401 as well as on expiry, because expiry arithmetic is necessary but not sufficient —
   * clocks disagree and servers revoke tokens early.
   */
  async forceRefresh(): Promise<string> {
    this.cached = undefined;
    return (await this.refresh()).accessToken;
  }

  private async refresh(): Promise<CachedToken> {
    // A refresh already running is joined rather than duplicated. The promise is cleared in a
    // `finally` so a failure does not poison every later call with the same rejection.
    const existing = this.inFlight;
    if (existing !== undefined) return existing;

    const attempt = this.request()
      .then((token) => {
        this.cached = token;
        return token;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = attempt;
    return attempt;
  }

  private async request(): Promise<CachedToken> {
    const body = new URLSearchParams();
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };

    let clientId: string | undefined;
    let clientSecret: string | undefined;
    if (this.config.flow === 'clientCredentials') {
      body.set('grant_type', 'client_credentials');
      clientId = this.config.clientId;
      clientSecret = this.config.clientSecret;
    } else {
      body.set('grant_type', 'refresh_token');
      // The rotated token when the server issued one, otherwise the caller's original. Servers that
      // rotate refresh tokens invalidate the old one, so reusing it would fail on the second refresh.
      body.set('refresh_token', this.cached?.refreshToken ?? this.config.refreshToken);
      clientId = this.config.clientId;
      clientSecret = this.config.clientSecret;
    }

    if (this.config.scopes !== undefined && this.config.scopes.length > 0) {
      body.set('scope', this.config.scopes.join(' '));
    }
    for (const [key, value] of Object.entries(this.config.extraParams ?? {})) {
      body.set(key, value);
    }

    if (clientId !== undefined) {
      // RFC 6749 requires servers to accept the Authorization header and only permits the body form,
      // so `basic` is the default — but real servers get this wrong in both directions.
      if ((this.config.clientAuth ?? 'basic') === 'basic') {
        headers.authorization = `Basic ${base64(`${clientId}:${clientSecret ?? ''}`)}`;
      } else {
        body.set('client_id', clientId);
        if (clientSecret !== undefined) body.set('client_secret', clientSecret);
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.config.tokenUrl, {
        method: 'POST',
        headers,
        body: body.toString(),
      });
    } catch (cause) {
      throw new OAuth2Error(
        `Could not reach the token endpoint at ${this.config.tokenUrl}`,
        0,
        undefined,
      );
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === '' ? {} : JSON.parse(text);
    } catch {
      payload = {};
    }

    if (!response.ok) {
      // Never retried. A 400 from a token endpoint means the credentials are wrong, and retrying it is
      // both pointless and indistinguishable from a brute-force attempt.
      const record = asRecord(payload);
      const code = typeof record.error === 'string' ? record.error : undefined;
      const description =
        typeof record.error_description === 'string' ? record.error_description : undefined;
      throw new OAuth2Error(
        description ?? code ?? `The token endpoint returned ${response.status}`,
        response.status,
        code,
      );
    }

    const record = asRecord(payload);
    const accessToken = record.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new OAuth2Error(
        'The token endpoint returned no access_token',
        response.status,
        undefined,
      );
    }

    const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : undefined;
    const rotated = typeof record.refresh_token === 'string' ? record.refresh_token : undefined;

    return {
      accessToken,
      usableUntil:
        expiresIn === undefined
          ? undefined
          : Date.now() + Math.max(0, expiresIn * 1000 - EXPIRY_SKEW_MS),
      // A server that does not rotate keeps the previous value usable.
      refreshToken: rotated ?? this.cached?.refreshToken,
    };
  }
}

function isExpired(token: CachedToken): boolean {
  return token.usableUntil !== undefined && Date.now() >= token.usableUntil;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Base64 without assuming Node's Buffer, so the runtime works in a browser and in Workers. */
function base64(input: string): string {
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(input);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Buffer is not typed in a DOM lib
  const nodeBuffer = (globalThis as any).Buffer;
  if (nodeBuffer !== undefined) return nodeBuffer.from(input, 'utf8').toString('base64');
  throw new SDKError('No base64 implementation available for OAuth2 client authentication');
}

/** Whether a failed request is worth one forced token refresh and a single retry. */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof APIError && error.status === 401;
}
