import { describe, expect, it, vi } from 'vitest';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BaseClient,
  ConflictError,
  InternalServerError,
  NotFoundError,
  Page,
  Paginator,
  RateLimitError,
  UnprocessableEntityError,
  authHeaders,
  buildQuery,
  compact,
  errorFromStatus,
  isAPIError,
  mapFromWire,
  parseTotalCount,
  redactAuth,
  retryDelay,
  type PaginationConfig,
} from './index.js';

/** Build a JSON Response the way a real server would. */
function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** A fetch stub that returns queued responses in order and records the requests it saw. */
function stubFetch(responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('no queued response');
    return typeof next === 'function' ? await next() : next.clone();
  });
  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

function client(
  responses: Array<Response | (() => Response | Promise<Response>)>,
  options: Partial<ConstructorParameters<typeof BaseClient>[0]> = {},
) {
  const { fetchImpl, calls } = stubFetch(responses);
  return {
    calls,
    client: new BaseClient({ baseURL: 'https://api.test/api', fetch: fetchImpl, maxRetries: 2, ...options }),
  };
}

describe('query serialization', () => {
  it('omits undefined so optional params can be spread unguarded', () => {
    expect(buildQuery({ a: 1, b: undefined })).toBe('?a=1');
  });

  it('sends null as an empty value, since the caller meant something by it', () => {
    expect(buildQuery({ a: null })).toBe('?a=');
  });

  it('repeats the key for arrays', () => {
    expect(buildQuery({ type: ['a', 'b'] })).toBe('?type=a&type=b');
  });

  it('returns an empty string rather than a bare ?', () => {
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ a: undefined })).toBe('');
  });

  it('encodes values that need it', () => {
    expect(buildQuery({ q: 'a b&c' })).toBe('?q=a+b%26c');
  });
});

