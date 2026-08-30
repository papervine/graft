import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml, stringify } from 'yaml';
import { inspectSpec } from './inspect.js';
import { parseConfig } from './config.js';
import { renderInitConfig, scalar } from './init.js';

// The kitchen-sink fixture: ours, committed, and deliberately covering every construct, so these
// assertions do not depend on a third-party spec that could be re-pinned.
const CORPUS = new URL('../../../corpus/kitchen-sink/spec.yaml', import.meta.url);

function corpusInit(): string {
  const contents = readFileSync(CORPUS, 'utf8');
  const inspection = inspectSpec(contents, 'corpus/kitchen-sink/spec.yaml');
  return renderInitConfig(inspection, { specPath: 'corpus/kitchen-sink/spec.yaml' });
}

describe('scalar quoting', () => {
  it('quotes values starting with a YAML reserved indicator', () => {
    // The regression that motivated this: `@scope/sdk` emitted plain is invalid YAML, so
    // `graft init` produced a config `graft` itself could not read.
    for (const value of ['@pixwel/sdk', '%dir', '&anchor', '*alias', '!tag', '|block', '>fold']) {
      expect(scalar(value), value).toBe(JSON.stringify(value));
    }
  });

  it('quotes values that would open a mapping or comment', () => {
    expect(scalar('a: b')).toBe('"a: b"');
    expect(scalar('a #b')).toBe('"a #b"');
    expect(scalar('trailing:')).toBe('"trailing:"');
  });

  it('quotes words a YAML reader would coerce to a boolean or null', () => {
    for (const value of ['yes', 'no', 'true', 'off', 'null', 'N']) {
      expect(scalar(value), value).toBe(JSON.stringify(value));
    }
  });

  it('leaves genuinely safe values plain, so the file stays readable', () => {
    expect(scalar('typescript')).toBe('typescript');
    expect(scalar('application/json')).toBe('application/json');
    expect(scalar('Pixwel Platform')).toBe('Pixwel Platform');
    expect(scalar('sdks/typescript')).toBe('sdks/typescript');
  });

  it('quotes anything with structural punctuation', () => {
    expect(scalar('header:X-Content-Range')).toBe('"header:X-Content-Range"');
    expect(scalar('a,b')).toBe('"a,b"');
    expect(scalar('a[0]')).toBe('"a[0]"');
  });
});

describe('graft init output', () => {
  const generated = corpusInit();

  it('is valid YAML', () => {
    expect(() => parseYaml(generated)).not.toThrow();
  });

  it('round-trips through graft own config parser', () => {
    // The property that matters: whatever init writes, graft must accept. Without this the
    // scaffold can emit a config that fails on the very next command.
    expect(() => parseConfig(generated, 'graft.yaml')).not.toThrow();
  });

  it('records the spec path and service name', () => {
    const config = parseConfig(generated, 'graft.yaml');
    expect(config.spec).toBe('corpus/kitchen-sink/spec.yaml');
    expect(config.name).toBe('Kitchen Sink');
  });

  it('writes inferred pagination explicitly rather than leaving it implicit', () => {
    const config = parseConfig(generated, 'graft.yaml');
    // Cursor style, with the envelope paths written out — without those the runtime cannot find
    // the items.
    expect(config.pagination?.default).toMatchObject({
      style: 'cursor',
      limit: 'limit',
      cursor: 'cursor',
      items: 'body:data',
      cursorFrom: 'body:next_cursor',
    });
  });

  it('proposes a read/write split for conflated schemas', () => {
    const config = parseConfig(generated, 'graft.yaml');
    // `Event` is published as a request body and also streamed back, so it is flagged.
    expect(Object.keys(config.models ?? {})).toContain('Event');
  });

  it('suggests only server-owned fields that actually exist on the schema', () => {
    const config = parseConfig(generated, 'graft.yaml');
    for (const [schema, model] of Object.entries(config.models ?? {})) {
      for (const field of model.serverOwned ?? []) {
        // A name that matches nothing is the silent-typo failure mode; init must not invent one.
        expect(generated, `${schema}.${field}`).toContain(field);
      }
    }
  });

  it('marks the judgments graft cannot make', () => {
    expect(generated).toContain('REVIEW');
  });

  it('writes normalizer defaults out so they are visible and overridable', () => {
    const config = parseConfig(generated, 'graft.yaml');
    expect(config.normalize).toMatchObject({ phpEmptyMap: true, scalarUnion: 'widen' });
  });

  it('omits the headers block when no header is constant across operations', () => {
    // kitchen-sink has no such header; inventing one would put a lie in the config.
    const config = parseConfig(generated, 'graft.yaml');
    expect(config.headers?.constant ?? {}).toEqual({});
  });
});

