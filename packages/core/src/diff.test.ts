import { describe, expect, it } from 'vitest';
import type { Field, IR, Method, NamedType, Resource } from '@graft/protocol';
import { diffIR, impliedBump } from './diff.js';

const docs = {};

function field(wireName: string, required: boolean, typeId = 'string'): Field {
  return {
    name: { tokens: [wireName] },
    wireName,
    type: typeId === 'string' ? { kind: 'primitive', type: 'string' } : { kind: 'named', id: typeId },
    required,
    serverOwned: false,
    readOnly: false,
    writeOnly: false,
    deprecated: false,
    docs,
  };
}

function object(
  id: string,
  role: Extract<NamedType, { kind: 'object' }>['role'],
  fields: Field[],
): NamedType {
  return { kind: 'object', id, name: { tokens: [id] }, docs, role, cyclic: false, fields };
}

function method(overrides: Partial<Method> = {}): Method {
  return {
    name: { tokens: ['list'] },
    operationId: 'listThings',
    docs,
    deprecated: false,
    http: { verb: 'get', path: '/things', params: [] },
    response: { kind: 'json', statusCode: 200, type: { kind: 'named', id: 'Thing' } },
    ...overrides,
  };
}

function resource(methods: Method[], id = 'things'): Resource {
  return { id, name: { tokens: [id] }, docs, methods, subresources: [] };
}

function ir(types: NamedType[] = [], resources: Resource[] = []): IR {
  return {
    irVersion: '1.1.0',
    service: {
      name: { tokens: ['t'] },
      version: '1.0',
      docs,
      servers: [{ id: 'prod', url: 'https://api.test', default: true }],
      auth: [{ kind: 'bearer', id: 'b', docs }],
      constantHeaders: {},
    },
    types,
    resources,
    errors: { byStatus: [] },
    pagination: [],
  };
}

describe('no changes', () => {
  it('reports nothing for an identical IR', () => {
    const model = ir([object('Thing', 'shared', [field('a', true)])], [resource([method()])]);
    const result = diffIR(model, model);
    expect(result.changes).toEqual([]);
    expect(impliedBump(result)).toBe('none');
  });
});

describe('required-ness is direction-sensitive', () => {
  const withRequired = (role: Extract<NamedType, { kind: 'object' }>['role'], required: boolean) =>
    ir([object('T', role, [field('a', required)])]);

  it('read model: required → optional is breaking', () => {
    // Consumer code that assumed presence must now handle absence.
    const result = diffIR(withRequired('read', true), withRequired('read', false));
    expect(result.changes[0]).toMatchObject({ severity: 'breaking', path: 'T.a' });
    expect(result.changes[0]?.detail).toContain('handle absence');
  });

  it('read model: optional → required is additive', () => {
    const result = diffIR(withRequired('read', false), withRequired('read', true));
    expect(result.changes[0]).toMatchObject({ severity: 'additive' });
  });

  it('create model: optional → required is breaking', () => {
    // The opposite direction: callers must now supply it.
    const result = diffIR(withRequired('create', false), withRequired('create', true));
    expect(result.changes[0]).toMatchObject({ severity: 'breaking' });
    expect(result.changes[0]?.detail).toContain('must now supply');
  });

  it('create model: required → optional is additive', () => {
    const result = diffIR(withRequired('create', true), withRequired('create', false));
    expect(result.changes[0]).toMatchObject({ severity: 'additive' });
  });

  it('shared model: either direction is breaking', () => {
    // A shared model flows both ways, so one side always breaks.
    expect(diffIR(withRequired('shared', true), withRequired('shared', false)).breaking).toBe(1);
    expect(diffIR(withRequired('shared', false), withRequired('shared', true)).breaking).toBe(1);
  });
});

