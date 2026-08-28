/**
 * OAuth2 tests.
 *
 * The token request itself is barely worth testing. What these cover is the three things around it
 * that are easy to get wrong and expensive when wrong (SPEC.md §3.1.6): single-flight refresh,
 * proactive expiry, and retrying a 401 exactly once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseClient } from './client.js';
import { APIError } from './errors.js';
import { OAuth2Error, TokenSource } from './oauth2.js';

interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function tokenServer(
  respond: (call: number) => { status?: number; body: unknown },
): { fetchImpl: typeof globalThis.fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: String(init?.body ?? ''),
    });
    const { status = 200, body } = respond(calls.length);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchImpl: impl as unknown as typeof globalThis.fetch, calls };
}

const clientCredentials = {
  flow: 'clientCredentials',
  tokenUrl: 'https://auth.test/token',
  clientId: 'id',
  clientSecret: 'secret',
} as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the token request', () => {
  it('sends client_credentials with basic client authentication', async () => {
    const { fetchImpl, calls } = tokenServer(() => ({
      body: { access_token: 'tok_1', expires_in: 3600 },
    }));
    const source = new TokenSource(clientCredentials, fetchImpl);

    expect(await source.token()).toBe('tok_1');
    expect(calls[0]!.url).toBe('https://auth.test/token');
    expect(calls[0]!.body).toContain('grant_type=client_credentials');
    // RFC 6749 requires servers to accept the header form, so it is the default.
    expect(calls[0]!.headers.authorization).toBe(`Basic ${btoa('id:secret')}`);
    // The credentials must not also appear in the body.
    expect(calls[0]!.body).not.toContain('client_secret');
  });

  it('can send credentials in the body for servers that require it', async () => {
    const { fetchImpl, calls } = tokenServer(() => ({ body: { access_token: 't' } }));
    const source = new TokenSource({ ...clientCredentials, clientAuth: 'body' }, fetchImpl);
    await source.token();
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.body).toContain('client_id=id');
  });

  it('sends requested scopes space-separated', async () => {
    const { fetchImpl, calls } = tokenServer(() => ({ body: { access_token: 't' } }));
    await new TokenSource(
      { ...clientCredentials, scopes: ['read:widgets', 'write:widgets'] },
      fetchImpl,
    ).token();
    // Parsed rather than string-matched: URLSearchParams encodes a space as `+`, which
    // decodeURIComponent does not undo — so a naive assertion tests the encoding, not the value.
    expect(new URLSearchParams(calls[0]!.body).get('scope')).toBe('read:widgets write:widgets');
  });
});

describe('caching and proactive expiry', () => {
  it('reuses a token that is still valid', async () => {
    const { fetchImpl, calls } = tokenServer(() => ({
      body: { access_token: 'tok', expires_in: 3600 },
    }));
    const source = new TokenSource(clientCredentials, fetchImpl);
    await source.token();
    await source.token();
    await source.token();
    expect(calls).toHaveLength(1);
  });

  it('refreshes before the token actually expires', async () => {
    // Refreshing only once a token has expired guarantees at least one failed request first.
    const { fetchImpl, calls } = tokenServer((n) => ({
      body: { access_token: `tok_${n}`, expires_in: 60 },
    }));
    const source = new TokenSource(clientCredentials, fetchImpl);
    expect(await source.token()).toBe('tok_1');

    // 35s in: still inside the 60s lifetime, but past the 30s safety margin.
    vi.setSystemTime(Date.now() + 35_000);
    expect(await source.token()).toBe('tok_2');
    expect(calls).toHaveLength(2);
  });

  it('treats a token with no expires_in as long-lived', async () => {
    const { fetchImpl, calls } = tokenServer(() => ({ body: { access_token: 'tok' } }));
    const source = new TokenSource(clientCredentials, fetchImpl);
    await source.token();
    vi.setSystemTime(Date.now() + 86_400_000);
    await source.token();
    // Nothing to expire against, so nothing to refresh. A server that means otherwise must say so.
    expect(calls).toHaveLength(1);
  });
});

describe('single-flight refresh', () => {
  it('makes one token request for many concurrent callers', async () => {
    // Without this, the first thing a new SDK does under load is hammer the authorization server, and
    // the symptom is unexplained 429s from a host the caller never configured.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async () => {
      calls.push('token');
      await gate;
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const source = new TokenSource(clientCredentials, fetchImpl);
    const pending = Promise.all(Array.from({ length: 10 }, () => source.token()));
    release!();
    const tokens = await pending;

    expect(calls).toHaveLength(1);
    expect(new Set(tokens)).toEqual(new Set(['tok']));
  });

  it('does not poison later calls when a refresh fails', async () => {
    // A rejected in-flight promise left in place would make every subsequent call fail with the same
    // stale rejection, long after the cause was fixed.
    let failing = true;
    const fetchImpl = (async () => {
      if (failing) return new Response('{"error":"temporarily_unavailable"}', { status: 503 });
      return new Response(JSON.stringify({ access_token: 'tok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const source = new TokenSource(clientCredentials, fetchImpl);
    await expect(source.token()).rejects.toBeInstanceOf(OAuth2Error);
    failing = false;
    expect(await source.token()).toBe('tok');
  });
});

describe('refresh-token flow', () => {
  it('sends the refresh grant and adopts a rotated token', async () => {
    // A server that rotates refresh tokens invalidates the old one, so reusing it would fail on the
    // second refresh.
    const { fetchImpl, calls } = tokenServer((n) => ({
      body: { access_token: `a_${n}`, refresh_token: `r_${n}`, expires_in: 60 },
    }));
    const source = new TokenSource(
      { flow: 'refreshToken', tokenUrl: 'https://auth.test/token', refreshToken: 'r_0' },
      fetchImpl,
    );

    expect(await source.token()).toBe('a_1');
    expect(calls[0]!.body).toContain('refresh_token=r_0');

    vi.setSystemTime(Date.now() + 35_000);
    expect(await source.token()).toBe('a_2');
    expect(calls[1]!.body).toContain('refresh_token=r_1');
  });
});

describe('failures', () => {
  it('surfaces the server error code and description', async () => {
    const { fetchImpl } = tokenServer(() => ({
      status: 401,
      body: { error: 'invalid_client', error_description: 'Client authentication failed' },
    }));
    const source = new TokenSource(clientCredentials, fetchImpl);
    await expect(source.token()).rejects.toMatchObject({
      name: 'OAuth2Error',
      status: 401,
      code: 'invalid_client',
      message: 'Client authentication failed',
    });
  });

  it('never retries a token request', async () => {
    // A 400 from a token endpoint means the credentials are wrong. Retrying is pointless and
    // indistinguishable from a brute-force attempt.
    const { fetchImpl, calls } = tokenServer(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    const source = new TokenSource(clientCredentials, fetchImpl);
    await expect(source.token()).rejects.toBeInstanceOf(OAuth2Error);
    expect(calls).toHaveLength(1);
  });

  it('reports a response with no access_token', async () => {
    const { fetchImpl } = tokenServer(() => ({ body: { token_type: 'Bearer' } }));
    await expect(new TokenSource(clientCredentials, fetchImpl).token()).rejects.toThrowError(
      /no access_token/,
    );
  });

  it('reports an unreachable token endpoint', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof globalThis.fetch;
    await expect(new TokenSource(clientCredentials, fetchImpl).token()).rejects.toMatchObject({
      name: 'OAuth2Error',
      status: 0,
    });
  });
});

describe('a 401 from the API', () => {
  /** A fetch that answers the token endpoint and the API from one function. */
  function combined(apiStatuses: number[]): { fetchImpl: typeof globalThis.fetch; log: string[] } {
    const log: string[] = [];
    let tokenCount = 0;
    let apiCount = 0;
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/token')) {
        tokenCount += 1;
        log.push(`token:${tokenCount}`);
        return new Response(JSON.stringify({ access_token: `tok_${tokenCount}` }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      const status = apiStatuses[apiCount] ?? 200;
      apiCount += 1;
      log.push(`api:${status}`);
      return new Response(JSON.stringify({ ok: status === 200 }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
    return { fetchImpl: impl, log };
  }

  function client(fetchImpl: typeof globalThis.fetch): BaseClient {
    const source = new TokenSource(clientCredentials, fetchImpl);
    return new BaseClient({
      baseURL: 'https://api.test',
      auth: { type: 'oauth2', source },
      maxRetries: 0,
      fetch: fetchImpl,
    });
  }

  it('forces one refresh and retries once', async () => {
    // Clocks disagree and servers revoke tokens early, so expiry arithmetic is necessary but not
    // sufficient.
    const { fetchImpl, log } = combined([401, 200]);
    const result = await client(fetchImpl).request<{ ok: boolean }>({
      method: 'get',
      path: '/widgets',
      responseType: 'json',
    });
    expect(result).toEqual({ ok: true });
    expect(log).toEqual(['token:1', 'api:401', 'token:2', 'api:200']);
  });

  it('gives up after one refresh rather than looping', async () => {
    // A genuinely revoked credential must not become a loop against the authorization server.
    const { fetchImpl, log } = combined([401, 401, 401]);
    await expect(
      client(fetchImpl).request({ method: 'get', path: '/widgets', responseType: 'json' }),
    ).rejects.toBeInstanceOf(APIError);
    expect(log.filter((entry) => entry.startsWith('token:'))).toHaveLength(2);
    expect(log.filter((entry) => entry === 'api:401')).toHaveLength(2);
  });

  it('does not refresh for a non-401 failure', async () => {
    const { fetchImpl, log } = combined([403]);
    await expect(
      client(fetchImpl).request({ method: 'get', path: '/widgets', responseType: 'json' }),
    ).rejects.toBeInstanceOf(APIError);
    expect(log.filter((entry) => entry.startsWith('token:'))).toHaveLength(1);
  });
});
