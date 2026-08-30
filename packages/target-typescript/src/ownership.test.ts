import { describe, expect, it } from 'vitest';
import type { IR, Method, NamedType, Resource } from '@graft/protocol';
import { computeOwnership } from './ownership.js';

const docs = {};

function objectType(id: string, fieldTypeIds: string[] = []): NamedType {
  return {
    kind: 'object',
    id,
    name: { tokens: [id.toLowerCase()] },
    docs,
    role: 'shared',
    cyclic: false,
    fields: fieldTypeIds.map((refId, index) => ({
      name: { tokens: [`f${index}`] },
      wireName: `f${index}`,
      type: { kind: 'named' as const, id: refId },
      required: false,
      serverOwned: false,
      readOnly: false,
      writeOnly: false,
      deprecated: false,
      docs,
    })),
  };
}

function method(name: string, responseTypeId: string): Method {
  return {
    name: { tokens: [name] },
    operationId: name,
    docs,
    deprecated: false,
    http: { verb: 'get', path: `/${name}`, params: [] },
    response: { kind: 'json', statusCode: 200, type: { kind: 'named', id: responseTypeId } },
  };
}

function resource(id: string, methods: Method[], subresources: Resource[] = []): Resource {
  return { id, name: { tokens: [id] }, docs, methods, subresources };
}

function ir(types: NamedType[], resources: Resource[]): IR {
  return {
    irVersion: '1.1.0',
    service: {
      name: { tokens: ['t'] },
      version: '1',
      docs,
      servers: [],
      auth: [],
      constantHeaders: {},
    },
    types,
    resources,
    errors: { byStatus: [] },
    pagination: [],
  };
}

describe('type ownership', () => {
  it('colocates a type reachable from exactly one resource', () => {
    const model = ir([objectType('Asset')], [resource('assets', [method('list', 'Asset')])]);
    const { owners, shared } = computeOwnership(model);
    expect(owners.get('Asset')).toBe('assets');
    expect(shared).toEqual([]);
  });

  it('shares a type reachable from more than one resource', () => {
    const model = ir(
      [objectType('User')],
      [resource('assets', [method('list', 'User')]), resource('comments', [method('list', 'User')])],
    );
    expect(computeOwnership(model).owners.get('User')).toBeNull();
    expect(computeOwnership(model).shared).toEqual(['User']);
  });

  it('shares a type no resource reaches', () => {
    // An error body referenced only by the error taxonomy has no owning resource; inventing one
    // would make its location arbitrary.
    const model = ir([objectType('Asset'), objectType('ErrorBody')], [
      resource('assets', [method('list', 'Asset')]),
    ]);
    expect(computeOwnership(model).owners.get('ErrorBody')).toBeNull();
  });

  it('follows transitive references', () => {
    const model = ir(
      [objectType('Asset', ['Preview']), objectType('Preview')],
      [resource('assets', [method('list', 'Asset')])],
    );
    // `Preview` is only reachable through `Asset`, so it belongs with assets too.
    expect(computeOwnership(model).owners.get('Preview')).toBe('assets');
  });

  it('treats a sub-resource as its own owner', () => {
    const model = ir(
      [objectType('Invoice')],
      [resource('orgs', [], [resource('orgs.invoices', [method('list', 'Invoice')])])],
    );
    expect(computeOwnership(model).owners.get('Invoice')).toBe('orgs.invoices');
  });

  it('terminates on a reference cycle', () => {
    const model = ir(
      [objectType('Category', ['Category'])],
      [resource('categories', [method('list', 'Category')])],
    );
    expect(computeOwnership(model).owners.get('Category')).toBe('categories');
  });

  it('preserves IR order within each bucket, so emission is stable', () => {
    const model = ir(
      [objectType('A'), objectType('B'), objectType('C')],
      [resource('r', [method('a', 'A'), method('b', 'B'), method('c', 'C')])],
    );
    expect(computeOwnership(model).byResource.get('r')).toEqual(['A', 'B', 'C']);
  });
});