describe('error mapping', () => {
  it.each([
    [400, 'BadRequestError'],
    [401, 'AuthenticationError'],
    [403, 'PermissionDeniedError'],
    [404, 'NotFoundError'],
    [409, 'ConflictError'],
    [422, 'UnprocessableEntityError'],
    [429, 'RateLimitError'],
    [500, 'InternalServerError'],
    [503, 'InternalServerError'],
  ])('maps %i to %s', (status, name) => {
    expect(errorFromStatus(status, {}, new Headers()).name).toBe(name);
  });

  it('narrows by instanceof from a catch block without a cast', async () => {
    const { client: c } = client([json({ error: 'nope' }, { status: 404 })], { maxRetries: 0 });
    try {
      await c.request({ method: 'get', path: '/assets/x' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      if (error instanceof NotFoundError) {
        // status is literal-typed on the subclass, so this needs no assertion.
        expect(error.status).toBe(404);
        expect(error.body).toEqual({ error: 'nope' });
      }
    }
  });

  it('uses the server message, and only the server message', () => {
    // No status prefix. The Python and Go runtimes keep `message` as what the server said and add
    // the status when rendering, and three SDKs generated from one spec have to agree on what
    // `message` means — the cross-language conformance suite fails when they do not.
    expect(errorFromStatus(400, { error: 'Missing name' }, new Headers()).message).toBe(
      'Missing name',
    );
    expect(errorFromStatus(400, { message: 'Bad' }, new Headers()).message).toBe('Bad');
    // One level of nesting, which is a common envelope.
    expect(errorFromStatus(400, { error: { message: 'Deep' } }, new Headers()).message).toBe('Deep');
    // The status is still available, and is the fallback when the server said nothing useful.
    const bare = errorFromStatus(503, {}, new Headers());
    expect(bare.message).toBe('HTTP 503');
    expect(bare.status).toBe(503);
  });

  it('falls back to the status when there is no message', () => {
    expect(errorFromStatus(500, {}, new Headers()).message).toBe('HTTP 500');
  });

  it('exposes the request id for support tickets', () => {
    const headers = new Headers({ 'x-request-id': 'req_123' });
    expect(errorFromStatus(500, {}, headers).requestId).toBe('req_123');
  });

  it('parses retry-after in both seconds and date form', () => {
    const seconds = new RateLimitError(429, {}, new Headers({ 'retry-after': '3' }));
    expect(seconds.retryAfterSeconds).toBe(3);
    const future = new Date(Date.now() + 5000).toUTCString();
    const dated = new RateLimitError(429, {}, new Headers({ 'retry-after': future }));
    expect(dated.retryAfterSeconds).toBeGreaterThan(3);
  });

  it('isAPIError narrows unknown without instanceof', () => {
    expect(isAPIError(errorFromStatus(404, {}, new Headers()))).toBe(true);
    expect(isAPIError(new Error('other'))).toBe(false);
  });
});

describe('retries', () => {
  it('retries a 500 and succeeds', async () => {
    const { client: c, calls } = client([
      json({ error: 'boom' }, { status: 500 }),
      json({ ok: true }),
    ]);
    await expect(c.request({ method: 'get', path: '/x' })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('retries 429 and 408', async () => {
    for (const status of [429, 408]) {
      const { client: c, calls } = client([json({}, { status }), json({ ok: true })]);
      await expect(c.request({ method: 'get', path: '/x' })).resolves.toEqual({ ok: true });
      expect(calls, `status ${status}`).toHaveLength(2);
    }
  });

  it('does not retry a 400', async () => {
    const { client: c, calls } = client([json({}, { status: 400 }), json({ ok: true })]);
    await expect(c.request({ method: 'get', path: '/x' })).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a 501, since unimplemented stays unimplemented', async () => {
    const { client: c, calls } = client([json({}, { status: 501 }), json({ ok: true })]);
    await expect(c.request({ method: 'get', path: '/x' })).rejects.toBeInstanceOf(InternalServerError);
    expect(calls).toHaveLength(1);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const { client: c, calls } = client([json({}, { status: 503 })], { maxRetries: 2 });
    await expect(c.request({ method: 'get', path: '/x' })).rejects.toBeInstanceOf(InternalServerError);
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it('honours a per-request maxRetries override', async () => {
    const { client: c, calls } = client([json({}, { status: 503 })], { maxRetries: 5 });
    await expect(
      c.request({ method: 'get', path: '/x', options: { maxRetries: 0 } }),
    ).rejects.toBeInstanceOf(InternalServerError);
    expect(calls).toHaveLength(1);
  });

  it('retries a connection failure', async () => {
    let first = true;
    const { client: c, calls } = client([
      () => {
        if (first) {
          first = false;
          throw new TypeError('network down');
        }
        return json({ ok: true });
      },
    ]);
    await expect(c.request({ method: 'get', path: '/x' })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('wraps an unreachable host as APIConnectionError', async () => {
    const { client: c } = client([
      () => {
        throw new TypeError('fetch failed');
      },
    ], { maxRetries: 0 });
    await expect(c.request({ method: 'get', path: '/x' })).rejects.toBeInstanceOf(APIConnectionError);
  });

  it('backoff is bounded and jittered', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const delay = retryDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(8_000);
    }
    // An explicit retry-after wins over computed backoff, capped at a minute.
    expect(retryDelay(0, 3)).toBe(3_000);
    expect(retryDelay(0, 9_999)).toBe(60_000);
  });
});

describe('abort and timeout', () => {
  it('distinguishes a caller abort from a timeout', async () => {
    const controller = new AbortController();
    const { client: c } = client([
      () =>
        new Promise<Response>((_resolve, reject) => {
          controller.abort();
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }),
    ]);
    await expect(
      c.request({ method: 'get', path: '/x', options: { signal: controller.signal } }),
    ).rejects.toBeInstanceOf(APIUserAbortError);
  });

  it('reports a timeout as APIConnectionTimeoutError', async () => {
    const { client: c } = client([
      () =>
        new Promise<Response>((_resolve, reject) => {
          const error = new Error('timed out');
          error.name = 'AbortError';
          setTimeout(() => reject(error), 5);
        }),
    ], { maxRetries: 0 });
    await expect(
      c.request({ method: 'get', path: '/x', options: { timeout: 1 } }),
    ).rejects.toBeInstanceOf(APIConnectionTimeoutError);
  });

  it('does not retry after a caller abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client: c, calls } = client([
      () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    ]);
    await expect(
      c.request({ method: 'get', path: '/x', options: { signal: controller.signal } }),
    ).rejects.toBeInstanceOf(APIUserAbortError);
    expect(calls).toHaveLength(1);
  });
});

describe('body decoding', () => {
  it('resolves 204 to undefined rather than throwing on empty JSON', async () => {
    const { client: c } = client([new Response(null, { status: 204 })]);
    await expect(c.request({ method: 'delete', path: '/x' })).resolves.toBeUndefined();
  });

  it('resolves an empty 200 body to undefined', async () => {
    const { client: c } = client([new Response('', { status: 200 })]);
    await expect(c.request({ method: 'get', path: '/x' })).resolves.toBeUndefined();
  });

  it('returns HTML error bodies as text instead of failing to parse', async () => {
    // Real servers return HTML on error even when the spec promises JSON.
    const { client: c } = client([
      new Response('<html>500</html>', { status: 500, headers: { 'content-type': 'text/html' } }),
    ], { maxRetries: 0 });
    await expect(c.request({ method: 'get', path: '/x' })).rejects.toMatchObject({
      body: '<html>500</html>',
    });
  });
});

describe('headers and auth', () => {
  it('sends a bearer token', async () => {
    expect(await authHeaders({ type: 'bearer', token: 'pat_abc' })).toEqual({
      authorization: 'Bearer pat_abc',
    });
  });

  it('base64-encodes basic credentials', async () => {
    expect(await authHeaders({ type: 'basic', username: 'a@b.com', password: 'pw' })).toEqual({
      authorization: `Basic ${Buffer.from('a@b.com:pw').toString('base64')}`,
    });
  });

  it('handles non-ASCII passwords without corrupting them', async () => {
    const header = (await authHeaders({ type: 'basic', username: 'u', password: 'pä$$' }))
      .authorization!;
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString('utf8');
    expect(decoded).toBe('u:pä$$');
  });

  it('never puts a credential in a log string', () => {
    expect(redactAuth({ type: 'bearer', token: 'pat_supersecretvalue' })).not.toContain(
      'supersecretvalue',
    );
    expect(redactAuth({ type: 'basic', username: 'u', password: 'secret' })).not.toContain('secret');
  });

  it('merges constant default headers into every request', async () => {
    const { client: c, calls } = client([json({})], {
      defaultHeaders: { Accept: 'application/json' },
    });
    await c.request({ method: 'get', path: '/x' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['accept']).toBe('application/json');
  });

  it('lets a per-request header override a default', async () => {
    const { client: c, calls } = client([json({})], { defaultHeaders: { 'X-Mode': 'a' } });
    await c.request({ method: 'get', path: '/x', options: { headers: { 'x-mode': 'b' } } });
    expect((calls[0]!.init.headers as Record<string, string>)['x-mode']).toBe('b');
  });

  it('sets content-type only when there is a body', async () => {
    const { client: c, calls } = client([json({}), json({})]);
    await c.request({ method: 'get', path: '/x' });
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBeUndefined();
    await c.request({ method: 'post', path: '/x', body: { a: 1 } });
    expect((calls[1]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('tolerates a trailing slash on baseURL', async () => {
    const { client: c, calls } = client([json({})], { baseURL: 'https://api.test/api/' });
    await c.request({ method: 'get', path: '/assets' });
    expect(calls[0]!.url).toBe('https://api.test/api/assets');
  });
});

describe('map coercion', () => {
  it('turns an empty array into an empty map', () => {
    // The PHP artifact: `[]` for an empty associative array.
    expect(mapFromWire([])).toEqual({});
  });

  it('passes a real map through', () => {
    expect(mapFromWire({ a: 1 })).toEqual({ a: 1 });
  });

  it('treats null and undefined as an empty map', () => {
    expect(mapFromWire(null)).toEqual({});
    expect(mapFromWire(undefined)).toEqual({});
  });

  it('does not silently discard a non-empty array', () => {
    // That would mean the server sent something unexpected; losing data is worse than a type
    // mismatch the caller can see.
    expect(mapFromWire([1, 2])).toEqual([1, 2]);
  });

  it('parses a Content-Range total', () => {
    expect(parseTotalCount('items 0-49/1275')).toBe(1275);
    expect(parseTotalCount('1275')).toBe(1275);
    expect(parseTotalCount(null)).toBeUndefined();
    expect(parseTotalCount('items 0-49/*')).toBeUndefined();
  });
});

describe('offset pagination', () => {
  const config: PaginationConfig = {
    style: 'offset',
    limitParam: 'limit',
    offsetParam: 'offset',
    totalSource: { kind: 'header', name: 'X-Content-Range' },
    itemsSource: { kind: 'root' },
  };

  /** Serve `total` items in pages of `limit`, reporting the total in a header. */
  function pagedFetcher(total: number, limit: number) {
    const seen: Array<Record<string, string | number>> = [];
    const fetcher = async (params: Record<string, string | number>) => {
      seen.push({ ...params });
      const offset = Number(params['offset'] ?? 0);
      const items = Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, i) => ({ id: offset + i }),
      );
      return {
        data: items,
        response: new Response(JSON.stringify(items), {
          headers: { 'X-Content-Range': `items ${offset}-${offset + items.length}/${total}` },
        }),
      };
    };
    return { fetcher, seen };
  }

  it('iterates every item across pages', async () => {
    const { fetcher } = pagedFetcher(25, 10);
    const paginator = new Paginator<{ id: number }>(config, fetcher, { limit: 10 });
    const ids: number[] = [];
    for await (const item of paginator) ids.push(item.id);
    expect(ids).toHaveLength(25);
    expect(ids[0]).toBe(0);
    expect(ids[24]).toBe(24);
  });

  it('advances the offset by items consumed', async () => {
    const { fetcher, seen } = pagedFetcher(25, 10);
    await new Paginator<{ id: number }>(config, fetcher, { limit: 10 }).all();
    expect(seen.map((p) => p['offset'] ?? 0)).toEqual([0, 10, 20]);
  });

  it('awaiting the paginator gives the first page only', async () => {
    const { fetcher, seen } = pagedFetcher(25, 10);
    const page = await new Paginator<{ id: number }>(config, fetcher, { limit: 10 });
    expect(page).toBeInstanceOf(Page);
    expect(page.items).toHaveLength(10);
    expect(page.total).toBe(25);
    expect(page.hasNextPage).toBe(true);
    expect(seen).toHaveLength(1); // lazy: no extra requests
  });

  it('walks pages explicitly', async () => {
    const { fetcher } = pagedFetcher(25, 10);
    const sizes: number[] = [];
    for await (const page of new Paginator<{ id: number }>(config, fetcher, { limit: 10 }).pages()) {
      sizes.push(page.items.length);
    }
    expect(sizes).toEqual([10, 10, 5]);
  });

  it('stops on a short page', async () => {
    const { fetcher, seen } = pagedFetcher(15, 10);
    await new Paginator<{ id: number }>(config, fetcher, { limit: 10 }).all();
    expect(seen).toHaveLength(2);
  });

  it('stops exactly at the reported total when the last page is full', async () => {
    // The dangerous case: 20 items in pages of 10 means page 2 is full, so only the total
    // tells us to stop. Without it this loops forever.
    const { fetcher, seen } = pagedFetcher(20, 10);
    const items = await new Paginator<{ id: number }>(config, fetcher, { limit: 10 }).all();
    expect(items).toHaveLength(20);
    expect(seen).toHaveLength(2);
  });

  it('stops on an empty first page', async () => {
    const { fetcher, seen } = pagedFetcher(0, 10);
    expect(await new Paginator<{ id: number }>(config, fetcher, { limit: 10 }).all()).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('does not loop forever when no limit was supplied', async () => {
    // With neither a limit nor a way to detect a short page, one request is all we can justify.
    const noTotal: PaginationConfig = { style: 'offset', offsetParam: 'offset', itemsSource: { kind: 'root' } };
    const { fetcher, seen } = pagedFetcher(100, 10);
    await new Paginator<{ id: number }>(noTotal, fetcher, {}).all();
    expect(seen).toHaveLength(1);
  });

  it('is iterable per page with a plain for-of', async () => {
    const { fetcher } = pagedFetcher(5, 10);
    const page = await new Paginator<{ id: number }>(config, fetcher, { limit: 10 });
    expect([...page].map((i) => i.id)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('cursor pagination', () => {
  const config: PaginationConfig = {
    style: 'cursor',
    limitParam: 'limit',
    cursorParam: 'cursor',
    cursorSource: { kind: 'body', path: ['next'] },
    itemsSource: { kind: 'body', path: ['data'] },
  };

  it('follows the cursor until the server stops sending one', async () => {
    const pages = [
      { data: [{ id: 1 }], next: 'c1' },
      { data: [{ id: 2 }], next: 'c2' },
      { data: [{ id: 3 }] },
    ];
    const cursors: Array<string | undefined> = [];
    let call = 0;
    const fetcher = async (params: Record<string, string | number>) => {
      cursors.push(params['cursor'] as string | undefined);
      const body = pages[call++]!;
      return { data: body, response: new Response(JSON.stringify(body)) };
    };
    const items = await new Paginator<{ id: number }>(config, fetcher, { limit: 1 }).all();
    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(cursors).toEqual([undefined, 'c1', 'c2']);
  });

  it('reads items from a nested body path', async () => {
    const body = { data: [{ id: 9 }] };
    const fetcher = async () => ({ data: body, response: new Response(JSON.stringify(body)) });
    const page = await new Paginator<{ id: number }>(config, fetcher, {});
    expect(page.items).toEqual([{ id: 9 }]);
  });
});

describe('structured query parameters', () => {
  it('serializes a nested object as deepObject brackets', () => {
    // Stripe's range queries: `created[gte]=…`. A scalar-only type made these a compile error.
    expect(buildQuery({ created: { gte: 100, lt: 200 } })).toBe(
      '?created%5Bgte%5D=100&created%5Blt%5D=200',
    );
  });

  it('indexes an array of objects so elements stay distinguishable', () => {
    // Box's search filters are an array of objects; repeating the bare key would lose the grouping.
    expect(buildQuery({ filter: [{ field: 'a' }, { field: 'b' }] })).toBe(
      '?filter%5B0%5D%5Bfield%5D=a&filter%5B1%5D%5Bfield%5D=b',
    );
  });

  it('still repeats the key for scalar arrays', () => {
    expect(buildQuery({ type: ['a', 'b'] })).toBe('?type=a&type=b');
  });

  it('bounds nesting depth rather than following a cycle', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => buildQuery({ q: cyclic as never })).not.toThrow();
  });

  it('drops null and undefined header values', () => {
    expect(compact({ a: 'x', b: undefined, c: null, d: 3 })).toEqual({ a: 'x', d: '3' });
  });
});

describe('retry safety by method', () => {
  /** Counts attempts for a request that always fails retryably. */
  async function attempts(
    method: string,
    options?: { idempotencyKey?: string },
  ): Promise<number> {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    });
    const client = new BaseClient({
      baseURL: 'https://api.test',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      maxRetries: 2,
    });
    try {
      await client.request({
        method,
        path: '/things',
        responseType: 'json',
        ...(options !== undefined ? { options } : {}),
      });
    } catch {
      // Expected: it fails after exhausting whatever retries it was entitled to.
    }
    return calls;
  }

  // One test per method rather than a loop. Retries use real jittered backoff, so five methods in
  // one `it` ran for most of the 5s budget and timed out once the fifth was added — a failure that
  // says nothing about the behaviour under test. Split, each method gets its own budget and names
  // itself when it fails.
  it.each(['get', 'head', 'put', 'delete', 'options'])(
    'retries %s, which HTTP defines as idempotent',
    async (method) => {
      expect(await attempts(method)).toBe(3);
    },
  );

  it('does not retry POST or PATCH without an idempotency key', async () => {
    // The bug this pins: a `POST /charges` returning 503 was sent three times, and whether the server
    // processed the first one is unknowable from here. The plausible outcome was three charges.
    expect(await attempts('post')).toBe(1);
    expect(await attempts('patch')).toBe(1);
  });

  it('retries POST when an idempotency key is supplied', async () => {
    // Deduplication happens on the server. A key is the only thing that makes the replay safe.
    expect(await attempts('post', { idempotencyKey: 'req_abc' })).toBe(3);
  });

  it('sends the key, unchanged, on every attempt', async () => {
    // One key per logical request, never per attempt — the server has to recognise the replay.
    const seen: string[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers['idempotency-key'] ?? '(absent)');
      if (calls < 2) return new Response('{}', { status: 503 });
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new BaseClient({
      baseURL: 'https://api.test',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      maxRetries: 2,
    });
    await client.request({
      method: 'post',
      path: '/charges',
      responseType: 'json',
      options: { idempotencyKey: 'key_1' },
    });
    expect(seen).toEqual(['key_1', 'key_1']);
  });

  it('honours a configured header name', async () => {
    // Not standardised: `Idempotency-Key`, `X-Idempotency-Key`, and `Idempotency-Token` are all real.
    let seen: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new BaseClient({
      baseURL: 'https://api.test',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      idempotencyHeader: 'X-Idempotency-Token',
      maxRetries: 0,
    });
    await client.request({
      method: 'post',
      path: '/charges',
      responseType: 'json',
      options: { idempotencyKey: 'key_1' },
    });
    expect(seen['x-idempotency-token']).toBe('key_1');
  });

  it('does not retry a non-retryable failure even with a key', async () => {
    // A 400 was understood and rejected. An idempotency key does not make it worth resending.
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } });
    });
    const client = new BaseClient({
      baseURL: 'https://api.test',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      maxRetries: 2,
    });
    await expect(
      client.request({
        method: 'post',
        path: '/charges',
        responseType: 'json',
        options: { idempotencyKey: 'k' },
      }),
    ).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });
});
