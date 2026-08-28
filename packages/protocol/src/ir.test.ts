import { describe, expect, it } from 'vitest';
import {
  IR_VERSION,
  IRSchema,
  ResourceSchema,
  TypeRefSchema,
  parseIR,
  type IR,
  type TypeRef,
} from './ir.js';
import { isSafeOutputPath, parseTargetOutput, satisfiesIrVersion } from './target.js';

const emptyDocs = {};

/** The smallest IR that should be considered valid — a service with nothing in it. */
function minimalIR(): IR {
  return {
    irVersion: IR_VERSION,
    service: {
      name: { tokens: ['pixwel'] },
      version: '2.8',
      docs: emptyDocs,
      servers: [{ id: 'production', url: 'https://api.example.com', default: true }],
      auth: [{ kind: 'bearer', id: 'BearerAuth', tokenPrefix: 'pat_', docs: emptyDocs }],
      constantHeaders: { Accept: 'application/json' },
    },
    types: [],
    resources: [],
    errors: { byStatus: [] },
    pagination: [],
  };
}

describe('IR contract', () => {
  it('accepts a minimal IR and round-trips through JSON unchanged', () => {
    const ir = minimalIR();
    // JSON round-trip is the actual contract: the IR crosses a subprocess boundary as text.
    const reparsed = parseIR(JSON.parse(JSON.stringify(ir)));
    expect(reparsed).toEqual(ir);
  });

  it('rejects an IR missing a required section rather than defaulting it', () => {
    const { errors, ...withoutErrors } = minimalIR();
    void errors;
    expect(() => parseIR(withoutErrors)).toThrow();
  });

  it('rejects a pre-cased name, since casing is a target concern', () => {
    // Guards the §3.2 invariant: names are token sequences. A single "userId" token is
    // technically well-formed, so this test pins the *shape*, not the casing — the point is
    // that `tokens` is an array and cannot be a bare string.
    const bad = { ...minimalIR(), service: { ...minimalIR().service, name: 'pixwel' } };
    expect(() => parseIR(bad)).toThrow();
  });
});

describe('TypeRef recursion', () => {
  it('validates deeply nested composites', () => {
    const deep: TypeRef = {
      kind: 'array',
      items: {
        kind: 'map',
        values: {
          kind: 'nullable',
          inner: {
            kind: 'union',
            variants: [
              { kind: 'primitive', type: 'string' },
              { kind: 'named', id: 'Asset' },
            ],
          },
        },
      },
    };
    expect(TypeRefSchema.parse(deep)).toEqual(deep);
  });

  it('carries the PHP empty-map artifact as a map, never a union', () => {
    // SPEC.md §3.1.2. If this ever needs to become a union to typecheck, the normalizer
    // contract has regressed and every SDK user pays for it.
    const phpMap: TypeRef = {
      kind: 'map',
      values: { kind: 'array', items: { kind: 'primitive', type: 'string' } },
      emptyWireValue: 'array',
    };
    const parsed = TypeRefSchema.parse(phpMap);
    expect(parsed).toEqual(phpMap);
    expect(parsed.kind).toBe('map');
  });

  it('requires a union to have at least two variants', () => {
    expect(() =>
      TypeRefSchema.parse({ kind: 'union', variants: [{ kind: 'unknown' }] }),
    ).toThrow();
  });

  it('rejects an unknown type kind instead of passing it through', () => {
    expect(() => TypeRefSchema.parse({ kind: 'any' })).toThrow();
  });
});

describe('Resource recursion', () => {
  it('validates nested subresources', () => {
    const resource = {
      id: 'assets',
      name: { tokens: ['assets'] },
      docs: emptyDocs,
      methods: [
        {
          name: { tokens: ['list'] },
          operationId: 'listAssets',
          docs: emptyDocs,
          deprecated: false,
          http: { verb: 'get' as const, path: '/assets', params: [] },
          response: {
            kind: 'json' as const,
            statusCode: 200,
            type: { kind: 'array' as const, items: { kind: 'named' as const, id: 'Asset' } },
          },
          paginationId: 'offset',
        },
      ],
      subresources: [
        {
          id: 'assets.previews',
          name: { tokens: ['previews'] },
          docs: emptyDocs,
          methods: [],
          subresources: [],
        },
      ],
    };
    expect(ResourceSchema.parse(resource)).toEqual(resource);
  });
});