describe('fields', () => {
  it('removing a field is breaking', () => {
    const before = ir([object('T', 'read', [field('a', true), field('b', false)])]);
    const after = ir([object('T', 'read', [field('a', true)])]);
    expect(diffIR(before, after).changes).toMatchObject([
      { severity: 'breaking', path: 'T.b', message: 'field removed' },
    ]);
  });

  it('adding an optional field is additive', () => {
    const before = ir([object('T', 'read', [field('a', true)])]);
    const after = ir([object('T', 'read', [field('a', true), field('b', false)])]);
    expect(diffIR(before, after).changes).toMatchObject([{ severity: 'additive', path: 'T.b' }]);
  });

  it('adding a required field to a write model is breaking', () => {
    const before = ir([object('T', 'create', [field('a', true)])]);
    const after = ir([object('T', 'create', [field('a', true), field('b', true)])]);
    expect(diffIR(before, after).changes[0]).toMatchObject({ severity: 'breaking', path: 'T.b' });
  });

  it('adding a required field to a read model is only additive', () => {
    // Nothing a caller writes changes; the server just promises more.
    const before = ir([object('T', 'read', [field('a', true)])]);
    const after = ir([object('T', 'read', [field('a', true), field('b', true)])]);
    expect(diffIR(before, after).changes[0]).toMatchObject({ severity: 'additive' });
  });

  it('changing a field to an unrelated type is breaking', () => {
    const before = ir([object('T', 'read', [field('a', true, 'A')])]);
    const after = ir([object('T', 'read', [field('a', true, 'B')])]);
    expect(diffIR(before, after).changes[0]).toMatchObject({
      severity: 'breaking',
      message: 'field changed type',
    });
    // Unrecognised shifts stay breaking, which is the conservative direction.
    expect(diffIR(before, after).changes[0]!.detail).toContain('the shape changed');
  });

  describe('narrowing and widening break opposite sides', () => {
    // Type changes used to be unconditionally breaking, which ignores direction — the same mistake
    // required-ness once made. A read field narrowed from `string` to a literal breaks nothing, because
    // the literal is still assignable to the wider type.
    const stringField = (name: string): Field => ({
      name: { tokens: [name] },
      wireName: name,
      type: { kind: 'primitive', type: 'string' },
      required: true,
      serverOwned: false,
      readOnly: false,
      writeOnly: false,
      deprecated: false,
      docs: {},
    });
    const literalField = (name: string, value: string): Field => ({
      ...stringField(name),
      type: { kind: 'literal', value },
    });

    const objectWith = (role: 'read' | 'create' | 'shared', field: Field): NamedType => ({
      kind: 'object',
      id: 'T',
      name: { tokens: ['t'] },
      docs: {},
      role,
      cyclic: false,
      fields: [field],
    });

    it('narrowing a read field is additive', () => {
      const result = diffIR(
        ir([objectWith('read', stringField('type'))]),
        ir([objectWith('read', literalField('type', 'a.value'))]),
      );
      expect(result.changes[0]).toMatchObject({ severity: 'additive' });
      expect(result.changes[0]!.detail).toContain('still assignable');
    });

    it('narrowing a write field is breaking', () => {
      // A caller who passed an arbitrary string is now rejected.
      const result = diffIR(
        ir([objectWith('create', stringField('type'))]),
        ir([objectWith('create', literalField('type', 'a.value'))]),
      );
      expect(result.changes[0]).toMatchObject({ severity: 'breaking' });
      expect(result.changes[0]!.detail).toContain('now rejected');
    });

    it('widening a read field is breaking', () => {
      // Code that relied on the narrower type must now handle more.
      const result = diffIR(
        ir([objectWith('read', literalField('type', 'a.value'))]),
        ir([objectWith('read', stringField('type'))]),
      );
      expect(result.changes[0]).toMatchObject({ severity: 'breaking' });
    });

    it('widening a write field is additive', () => {
      const result = diffIR(
        ir([objectWith('create', literalField('type', 'a.value'))]),
        ir([objectWith('create', stringField('type'))]),
      );
      expect(result.changes[0]).toMatchObject({ severity: 'additive' });
    });

    it('either direction breaks a shared model', () => {
      // It flows both ways, so restricting writers and widening readers are both somebody's problem.
      const narrowed = diffIR(
        ir([objectWith('shared', stringField('type'))]),
        ir([objectWith('shared', literalField('type', 'a.value'))]),
      );
      expect(narrowed.changes[0]).toMatchObject({ severity: 'breaking' });
      expect(narrowed.changes[0]!.detail).toContain('shared model');
    });

    it('does not treat an unrelated base type as a narrowing', () => {
      // `integer` → `'a'` is not a narrowing, it is a different type.
      const before = ir([
        objectWith('read', { ...stringField('n'), type: { kind: 'primitive', type: 'integer' } }),
      ]);
      const after = ir([objectWith('read', literalField('n', 'a'))]);
      expect(diffIR(before, after).changes[0]).toMatchObject({ severity: 'breaking' });
    });
  });
});

