/**
 * Synthesized example data (SPEC.md §3.11).
 *
 * These pin judgments that are cheap to get wrong and expensive to notice, because the same values feed
 * two consumers with opposite needs: a *documentation example*, which wants to be short, and a *test
 * fixture*, which must be complete enough to survive the SDK's own response validation. Every assertion
 * below corresponds to a bug that shipped and was caught by running the generated suite rather than by
 * reading the code.
 */

import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { buildIR, inspectSpec } from './index.js';
import type { Method } from '@graft/protocol';

function build(paths: unknown, schemas: unknown = {}, config: Parameters<typeof buildIR>[1] = {}) {
  const yaml = stringify({
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    paths,
    components: { schemas },
  });
  return buildIR(inspectSpec(yaml, 'test.yaml'), config).ir;
}

/**
 * Pagination is opt-in through config, exactly like the read/write split — the spec only corroborates it.
 * So a test about paginated fixtures has to supply the scheme, or it silently tests the unpaginated path.
 */
const CURSOR_PAGINATION = {
  pagination: {
    default: { style: 'cursor' as const, limit: 'limit', cursor: 'cursor', items: 'body:data', cursorFrom: 'body:next_cursor' },
  },
};

function method(ir: ReturnType<typeof build>, operationId: string): Method {
  const found: Method[] = [];
  const walk = (resources: typeof ir.resources): void => {
    for (const resource of resources) {
      found.push(...resource.methods.filter((m) => m.operationId === operationId));
      walk(resource.subresources);
    }
  };
  walk(ir.resources);
  const first = found[0];
  if (first === undefined) throw new Error(`no method for ${operationId}`);
  return first;
}

const okJson = (schema: unknown) => ({
  '200': { description: 'ok', content: { 'application/json': { schema } } },
});

