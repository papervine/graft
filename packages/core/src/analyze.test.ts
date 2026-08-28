import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { inspectSpec } from './index.js';
import {
  extractProseHeader,
  findConstantHeaders,
  findPaginationCandidates,
  findReadWriteConflation,
  isPhpEmptyMapUnion,
  isScalarUnion,
  suggestModelName,
} from './analyze.js';
import { indexOperations } from './operations.js';
import { parseSpec } from './load.js';
import { resolveSpec } from './resolve.js';
import { structuralKey } from './json.js';

/** Build a spec from a plain object so each test states only what it is about. */
function spec(body: Record<string, unknown>): string {
  return stringify({ openapi: '3.1.0', info: { title: 'T', version: '1' }, ...body });
}

function index(yaml: string) {
  const { spec: loaded } = parseSpec(yaml, 'test.yaml');
  const { resolved } = resolveSpec(loaded);
  return { resolved, index: indexOperations(loaded, resolved.resolve) };
}

function codes(yaml: string): string[] {
  return inspectSpec(yaml, 'test.yaml').analysis.diagnostics.map((d) => d.code);
}

describe('read/write conflation (M001)', () => {
  const conflated = spec({
    paths: {
      '/assets': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Asset' } },
                },
              },
            },
          },
        },
        post: {
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Asset' } } },
          },
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Asset' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: { Asset: { type: 'object', properties: { _id: { type: 'string' } } } },
    },
  });

  it('detects a schema used in both positions', () => {
    const found = findReadWriteConflation(index(conflated).index);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('Asset');
    // Must name the specific roles; "possible conflation" is not actionable.
    expect(found[0]?.roles).toContain('POST /assets request body');
    expect(found[0]?.roles).toContain('GET /assets → 200');
  });

  it('does not flag a schema used only in response position', () => {
    const responseOnly = spec({
      paths: {
        '/assets': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Asset' } } },
              },
            },
          },
        },
      },
      components: { schemas: { Asset: { type: 'object', properties: { _id: { type: 'string' } } } } },
    });
    expect(findReadWriteConflation(index(responseOnly).index)).toHaveLength(0);
  });

  it('proposes a singular read model name', () => {
    const diagnostic = inspectSpec(conflated, 't').analysis.diagnostics.find(
      (d) => d.code === 'M001',
    );
    expect(diagnostic?.fix).toContain('serverOwned');
  });
});

describe('suggestModelName', () => {
  it.each([
    ['AssetsResponse', 'Asset'],
    ['NotificationsResponse', 'Notification'],
    // Compound-split before recasing, so the suggestion is `AssetType`, not `Assettype`.
    ['AssettypesResponse', 'AssetType'],
    ['WorkrequestsResponse', 'WorkRequest'],
    ['CategoriesResponse', 'Category'],
    ['StatusResponse', 'Status'],
    ['Asset', 'Asset'],
  ])('%s → %s', (input, expected) => {
    expect(suggestModelName(input)).toBe(expected);
  });
});

describe('PHP empty-map union (T001)', () => {
  it('recognizes object-or-empty-array as a map', () => {
    expect(
      isPhpEmptyMapUnion({
        oneOf: [
          { type: 'object', additionalProperties: { type: 'string' } },
          { type: 'array', maxItems: 0 },
        ],
      }),
    ).toBe(true);
  });

  it('recognizes it in either branch order', () => {
    expect(
      isPhpEmptyMapUnion({
        oneOf: [{ type: 'array', maxItems: 0 }, { type: 'object' }],
      }),
    ).toBe(true);
  });

  it('leaves a genuine object-or-array union alone', () => {
    // No maxItems: 0, so the array branch can hold real elements. That is a real union.
    expect(
      isPhpEmptyMapUnion({
        oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'string' } }],
      }),
    ).toBe(false);
  });
});

describe('scalar union (T002)', () => {
  it('recognizes string-or-integer as loose encoding', () => {
    expect(isScalarUnion({ oneOf: [{ type: 'string' }, { type: 'integer' }] })).toBe(true);
  });

  it('does not treat an enum branch as a bare scalar', () => {
    expect(
      isScalarUnion({ oneOf: [{ type: 'string', enum: ['a'] }, { type: 'integer' }] }),
    ).toBe(false);
  });

  it('does not treat an object union as scalar', () => {
    expect(isScalarUnion({ oneOf: [{ type: 'object' }, { type: 'string' }] })).toBe(false);
  });
});

