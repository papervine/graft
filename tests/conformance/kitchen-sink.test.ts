/**
 * Conformance tests for the kitchen-sink SDK.
 *
 * Covers the constructs `corpus/pixwel` never exercises: discriminated unions, allOf
 * composition, cursor pagination through an envelope, text and binary responses, SSE streaming,
 * and multipart uploads. Each of these was broken when the fixture was first written, and each
 * bug was invisible to `tsc` — an empty `interface Member {}` typechecks perfectly.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  KitchenSink,
  type Event,
  type Member,
  type MemberInvitedEvent,
  type ValidationError,
} from '../../sdks/kitchen-sink/src/index.js';

interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function mockServer(handler: (request: Recorded, index: number) => Response) {
  const requests: Recorded[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const recorded: Recorded = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body,
    };
    requests.push(recorded);
    return handler(recorded, requests.length - 1);
  });
  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: typeof globalThis.fetch) {
  return new KitchenSink({ baseURL: 'https://api.test/v1', fetch: fetchImpl, maxRetries: 0 });
}

const MEMBER: Member = { id: 'm1', email: 'a@b.com', role: 'admin' };

describe('allOf composition', () => {
  it('produces a flat type carrying fields from every member', async () => {
    const { fetchImpl } = mockServer(() => json({ data: [MEMBER], has_more: false }));
    const page = await client(fetchImpl).orgs.listMembers('o1');
    const member = page.items[0]!;

    // The regression this pins: reading only `properties` yielded `interface Member {}`, which
    // typechecks and is useless. Every one of these fields comes from a different allOf member.
    expect(member.id).toBe('m1'); // from Identified
    expect(member.email).toBe('a@b.com'); // from the inline member
    expect(member.role).toBe('admin');
  });

  it('keeps required-ness from the composed members', () => {
    // @ts-expect-error `email` and `role` are required by the second allOf member.
    const invalid: Member = { id: 'm1' };
    void invalid;
  });

  it('models both nullability dialects', () => {
    // 3.0 `nullable: true` and 3.1 `type: [string, 'null']` must both become `| null`.
    const member: Member = { id: 'm1', email: 'e', role: 'member', display_name: null };
    expect(member.display_name).toBeNull();
  });
});

describe('discriminated unions', () => {
  it('narrows on the discriminator property', () => {
    const event: Event = { type: 'member.invited', member: MEMBER };
    // The whole point of a discriminated union: this narrows with no cast.
    if (event.type === 'member.invited') {
      const invited: MemberInvitedEvent = event;
      expect(invited.member.email).toBe('a@b.com');
    } else {
      expect.unreachable('discriminator did not narrow');
    }
  });

  it('rejects a variant that does not match its discriminator', () => {
    // @ts-expect-error `invoice` does not belong to the member.invited variant.
    const invalid: Event = { type: 'member.invited', invoice: { id: 'i1' } };
    void invalid;
  });

  it('sends a union body as JSON', async () => {
    const { fetchImpl, requests } = mockServer(() => json({ accepted: true }, 202));
    const receipt = await client(fetchImpl).events.publish({
      type: 'member.invited',
      member: MEMBER,
    });
    expect(receipt.accepted).toBe(true);
    expect(JSON.parse(requests[0]!.body as string)).toMatchObject({ type: 'member.invited' });
  });
});

describe('cursor pagination through an envelope', () => {
  it('follows next_cursor until the server stops sending one', async () => {
    const pages = [
      { data: [{ id: 'm1', email: 'a', role: 'admin' }], next_cursor: 'c1', has_more: true },
      { data: [{ id: 'm2', email: 'b', role: 'member' }], next_cursor: null, has_more: false },
    ];
    const { fetchImpl, requests } = mockServer((_r, index) => json(pages[index] ?? pages[1]));

    const ids: string[] = [];
    for await (const member of client(fetchImpl).orgs.listMembers('o1', { limit: 1 })) {
      ids.push(member.id);
    }

    expect(ids).toEqual(['m1', 'm2']);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url.searchParams.get('cursor')).toBeNull();
    expect(requests[1]?.url.searchParams.get('cursor')).toBe('c1');
  });

  it('yields items typed from inside the envelope', async () => {
    // `Paginator<unknown>` was the bug: the emitter could not see through `{ data: [...] }`.
    const { fetchImpl } = mockServer(() => json({ data: [MEMBER], has_more: false }));
    for await (const member of client(fetchImpl).orgs.listMembers('o1')) {
      const email: string = member.email;
      expect(email).toBe('a@b.com');
    }
  });

  it('interpolates the path parameter', async () => {
    const { fetchImpl, requests } = mockServer(() => json({ data: [], has_more: false }));
    await client(fetchImpl).orgs.listMembers('org 1');
    expect(requests[0]?.url.pathname).toBe('/v1/orgs/org%201/members');
  });
});

describe('content types', () => {
  it('returns a text/csv body as a string', async () => {
    const { fetchImpl } = mockServer(
      () => new Response('a,b\n1,2\n', { headers: { 'content-type': 'text/csv' } }),
    );
    const csv = await client(fetchImpl).reports.exportUsage();
    // Typed as `string`, not `Blob`: unwrapping text from a Blob is pure friction.
    expect(csv).toBe('a,b\n1,2\n');
  });

  it('returns a PDF as a Blob', async () => {
    const { fetchImpl } = mockServer(
      () => new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } }),
    );
    const pdf = await client(fetchImpl).orgs.invoices.downloadPdf('o1', 'i1');
    expect(pdf).toBeInstanceOf(Blob);
    expect(await pdf.text()).toBe('%PDF-1.4');
  });

  it('sends a multipart body as FormData, letting fetch set the boundary', async () => {
    const { fetchImpl, requests } = mockServer(() => json({ id: 'u1', url: 'x', bytes: 3 }, 201));
    await client(fetchImpl).uploads.create({
      file: new Blob(['abc']),
      filename: 'abc.txt',
    });
    const request = requests[0]!;
    expect(request.body).toBeInstanceOf(FormData);
    // An explicit content-type here would break the boundary fetch generates.
    expect(request.headers['content-type']).toBeUndefined();
    const form = request.body as FormData;
    expect(form.get('filename')).toBe('abc.txt');
  });
});

describe('server-sent events', () => {
  it('yields typed events as they arrive', async () => {
    const body = [
      'data: {"type":"member.invited","member":{"id":"m1","email":"a","role":"admin"}}\n\n',
      'data: {"type":"invoice.paid","invoice":{"id":"i1","amount_cents":100,"currency":"usd"}}\n\n',
    ].join('');
    const { fetchImpl } = mockServer(
      () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    );

    const kinds: string[] = [];
    for await (const event of client(fetchImpl).events.stream()) {
      kinds.push(event.type);
    }
    expect(kinds).toEqual(['member.invited', 'invoice.paid']);
  });
});

describe('error schemas declared in the spec', () => {
  it('exposes the declared 422 body', async () => {
    const body: ValidationError = {
      message: 'bad',
      errors: [{ field: 'email', code: 'invalid' }],
    };
    const { fetchImpl } = mockServer(() => json(body, 422));
    try {
      await client(fetchImpl).events.publish({ type: 'member.invited', member: MEMBER });
      expect.unreachable('should have thrown');
    } catch (error) {
      // `ValidationError` was silently dropped before error schemas were converted.
      expect((error as { body: ValidationError }).body.errors[0]?.field).toBe('email');
    }
  });
});

describe('self-referential types', () => {
  it('models a recursive tree without inlining forever', async () => {
    const { fetchImpl } = mockServer(() =>
      json([{ slug: 'a', name: 'A', children: [{ slug: 'b', name: 'B' }] }]),
    );
    const categories = await client(fetchImpl).categories.list();
    expect(categories[0]?.children?.[0]?.slug).toBe('b');
  });
});

describe('api key auth', () => {
  it('sends the key in the header the spec names', async () => {
    const { fetchImpl, requests } = mockServer(() => json([]));
    const sdk = new KitchenSink({
      baseURL: 'https://api.test/v1',
      apiKey: 'k_123',
      fetch: fetchImpl,
      maxRetries: 0,
    });
    await sdk.categories.list();
    expect(requests[0]?.headers['x-api-key']).toBe('k_123');
  });
});