describe('example synthesis', () => {
  it('never truncates required fields, however many there are', () => {
    // The bug: a six-field cap meant for readability was applied to required fields too, so a model with
    // seven required fields produced a fixture the SDK rejected — `revokedAt is required but was absent`.
    // Two operations out of 121 had such a model, which is exactly the coverage a per-operation suite adds.
    const required = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ir = build(
      { '/wide': { get: { operationId: 'getWide', responses: okJson({ $ref: '#/components/schemas/Wide' }) } } },
      {
        Wide: {
          type: 'object',
          required,
          properties: Object.fromEntries(required.map((name) => [name, { type: 'string' }])),
        },
      },
    );
    const response = method(ir, 'getWide').example?.response as Record<string, unknown>;
    expect(Object.keys(response).sort()).toEqual(required);
  });

  it('prefers the spec\'s own scalar example over a synthesized placeholder', () => {
    const ir = build(
      { '/w': { get: { operationId: 'getW', responses: okJson({ $ref: '#/components/schemas/W' }) } } },
      {
        W: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', example: 'Sprocket' } },
        },
      },
    );
    expect(method(ir, 'getW').example?.response).toEqual({ name: 'Sprocket' });
  });

  it('gives a recognised format a value of that shape, not a placeholder', () => {
    // `'...'` in a `date-time` field would fail the SDK's own validation, so the fixture would assert a
    // bug that is not there.
    const ir = build(
      { '/w': { get: { operationId: 'getW', responses: okJson({ $ref: '#/components/schemas/W' }) } } },
      {
        W: {
          type: 'object',
          required: ['createdAt', 'email'],
          properties: {
            createdAt: { type: 'string', format: 'date-time' },
            email: { type: 'string', format: 'email' },
          },
        },
      },
    );
    expect(method(ir, 'getW').example?.response).toEqual({
      createdAt: '2024-01-01T00:00:00Z',
      email: 'you@example.com',
    });
  });

  it('puts one element in an array, not zero', () => {
    // An empty array exercises no decoding of the element type, so a test asserting it proves only that
    // the SDK can parse `[]`.
    const ir = build({
      '/w': {
        get: { operationId: 'getW', responses: okJson({ type: 'array', items: { type: 'string' } }) },
      },
    });
    expect(method(ir, 'getW').example?.response).toEqual(['...']);
  });

  it('includes path parameters and required query parameters, and omits optional ones', () => {
    // The omission is the assertion that matters: it is what lets a generated test check that an absent
    // optional parameter does not reach the wire at all.
    const ir = build({
      '/orgs/{orgId}/members': {
        get: {
          operationId: 'listMembers',
          parameters: [
            { name: 'orgId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'since', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: okJson({ type: 'array', items: { type: 'string' } }),
        },
      },
    });
    const example = method(ir, 'listMembers').example;
    expect(Object.keys(example?.params ?? {}).sort()).toEqual(['orgId', 'q']);
  });

  it('omits a response for anything with no body to decode', () => {
    // `example.response !== undefined` has to mean "there is a body worth asserting", or a target cannot
    // use it to decide whether to emit a decode assertion — and a 204 may not carry a body at all.
    const ir = build({
      '/w/{id}': {
        delete: {
          operationId: 'deleteW',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '204': { description: 'gone' } },
        },
      },
    });
    expect(method(ir, 'deleteW').example?.response).toBeUndefined();
  });

  it('uses the first enum member so the value is always a legal one', () => {
    const ir = build(
      { '/w': { get: { operationId: 'getW', responses: okJson({ $ref: '#/components/schemas/W' }) } } },
      {
        W: {
          type: 'object',
          required: ['role'],
          properties: { role: { type: 'string', enum: ['owner', 'member'] } },
        },
      },
    );
    expect(method(ir, 'getW').example?.response).toEqual({ role: 'owner' });
  });

  it('terminates a paginated fixture, so draining it cannot request a second page', () => {
    // Without this the nullable cursor gets its *present* value — `valueFor` deliberately prefers the
    // present case — and a generated test that drains the paginator asks for a page the fixture cannot
    // serve.
    const ir = build(
      {
        '/members': {
          get: {
            operationId: 'listMembers',
            parameters: [
              { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
              { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
            ],
            responses: okJson({ $ref: '#/components/schemas/Page' }),
          },
        },
      },
      {
        Page: {
          type: 'object',
          required: ['data'],
          properties: {
            data: { type: 'array', items: { type: 'string' } },
            next_cursor: { type: ['string', 'null'] },
          },
        },
      },
      CURSOR_PAGINATION,
    );
    const target = method(ir, 'listMembers');
    // Only meaningful if the operation was actually detected as paginated; otherwise the assertion below
    // would pass for the wrong reason.
    expect(target.paginationId).toBeDefined();
    const response = target.example?.response as Record<string, unknown>;
    expect(response['next_cursor']).toBeNull();
  });

  it('does not double-wrap a paginated response', () => {
    // `Method.response.type` for a paginated method is already the envelope the server returns. The first
    // version assumed it was the item and wrapped it again, producing a shape no API returns — which a
    // generated test would then have asserted as correct.
    const ir = build(
      {
        '/members': {
          get: {
            operationId: 'listMembers',
            parameters: [
              { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
              { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
            ],
            responses: okJson({ $ref: '#/components/schemas/Page' }),
          },
        },
      },
      {
        Page: {
          type: 'object',
          required: ['data'],
          properties: {
            data: { type: 'array', items: { type: 'string' } },
            next_cursor: { type: ['string', 'null'] },
          },
        },
      },
      CURSOR_PAGINATION,
    );
    const response = method(ir, 'listMembers').example?.response as Record<string, unknown>;
    expect(response['data']).toEqual(['...']);
  });

  it('attaches an example to every method, including nested resources', () => {
    // A target that has to decide whether values exist ends up synthesizing its own, which is the whole
    // thing this module exists to prevent.
    const ir = build({
      '/orgs/{orgId}/invoices': {
        get: {
          operationId: 'listInvoices',
          'x-graft-group': 'orgs.invoices',
          parameters: [{ name: 'orgId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: okJson({ type: 'array', items: { type: 'string' } }),
        },
      },
    });
    const seen: boolean[] = [];
    const walk = (resources: typeof ir.resources): void => {
      for (const resource of resources) {
        seen.push(...resource.methods.map((m) => m.example !== undefined));
        walk(resource.subresources);
      }
    };
    walk(ir.resources);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });
});
