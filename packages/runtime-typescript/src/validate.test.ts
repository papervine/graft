/**
 * Tests for runtime response validation.
 *
 * Each of these pins a decision from SPEC.md §3.4.1.1 — most importantly the two things that are
 * deliberately *not* checked, because getting those wrong would reintroduce the decode failures the
 * open-enum and additive-field rules exist to prevent.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ResponseValidationError,
  enforce,
  validate,
  type Schema,
  type SchemaTable,
} from './validate.js';

const table: SchemaTable = {
  Member: {
    k: 'obj',
    f: [
      ['id', { k: 'str' }, 1],
      ['email', { k: 'str' }, 1],
      ['nickname', { k: 'null', i: { k: 'str' } }],
      ['seats', { k: 'int' }],
    ],
  },
  Node: {
    k: 'obj',
    f: [
      ['name', { k: 'str' }, 1],
      ['child', { k: 'ref', n: 'Node' }],
    ],
  },
};

const member: Schema = { k: 'ref', n: 'Member' };

describe('required fields', () => {
  it('accepts a conforming object', () => {
    expect(validate({ id: 'm1', email: 'a@b.com' }, member, table)).toEqual([]);
  });

  it('reports an absent required field by path', () => {
    const problems = validate({ id: 'm1' }, member, table);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.path).toBe('email');
    expect(problems[0]!.message).toBe('is required but was absent');
  });

  it('treats an explicit undefined as absent', () => {
    // JSON cannot carry `undefined`, but a hand-built object or a lenient proxy can.
    expect(validate({ id: 'm1', email: undefined }, member, table)).toHaveLength(1);
  });

  it('does not require an optional field', () => {
    expect(validate({ id: 'm1', email: 'a@b.com' }, member, table)).toEqual([]);
  });
});

describe('type mismatches', () => {
  it('reports the wrong type without quoting the value', () => {
    // The value may be a secret — an API key echoed back, a token in an error body — so the message
    // describes its shape and never its content.
    const problems = validate({ id: 'sk_live_verysecret', email: 'a@b.com' }, member, table);
    expect(problems).toEqual([]);
    const bad = validate({ id: 12345, email: 'a@b.com' }, member, table);
    expect(bad[0]!.message).toBe('should be a string but was an integer');
    expect(JSON.stringify(bad)).not.toContain('12345');
  });

  it('distinguishes integers from numbers', () => {
    expect(validate({ id: 'm', email: 'e', seats: 3 }, member, table)).toEqual([]);
    const problems = validate({ id: 'm', email: 'e', seats: 3.5 }, member, table);
    expect(problems[0]!.message).toBe('should be an integer but was a number');
  });

  it('rejects NaN and Infinity as numbers', () => {
    // They survive a JSON round-trip through some servers as `null`, but a hand-built value can carry
    // them, and neither is a number any API meant.
    const schema: Schema = { k: 'num' };
    expect(validate(Number.NaN, schema, {})).toHaveLength(1);
    expect(validate(Number.POSITIVE_INFINITY, schema, {})).toHaveLength(1);
  });

  it('reports null for a non-nullable field', () => {
    const problems = validate({ id: null, email: 'a@b.com' }, member, table);
    expect(problems[0]!.message).toBe('should be a string but was null');
  });

  it('accepts null for a nullable field', () => {
    expect(validate({ id: 'm', email: 'e', nickname: null }, member, table)).toEqual([]);
  });
});

describe('what is deliberately not checked', () => {
  it('ignores unknown fields', () => {
    // A server adding a field must never break a client. This is where that promise is kept.
    const problems = validate(
      { id: 'm1', email: 'a@b.com', added_next_quarter: { nested: true } },
      member,
      table,
    );
    expect(problems).toEqual([]);
  });

  it('validates an enum as its base type, never against its members', () => {
    // The open-enum rule exists because servers add values without warning. Checking membership would
    // reintroduce exactly the decode failure that rule prevents.
    const role: Schema = { k: 'str' };
    expect(validate('a_role_added_next_quarter', role, {})).toEqual([]);
  });
});

describe('containers', () => {
  it('reports the index of a bad array element', () => {
    const schema: Schema = { k: 'arr', i: member };
    const problems = validate([{ id: 'a', email: 'e' }, { id: 'b' }], schema, table);
    expect(problems[0]!.path).toBe('[1].email');
  });

  it('walks map values', () => {
    const schema: Schema = { k: 'map', v: { k: 'int' } };
    const problems = validate({ a: 1, b: 'two' }, schema, table);
    expect(problems[0]!.path).toBe('b');
  });

  it('brackets a key that is not a bare identifier', () => {
    const schema: Schema = { k: 'map', v: { k: 'int' } };
    const problems = validate({ 'weird-key': 'x' }, schema, table);
    // Copy-pasteable as JavaScript, which is what a path is for.
    expect(problems[0]!.path).toBe('["weird-key"]');
  });

  it('terminates on a recursive schema', () => {
    const deep = { name: 'a', child: { name: 'b', child: { name: 'c' } } };
    expect(validate(deep, { k: 'ref', n: 'Node' }, table)).toEqual([]);
  });

  it('validates additional properties when the spec declared their type', () => {
    const schema: Schema = {
      k: 'obj',
      f: [['known', { k: 'str' }, 1]],
      a: { k: 'int' },
    };
    expect(validate({ known: 'x', extra: 1 }, schema, {})).toEqual([]);
    expect(validate({ known: 'x', extra: 'no' }, schema, {})).toHaveLength(1);
  });
});

describe('unions', () => {
  const either: Schema = {
    k: 'or',
    o: [
      { k: 'obj', f: [['kind', { k: 'str' }, 1], ['a', { k: 'int' }, 1]] },
      { k: 'obj', f: [['kind', { k: 'str' }, 1], ['b', { k: 'str' }, 1]] },
    ],
  };

  it('passes when any branch passes', () => {
    expect(validate({ kind: 'x', a: 1 }, either, {})).toEqual([]);
    expect(validate({ kind: 'x', b: 'y' }, either, {})).toEqual([]);
  });

  it('reports only the closest branch when none pass', () => {
    // Listing every branch's complaints for a three-way union is noise; the branch that got furthest
    // is almost always the one the server meant.
    const problems = validate({ kind: 'x' }, either, {});
    expect(problems).toHaveLength(1);
  });
});

describe('robustness', () => {
  it('caps the number of problems reported', () => {
    const schema: Schema = { k: 'arr', i: { k: 'str' } };
    const problems = validate(Array.from({ length: 500 }, () => 1), schema, {});
    // One broken contract, not five hundred.
    expect(problems.length).toBeLessThanOrEqual(50);
  });

  it('reports a dangling reference as a generator bug, not a server one', () => {
    const problems = validate({}, { k: 'ref', n: 'Missing' }, {});
    expect(problems[0]!.message).toContain('unknown schema');
  });

  it('passes anything for an unknown schema', () => {
    expect(validate({ whatever: [1, 'two', null] }, { k: 'any' }, {})).toEqual([]);
  });
});

describe('enforce', () => {
  it('throws in strict mode, naming the operation', () => {
    expect(() => enforce({ id: 'm' }, member, table, 'orgs.listMembers', 'strict')).toThrowError(
      /orgs\.listMembers/,
    );
    try {
      enforce({ id: 'm' }, member, table, 'orgs.listMembers', 'strict');
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseValidationError);
      const validation = error as ResponseValidationError;
      expect(validation.problems[0]!.path).toBe('email');
      // The body is attached so a caller who wants to proceed anyway still has it.
      expect(validation.body).toEqual({ id: 'm' });
    }
  });

  it('warns and returns the value in warn mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const value = enforce({ id: 'm' }, member, table, 'orgs.listMembers', 'warn');
    expect(value).toEqual({ id: 'm' });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('skips entirely in off mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(enforce({ id: 'm' }, member, table, 'op', 'off')).toEqual({ id: 'm' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is not an APIError, so a 4xx handler does not swallow it', () => {
    // The request succeeded and the contract was violated. Different problem, different type.
    try {
      enforce({ id: 'm' }, member, table, 'op', 'strict');
    } catch (error) {
      expect((error as Error).name).toBe('ResponseValidationError');
      expect(Object.hasOwn(error as object, 'status')).toBe(false);
    }
  });
});

describe('date coercion', () => {
  const table: SchemaTable = {
    Event: {
      k: 'obj',
      f: [
        ['at', { k: 'date' }, 1],
        ['ended_at', { k: 'null', i: { k: 'date' } }],
        ['label', { k: 'str' }, 1],
      ],
    },
  };
  const event: Schema = { k: 'ref', n: 'Event' };

  it('revives an RFC 3339 timestamp as a Date', () => {
    const result = enforce(
      { at: '2026-08-06T12:34:56Z', label: 'x' },
      event,
      table,
      'op',
      'strict',
    ) as { at: Date; label: string };
    expect(result.at).toBeInstanceOf(Date);
    expect(result.at.toISOString()).toBe('2026-08-06T12:34:56.000Z');
    // A field the spec did not declare as a timestamp is untouched.
    expect(result.label).toBe('x');
  });

  it('leaves null alone for a nullable timestamp', () => {
    const result = enforce(
      { at: '2026-08-06T00:00:00Z', ended_at: null, label: 'x' },
      event,
      table,
      'op',
      'strict',
    ) as { ended_at: null };
    expect(result.ended_at).toBeNull();
  });

  it('reports an unparseable timestamp and keeps the original string', () => {
    // Handing the caller an `Invalid Date` would be strictly less useful than the text the server sent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = enforce({ at: 'soon', label: 'x' }, event, table, 'op', 'warn') as { at: unknown };
    expect(warn).toHaveBeenCalledOnce();
    expect(result.at).toBe('soon');
    warn.mockRestore();
  });

  it('coerces even when validation is off', () => {
    // The *types* promise a Date. Turning validation off declines the checking, not the shape.
    const result = enforce({ at: '2026-08-06T12:00:00Z', label: 'x' }, event, table, 'op', 'off') as {
      at: Date;
    };
    expect(result.at).toBeInstanceOf(Date);
  });

  it('returns the input by reference when nothing needed coercing', () => {
    // The walk runs on every response; copying a large payload to change nothing would be a real cost.
    const dateless: SchemaTable = { T: { k: 'obj', f: [['a', { k: 'str' }, 1]] } };
    const input = { a: 'x' };
    expect(enforce(input, { k: 'ref', n: 'T' }, dateless, 'op', 'strict')).toBe(input);
  });

  it('coerces inside arrays and maps', () => {
    const nested: SchemaTable = {};
    const arraySchema: Schema = { k: 'arr', i: { k: 'date' } };
    const dates = enforce(['2026-01-01T00:00:00Z'], arraySchema, nested, 'op', 'strict') as Date[];
    expect(dates[0]).toBeInstanceOf(Date);

    const mapSchema: Schema = { k: 'map', v: { k: 'date' } };
    const mapped = enforce({ k: '2026-01-01T00:00:00Z' }, mapSchema, nested, 'op', 'strict') as Record<
      string,
      Date
    >;
    expect(mapped.k).toBeInstanceOf(Date);
  });

  it('terminates on a recursive schema containing a date', () => {
    const recursive: SchemaTable = {
      Node: {
        k: 'obj',
        f: [
          ['at', { k: 'date' }, 1],
          ['child', { k: 'ref', n: 'Node' }],
        ],
      },
    };
    const value = { at: '2026-01-01T00:00:00Z', child: { at: '2026-01-02T00:00:00Z' } };
    const result = enforce(value, { k: 'ref', n: 'Node' }, recursive, 'op', 'strict') as {
      at: Date;
      child: { at: Date };
    };
    expect(result.at).toBeInstanceOf(Date);
    expect(result.child.at).toBeInstanceOf(Date);
  });
});