describe('methods', () => {
  it('removing a method is breaking', () => {
    expect(diffIR(ir([], [resource([method()])]), ir([], [resource([])])).changes).toMatchObject([
      { severity: 'breaking', message: 'method removed' },
    ]);
  });

  it('detects a rename rather than a remove plus an add', () => {
    // Keyed on operationId, so the diff can say "renamed" — which is the actionable message.
    const before = ir([], [resource([method({ name: { tokens: ['list'] } })])]);
    const after = ir([], [resource([method({ name: { tokens: ['index'] } })])]);
    const result = diffIR(before, after);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ severity: 'breaking' });
    expect(result.changes[0]?.message).toContain('renamed to `index`');
  });

  it('adding a required parameter is breaking; optional is additive', () => {
    const param = (required: boolean) => ({
      name: { tokens: ['q'] },
      wireName: 'q',
      location: 'query' as const,
      type: { kind: 'primitive' as const, type: 'string' as const },
      required,
      deprecated: false,
      docs,
    });
    const before = ir([], [resource([method()])]);
    expect(
      diffIR(before, ir([], [resource([method({ http: { verb: 'get', path: '/things', params: [param(true)] } })])]))
        .breaking,
    ).toBe(1);
    expect(
      diffIR(before, ir([], [resource([method({ http: { verb: 'get', path: '/things', params: [param(false)] } })])]))
        .additive,
    ).toBe(1);
  });

  it('gaining pagination is breaking, because the return type changes', () => {
    const before = ir([], [resource([method()])]);
    const after = ir([], [resource([method({ paginationId: 'offset' })])]);
    expect(diffIR(before, after).changes[0]).toMatchObject({ severity: 'breaking' });
  });

  it('changing the return type is breaking', () => {
    const before = ir([], [resource([method()])]);
    const after = ir([], [resource([method({ response: { kind: 'empty', statusCode: 204 } })])]);
    expect(diffIR(before, after).changes[0]).toMatchObject({
      severity: 'breaking',
      message: 'return type changed',
    });
  });

  it('deprecation is a patch, not a break', () => {
    const before = ir([], [resource([method()])]);
    const after = ir([], [resource([method({ deprecated: true })])]);
    expect(diffIR(before, after).changes).toMatchObject([{ severity: 'patch' }]);
  });
});

describe('resources and service', () => {
  it('removing a resource is breaking', () => {
    expect(diffIR(ir([], [resource([method()])]), ir()).changes[0]).toMatchObject({
      severity: 'breaking',
      message: 'resource removed',
    });
  });

  it('a nested resource is tracked by its full id', () => {
    const nested: Resource = {
      id: 'orgs',
      name: { tokens: ['orgs'] },
      docs,
      methods: [],
      subresources: [resource([method()], 'orgs.things')],
    };
    const before = ir([], [nested]);
    const after = ir([], [{ ...nested, subresources: [] }]);
    expect(diffIR(before, after).changes[0]).toMatchObject({ path: 'orgs.things' });
  });

  it('removing an auth scheme is breaking', () => {
    const before = ir();
    const after: IR = { ...before, service: { ...before.service, auth: [] } };
    expect(diffIR(before, after).changes[0]).toMatchObject({
      severity: 'breaking',
      path: 'service.auth',
    });
  });

  it('changing the default server is breaking', () => {
    // Not a compile error, but every existing client silently calls a different host.
    const before = ir();
    const after: IR = {
      ...before,
      service: { ...before.service, servers: [{ id: 'prod', url: 'https://other.test', default: true }] },
    };
    expect(diffIR(before, after).changes[0]).toMatchObject({ path: 'service.baseURL' });
  });

  it('a version bump alone is a patch', () => {
    const before = ir();
    const after: IR = { ...before, service: { ...before.service, version: '1.1' } };
    expect(impliedBump(diffIR(before, after))).toBe('patch');
  });
});

describe('enums', () => {
  const withMembers = (values: string[]): IR =>
    ir([
      {
        kind: 'enum',
        id: 'E',
        name: { tokens: ['e'] },
        docs,
        open: true,
        members: values.map((v) => ({ name: { tokens: [v] }, wireValue: v, docs })),
      },
    ]);

  it('removing a value is breaking', () => {
    expect(diffIR(withMembers(['a', 'b']), withMembers(['a'])).changes[0]).toMatchObject({
      severity: 'breaking',
      path: 'E.b',
    });
  });

  it('adding a value is additive', () => {
    expect(diffIR(withMembers(['a']), withMembers(['a', 'b'])).changes[0]).toMatchObject({
      severity: 'additive',
    });
  });
});

describe('implied version bump', () => {
  it('breaking wins over additive', () => {
    const before = ir([object('T', 'read', [field('a', true)])]);
    const after = ir([object('T', 'read', [field('b', false)])]);
    const result = diffIR(before, after);
    expect(result.breaking).toBeGreaterThan(0);
    expect(result.additive).toBeGreaterThan(0);
    expect(impliedBump(result)).toBe('major');
  });

  it('additive alone implies minor', () => {
    const before = ir([object('T', 'read', [field('a', true)])]);
    const after = ir([object('T', 'read', [field('a', true), field('b', false)])]);
    expect(impliedBump(diffIR(before, after))).toBe('minor');
  });
});

describe('service rename', () => {
  it('is breaking, because the exported client class name changes', () => {
    // Missed originally: `diff --strict` passed a client rename while the repo's own conformance
    // tests stopped compiling against the regenerated SDK.
    const before = ir();
    const after: IR = {
      ...before,
      service: { ...before.service, displayName: 'Renamed' },
    };
    expect(diffIR(before, after).changes[0]).toMatchObject({
      severity: 'breaking',
      path: 'service.name',
    });
  });
});