describe('read/write split representation', () => {
  it('distinguishes presence from nullability on a field', () => {
    // The disambiguation SPEC.md §3.1 demands: `required` is presence, `nullable` is value.
    // A field that is absent-able AND null-able must be expressible as both at once.
    const ir = minimalIR();
    ir.types = [
      {
        kind: 'object',
        id: 'Asset',
        name: { tokens: ['asset'] },
        docs: emptyDocs,
        role: 'read',
        cyclic: false,
        fields: [
          {
            name: { tokens: ['id'] },
            wireName: '_id',
            type: { kind: 'primitive', type: 'string' },
            required: true,
            serverOwned: true,
            readOnly: true,
            writeOnly: false,
            deprecated: false,
            docs: emptyDocs,
          },
          {
            name: { tokens: ['retired', 'at'] },
            wireName: 'retiredAt',
            type: { kind: 'nullable', inner: { kind: 'primitive', type: 'string', format: 'date-time' } },
            required: false,
            serverOwned: false,
            readOnly: false,
            writeOnly: false,
            deprecated: false,
            docs: emptyDocs,
          },
        ],
      },
    ];
    const parsed = parseIR(JSON.parse(JSON.stringify(ir)));
    const asset = parsed.types[0];
    expect(asset?.kind).toBe('object');
    if (asset?.kind !== 'object') throw new Error('unreachable');

    const [id, retiredAt] = asset.fields;
    // wireName must survive verbatim; `_id` does not round-trip through any casing rule.
    expect(id?.wireName).toBe('_id');
    expect(id?.serverOwned).toBe(true);
    expect(retiredAt?.required).toBe(false);
    expect(retiredAt?.type.kind).toBe('nullable');
  });
});

describe('target output safety', () => {
  it('accepts ordinary relative paths', () => {
    expect(isSafeOutputPath('src/resources/assets.ts')).toBe(true);
    expect(isSafeOutputPath('package.json')).toBe(true);
  });

  it('rejects paths that escape the output directory', () => {
    // A manifest is untrusted input: targets are third-party executables.
    for (const p of ['../etc/passwd', 'a/../../b', '/abs/path', 'C:\\win', '', 'a/./b', 'a//b']) {
      expect(isSafeOutputPath(p), p).toBe(false);
    }
  });

  it('parses a well-formed manifest', () => {
    const out = parseTargetOutput({
      files: [{ path: 'src/index.ts', contents: 'export {};\n' }],
      warnings: [],
    });
    expect(out.files).toHaveLength(1);
  });

  it('rejects a manifest whose diagnostics are malformed', () => {
    expect(() =>
      parseTargetOutput({ files: [], warnings: [{ severity: 'catastrophe', code: 'X', message: 'm' }] }),
    ).toThrow();
  });
});

describe('IR version', () => {
  it('is a plain semver triple, because targets range-match on it', () => {
    expect(IR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is what IRSchema expects to see', () => {
    expect(IRSchema.parse(minimalIR()).irVersion).toBe(IR_VERSION);
  });
});

describe('IR version compatibility', () => {
  it('accepts a matching major with an x minor', () => {
    expect(satisfiesIrVersion('1.2.0', ['1.x'])).toBe(true);
    expect(satisfiesIrVersion('1.0.0', ['1.x'])).toBe(true);
  });

  it('rejects a different major', () => {
    // A target reading an IR it does not understand produces a subtly wrong SDK, so this is a
    // hard error at the handshake rather than a warning.
    expect(satisfiesIrVersion('2.0.0', ['1.x'])).toBe(false);
    expect(satisfiesIrVersion('1.2.0', ['0.x'])).toBe(false);
  });

  it('accepts an exact match and a wildcard', () => {
    expect(satisfiesIrVersion('1.2.0', ['1.2.0'])).toBe(true);
    expect(satisfiesIrVersion('9.9.9', ['*'])).toBe(true);
  });

  it('accepts when any one range matches', () => {
    expect(satisfiesIrVersion('1.2.0', ['0.x', '1.x'])).toBe(true);
  });

  it('rejects an empty range list', () => {
    expect(satisfiesIrVersion('1.2.0', [])).toBe(false);
  });
});
