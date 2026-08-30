/**
 * A guard on emission staying linear in the size of the spec.
 *
 * ts-morph reparses a source file after every structural mutation, so building a file by adding a
 * declaration and then looping over `addProperty` costs O(n) parses of a file that is itself
 * growing — quadratic. That is how Stripe's SDK came to take five and a half minutes: a CPU
 * profile attributed 63% of 308 seconds to the scanner and the JSDoc parser, and a further 18% to
 * the garbage collector feeding them. Passing each file's complete structure to `createSourceFile`
 * parses once, and the same run finished in 2.3 seconds.
 *
 * A wall-clock assertion is a blunt instrument, and it is used deliberately. The alternative — a
 * unit test asserting "the emitter calls `addProperty` zero times" — pins the current shape of the
 * code rather than the property anyone cares about, and would pass while a different quadratic
 * mutation crept in somewhere else.
 *
 * The size and the budget were chosen together, by benchmarking both usage patterns at this exact
 * scale rather than by picking a round number: 20 resources of 30 types of 30 documented fields
 * takes 0.4s built from structures and 56s built by mutation. A guard test has to be checked for
 * teeth — the first version of this file used a third of the scale and a 30-second budget, where
 * the quadratic pattern takes 14s and would have passed. At the scale below the budget leaves
 * roughly twenty times headroom for a cold, slow CI runner while a return to per-property mutation
 * overruns it by a factor of four.
 */

import { describe, expect, it } from 'vitest';
import { brandPayload } from '@graft/protocol';
import type { Field, IR, Method, NamedType, Resource } from '@graft/protocol';
import { TypeScriptEmitter } from './emit.js';

const docs = {};

/** Wide types with prose on every field: the shape that made JSDoc parsing dominate the profile. */
function wideType(index: number, fieldCount: number): NamedType {
  const fields: Field[] = Array.from({ length: fieldCount }, (_, f) => ({
    name: { tokens: ['field', String(f)] },
    wireName: `field_${f}`,
    type: { kind: 'primitive' as const, name: 'string' as const },
    required: f % 3 === 0,
    serverOwned: false,
    readOnly: false,
    writeOnly: false,
    deprecated: false,
    docs: { description: `Field ${f} of model ${index}. ${'Prose that has to be scanned. '.repeat(4)}` },
  }));
  return {
    kind: 'object',
    id: `Model${index}`,
    name: { tokens: ['model', String(index)] },
    docs: { description: `Model ${index}.` },
    role: 'shared',
    cyclic: false,
    fields,
  };
}

function method(name: string, typeId: string): Method {
  return {
    name: { tokens: [name] },
    operationId: `${name}_${typeId}`,
    docs: { description: `Does ${name}. ${'More prose to scan. '.repeat(6)}` },
    deprecated: false,
    http: { verb: 'get', path: `/${typeId.toLowerCase()}/${name}`, params: [] },
    response: { kind: 'json', statusCode: 200, type: { kind: 'named', id: typeId } },
  };
}

/** Sized so a quadratic emitter cannot finish inside the budget; see the note on the budget. */
function largeIR(resourceCount: number, typesPerResource: number, fieldCount: number): IR {
  const types: NamedType[] = [];
  const resources: Resource[] = [];
  let next = 0;
  for (let r = 0; r < resourceCount; r++) {
    const methods: Method[] = [];
    for (let t = 0; t < typesPerResource; t++) {
      const type = wideType(next, fieldCount);
      types.push(type);
      methods.push(method(`get${next}`, type.id));
      next += 1;
    }
    resources.push({
      id: `resource${r}`,
      name: { tokens: ['resource', String(r)] },
      docs,
      methods,
      subresources: [],
    });
  }
  return {
    irVersion: '1.2.0',
    service: {
      name: { tokens: ['perf'] },
      version: '1',
      docs,
      servers: [{ url: 'https://api.example.com', default: true, docs, variables: [] }],
      auth: [{ kind: 'bearer', docs }],
      constantHeaders: {},
    },
    types,
    resources,
    errors: { byStatus: [] },
    pagination: [],
  };
}

describe('emission cost', () => {
  it('stays linear enough to emit a Stripe-sized surface in seconds', () => {
    const ir = largeIR(20, 30, 30);
    expect(ir.types).toHaveLength(600);

    const started = performance.now();
    const files = new TypeScriptEmitter(ir, { runtimeFiles: new Map(), brand: brandPayload() }).emit();
    const elapsed = performance.now() - started;

    // Sanity: the budget means nothing if emission silently produced an empty surface.
    expect(files.length).toBeGreaterThan(20);
    const source = files.filter((f) => f.path.endsWith('.ts'));
    expect(source.reduce((total, f) => total + f.contents.length, 0)).toBeGreaterThan(1_000_000);

    expect(elapsed).toBeLessThan(15_000);
  });
});