describe('constant headers (H001)', () => {
  const withAccept = (count: number): string => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) {
      paths[`/r${i}`] = {
        get: {
          parameters: [
            {
              name: 'Accept',
              in: 'header',
              schema: { type: 'string', default: 'application/json' },
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
      };
    }
    return spec({ paths });
  };

  it('hoists a header present with the same default on every operation', () => {
    const found = findConstantHeaders(index(withAccept(5)).index);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'Accept', value: 'application/json', operationCount: 5 });
  });

  it('leaves a header alone when its default varies', () => {
    const varying = spec({
      paths: {
        '/a': {
          get: {
            parameters: [{ name: 'X-Mode', in: 'header', schema: { type: 'string', default: 'a' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
        '/b': {
          get: {
            parameters: [{ name: 'X-Mode', in: 'header', schema: { type: 'string', default: 'b' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    expect(findConstantHeaders(index(varying).index)).toHaveLength(0);
  });

  it('leaves a header alone when it appears on only some operations', () => {
    const partial = spec({
      paths: {
        '/a': {
          get: {
            parameters: [{ name: 'X-Opt', in: 'header', schema: { type: 'string', default: 'x' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
        '/b': { get: { responses: { '200': { description: 'ok' } } } },
        '/c': { get: { responses: { '200': { description: 'ok' } } } },
      },
    });
    expect(findConstantHeaders(index(partial).index)).toHaveLength(0);
  });
});

describe('pagination inference (P001/P002)', () => {
  /** A GET with limit+offset whose 200 response is whatever `response` says. */
  const pageable = (response: unknown): string =>
    spec({
      paths: {
        '/assets': {
          get: {
            parameters: [
              {
                name: 'limit',
                in: 'query',
                schema: { type: 'integer' },
                description: 'Max records. Total comes back in `X-Content-Range`.',
              },
              { name: 'offset', in: 'query', schema: { type: 'integer' } },
            ],
            responses: { '200': response },
          },
        },
      },
      components: { schemas: { Asset: { type: 'object', properties: { _id: { type: 'string' } } } } },
    });

  const arrayResponse = {
    description: 'ok',
    content: {
      'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Asset' } } },
    },
  };

  it('confirms pagination when the response is an array', () => {
    const { resolved, index: idx } = index(pageable(arrayResponse));
    const candidates = findPaginationCandidates(idx, resolved.resolve);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      limitParam: 'limit',
      offsetParam: 'offset',
      proseTotalHeader: 'X-Content-Range',
      evidence: 'array',
    });
  });

  it('withholds pagination when the response has no schema', () => {
    // The corpus spec pastes limit/offset onto action endpoints like `reindex`. Paging
    // parameters alone must not produce an iterator over a non-collection.
    const { resolved, index: idx } = index(pageable({ description: 'ok' }));
    expect(findPaginationCandidates(idx, resolved.resolve)[0]?.evidence).toBe('unknown');
  });

  it('withholds pagination when the response is a single object', () => {
    const single = {
      description: 'ok',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Asset' } } },
    };
    const { resolved, index: idx } = index(pageable(single));
    expect(findPaginationCandidates(idx, resolved.resolve)[0]?.evidence).toBe('none');
  });

  it('reports confirmed and withheld pagination as separate diagnostics', () => {
    const mixed = spec({
      paths: {
        '/assets': {
          get: {
            parameters: [
              { name: 'limit', in: 'query', schema: { type: 'integer' } },
              { name: 'offset', in: 'query', schema: { type: 'integer' } },
            ],
            responses: { '200': arrayResponse },
          },
        },
        '/assets/reindex': {
          get: {
            parameters: [
              { name: 'limit', in: 'query', schema: { type: 'integer' } },
              { name: 'offset', in: 'query', schema: { type: 'integer' } },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      components: { schemas: { Asset: { type: 'object', properties: { _id: { type: 'string' } } } } },
    });
    const diagnostics = inspectSpec(mixed, 't').analysis.diagnostics;
    const confirmed = diagnostics.find((d) => d.code === 'P001');
    const withheld = diagnostics.find((d) => d.code === 'P002');
    expect(confirmed?.count).toBe(1);
    expect(confirmed?.severity).toBe('warn');
    expect(withheld?.count).toBe(1);
    // Withheld candidates are informational: nothing is wrong, we just decline to guess.
    expect(withheld?.severity).toBe('info');
  });

  it('does not treat a bare limit as pageable', () => {
    // A limit with no offset/page/cursor is a cap, not pagination.
    const capped = spec({
      paths: {
        '/assets': {
          get: {
            parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    expect(findPaginationCandidates(index(capped).index)).toHaveLength(0);
  });

  it('extracts a header name from prose, backticked or bare', () => {
    expect(extractProseHeader('total in `X-Total-Count` header')).toBe('X-Total-Count');
    expect(extractProseHeader('see X-Content-Range for the count')).toBe('X-Content-Range');
    expect(extractProseHeader('no header mentioned')).toBeUndefined();
    expect(extractProseHeader(undefined)).toBeUndefined();
  });
});

describe('spec tolerance', () => {
  it('reports a missing openapi version rather than failing', () => {
    const noVersion = stringify({ info: { title: 'T' }, paths: {} });
    expect(codes(noVersion)).toContain('S001');
  });

  it('reports Swagger 2.0 with a conversion hint', () => {
    const swagger = stringify({ swagger: '2.0', info: { title: 'T' }, paths: {} });
    const diagnostics = inspectSpec(swagger, 't').analysis.diagnostics;
    const found = diagnostics.find((d) => d.code === 'S001');
    expect(found?.detail?.join(' ')).toContain('swagger2openapi');
  });

  it('reports unresolvable refs instead of emitting a broken type', () => {
    const dangling = spec({
      paths: {
        '/a': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Nope' } } },
              },
            },
          },
        },
      },
    });
    const found = inspectSpec(dangling, 't').analysis.diagnostics.find(
      (d) => d.code === 'S001' && d.message.includes('$ref'),
    );
    expect(found?.message).toContain('could not be resolved');
  });

  it('throws a typed error, not a crash, on a non-mapping root', () => {
    expect(() => inspectSpec('- just\n- a\n- list\n', 'bad.yaml')).toThrow(/expected the document root/);
  });

  it('throws a typed error on unparseable input', () => {
    expect(() => inspectSpec('{{{not yaml', 'bad.yaml')).toThrow(/could not be parsed/);
  });
});

describe('reference cycles (T004)', () => {
  it('detects a mutual cycle without hanging', () => {
    const cyclic = spec({
      paths: {},
      components: {
        schemas: {
          A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
          B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } },
        },
      },
    });
    const { resolved } = index(cyclic);
    expect([...resolved.cyclic].sort()).toEqual(['A', 'B']);
  });

  it('detects a self-reference', () => {
    const selfRef = spec({
      paths: {},
      components: {
        schemas: {
          Node: { type: 'object', properties: { parent: { $ref: '#/components/schemas/Node' } } },
        },
      },
    });
    expect([...index(selfRef).resolved.cyclic]).toEqual(['Node']);
  });

  it('does not flag a merely deep acyclic graph', () => {
    const deep = spec({
      paths: {},
      components: {
        schemas: {
          A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
          B: { type: 'object', properties: { c: { $ref: '#/components/schemas/C' } } },
          C: { type: 'object', properties: { x: { type: 'string' } } },
        },
      },
    });
    expect([...index(deep).resolved.cyclic]).toEqual([]);
  });
});

describe('structuralKey', () => {
  it('ignores key order so identical shapes dedupe', () => {
    expect(structuralKey({ a: 1, b: 2 })).toBe(structuralKey({ b: 2, a: 1 }));
  });

  it('distinguishes different shapes', () => {
    expect(structuralKey({ a: 1 })).not.toBe(structuralKey({ a: '1' }));
  });

  it('respects array order', () => {
    expect(structuralKey([1, 2])).not.toBe(structuralKey([2, 1]));
  });
});

describe('inline schema counting', () => {
  it('does not count an array-of-$ref wrapper as an anonymous schema', () => {
    // `{type: array, items: {$ref}}` needs no synthesized name — the target spells the list.
    // Counting it overstates how much naming work a spec requires.
    const wrapped = spec({
      paths: {
        '/assets': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { type: 'array', items: { $ref: '#/components/schemas/Asset' } },
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: { Asset: { type: 'object', properties: { a: { type: 'string' } } } } },
    });
    expect(index(wrapped).index.inlineSchemas).toHaveLength(0);
  });

  it('does count a genuine anonymous object', () => {
    const anonymous = spec({
      paths: {
        '/a': {
          get: {
            responses: {
              '401': {
                description: 'nope',
                content: {
                  'application/json': {
                    schema: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(index(anonymous).index.inlineSchemas).toHaveLength(1);
  });
});

describe('parameter inheritance', () => {
  it('merges path-level parameters into each operation', () => {
    const inherited = spec({
      paths: {
        '/a/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          get: { responses: { '200': { description: 'ok' } } },
        },
      },
    });
    const ops = index(inherited).index.operations;
    expect(ops[0]?.parameters.map((p) => p.name)).toEqual(['id']);
  });

  it('lets an operation-level parameter override the path-level one', () => {
    const overridden = spec({
      paths: {
        '/a': {
          parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' } }],
          get: {
            parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const params = index(overridden).index.operations[0]?.parameters ?? [];
    expect(params).toHaveLength(1);
    expect(params[0]?.required).toBe(true);
  });
});