describe('config parsing', () => {
  it('rejects an unknown top-level key instead of ignoring it', () => {
    // A typo'd key that silently does nothing is worse than a failed run: the user believes
    // they fixed something.
    expect(() => parseConfig('modles: {}\n', 'graft.yaml')).toThrow(/invalid config/);
  });

  it('rejects an unknown key inside a model', () => {
    expect(() => parseConfig('models:\n  A:\n    renmae: B\n', 'graft.yaml')).toThrow(
      /invalid config/,
    );
  });

  it('reports the path of the offending key', () => {
    expect(() => parseConfig('pagination:\n  default:\n    style: sideways\n', 'c.yaml')).toThrow(
      /pagination\.default\.style/,
    );
  });

  it('accepts an empty config', () => {
    expect(parseConfig('', 'graft.yaml')).toEqual({});
    expect(parseConfig('# just a comment\n', 'graft.yaml')).toEqual({});
  });

  it('accepts a partial config, so adoption can be incremental', () => {
    expect(parseConfig('normalize: { phpEmptyMap: false }\n', 'graft.yaml')).toEqual({
      normalize: { phpEmptyMap: false },
    });
  });

  it('validates the shorthand field syntax', () => {
    expect(() =>
      parseConfig('errors:\n  default:\n    schema:\n      error: strin\n', 'c.yaml'),
    ).toThrow(/expected one of string/);
    expect(() =>
      parseConfig('errors:\n  default:\n    schema:\n      error: string?\n', 'c.yaml'),
    ).not.toThrow();
  });

  it('validates value-source syntax', () => {
    expect(() =>
      parseConfig('pagination:\n  default:\n    style: offset\n    total: X-Total\n', 'c.yaml'),
    ).toThrow(/header:<Name>/);
    expect(() =>
      parseConfig(
        'pagination:\n  default:\n    style: offset\n    total: "header:X-Total"\n',
        'c.yaml',
      ),
    ).not.toThrow();
  });

  it('keeps target options opaque to the core', () => {
    // SPEC.md §3.7: the core must not grow knowledge of individual targets' settings.
    const config = parseConfig(
      'targets:\n  typescript:\n    out: sdks/ts\n    someTargetSpecificKnob: true\n',
      'c.yaml',
    );
    expect(config.targets?.['typescript']).toMatchObject({ someTargetSpecificKnob: true });
  });
});

describe('init emits config graft itself accepts', () => {
  it('narrows a non-scalar error field to unknown', () => {
    // GitHub's error body has an `errors` array. Emitting the spec's own `array` produced a config
    // that `parseConfig` rejected — init must never write config it would refuse to read.
    const spec = stringify({
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/a': {
          get: {
            operationId: 'a',
            responses: {
              '200': { description: 'ok' },
              // An untyped error response is what makes init write an `errors` block at all.
              '401': { description: 'unauthorized' },
              '422': {
                description: 'nope',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['message'],
                      properties: {
                        message: { type: 'string' },
                        errors: { type: 'array', items: { type: 'string' } },
                        meta: { type: 'object' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const generated = renderInitConfig(inspectSpec(spec, 't.yaml'), { specPath: 't.yaml' });
    expect(() => parseConfig(generated, 'graft.yaml')).not.toThrow();
    const config = parseConfig(generated, 'graft.yaml');
    expect(config.errors?.default?.schema).toMatchObject({
      message: 'string',
      errors: 'unknown?',
      meta: 'unknown?',
    });
  });
});
