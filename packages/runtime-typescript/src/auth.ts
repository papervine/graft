/**
 * Authentication.
 *
 * The corpus API accepts Bearer *or* Basic, which is the common case rather than an oddity, so
 * auth is modelled as a discriminated union the caller picks from — not as a bag of optional
 * `token`/`username`/`password` fields where illegal combinations typecheck.
 */

/** Credentials the client was constructed with. */
export type Auth =
  | { readonly type: 'bearer'; readonly token: string }
  | { readonly type: 'basic'; readonly username: string; readonly password: string }
  | {
      readonly type: 'apiKey';
      readonly key: string;
      /** Header or query parameter name the API expects, e.g. `X-Api-Key`. */
      readonly name: string;
      readonly in: 'header' | 'query';
    }
  /**
   * A token fetched and refreshed by the SDK (SPEC.md §3.1.6).
   *
   * Distinct from `bearer` because the header cannot be computed once at construction — it depends on
   * a token that may not exist yet and will be replaced. Resolving it is asynchronous, which is why
   * the transport awaits the auth header rather than reading a field.
   */
  | {
      readonly type: 'oauth2';
      readonly source: {
        token(): Promise<string>;
        /** Discard the cached token and fetch a new one. Called on a 401. */
        forceRefresh(): Promise<string>;
      };
    }
  | { readonly type: 'none' };

/** Base64 without assuming Node or the browser. Generated SDKs run in both. */
function base64(input: string): string {
  if (typeof globalThis.btoa === 'function') {
    // btoa is byte-oriented, so encode to UTF-8 first or non-ASCII passwords corrupt.
    const bytes = new TextEncoder().encode(input);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary);
  }
  const bufferCtor = (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } })
    .Buffer;
  if (bufferCtor !== undefined) return bufferCtor.from(input, 'utf8').toString('base64');
  throw new Error('No base64 implementation available in this runtime');
}

/**
 * Produce the headers a given credential implies.
 *
 * An API key carries its own parameter name, because the spec names it — hardcoding
 * `authorization` would send the key somewhere the server never reads.
 */
export async function authHeaders(auth: Auth): Promise<Record<string, string>> {
  switch (auth.type) {
    case 'bearer':
      return { authorization: `Bearer ${auth.token}` };
    case 'basic':
      return { authorization: `Basic ${base64(`${auth.username}:${auth.password}`)}` };
    case 'apiKey':
      return auth.in === 'header' ? { [auth.name.toLowerCase()]: auth.key } : {};
    case 'oauth2':
      // The one asynchronous case, and the reason this function is async at all: an OAuth2 header
      // depends on a token that may not exist yet. A separate `authHeadersAsync` would have kept the
      // sync signature for the other schemes, and the two would have drifted — which has happened
      // twice already in this codebase, both times to logic that looked too small to duplicate.
      return { authorization: `Bearer ${await auth.source.token()}` };
    case 'none':
      return {};
  }
}

/** Query parameters a credential implies. Only `in: query` API keys produce any. */
export function authQuery(auth: Auth): Record<string, string> {
  return auth.type === 'apiKey' && auth.in === 'query' ? { [auth.name]: auth.key } : {};
}

/**
 * Redact credentials for logging and error messages.
 *
 * Never let a token reach a log line. Keeping a short prefix preserves the one thing that is
 * actually useful when debugging — which credential was used — without leaking it.
 */
export function redactAuth(auth: Auth): string {
  switch (auth.type) {
    case 'bearer':
      return `bearer ${auth.token.slice(0, 6)}…`;
    case 'basic':
      return `basic ${auth.username}:…`;
    case 'apiKey':
      return `apiKey ${auth.key.slice(0, 6)}…`;
    case 'oauth2':
      // No prefix, deliberately. The token is fetched and rotated, so a prefix identifies nothing
      // stable and would only put credential bytes in a log line for no diagnostic value.
      return 'oauth2';
    case 'none':
      return 'none';
  }
}

/**
 * Read a credential from the environment, treating empty as absent.
 *
 * The generated client falls back to these so a script does not have to plumb `process.env` through
 * every construction site, which is what every SDK people enjoy using does. It is a *fallback*: an
 * explicit option always wins, because a caller who passed a credential meant it.
 *
 * Empty counts as absent because `ACME_TOKEN=` in a `.env` file is how a variable gets unset in
 * practice, and treating it as a real credential produces `Authorization: Bearer ` — a 401 whose
 * cause is invisible.
 *
 * Reached through `globalThis` rather than `process` directly for two reasons: the generated package
 * declares no `@types/node` (see the `types: []` in its tsconfig), and the same code has to run in a
 * browser or a worker where `process` does not exist at all.
 */
export function readEnv(name: string): string | undefined {
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
      Deno?: { env?: { get(key: string): string | undefined } };
    }
  ).process?.env;
  const value = env?.[name] ?? (globalThis as { Deno?: { env?: { get(key: string): string | undefined } } }).Deno?.env?.get(name);
  return value === undefined || value === '' ? undefined : value;
}
