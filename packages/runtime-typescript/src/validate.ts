/**
 * Runtime response validation.
 *
 * A generated type is a *claim* about what the server sends. Without checking it, the claim is
 * unverified — `widget.name.trim()` on a response missing `name` fails inside the caller's code with
 * `Cannot read properties of undefined`, and nothing points at the API that broke its contract.
 *
 * The generated SDK emits a compact descriptor table; this file is the one reviewed walker over it.
 * That split is deliberate (SPEC.md §3.4.1.1): a validator library would be a runtime dependency in a
 * package whose selling point is having none, and generated validator *code* would scale output size
 * with the type count — Stripe has 1,440 types.
 *
 * What is checked: required fields, declared types, and nullability. What is deliberately not:
 * unknown fields (a server adding one must never break a client) and enum membership (a server adding
 * a value must not become a decode failure — that is the whole reason open enums exist).
 */

import { SDKError } from './errors.js';

/**
 * A schema descriptor.
 *
 * Single-character keys because this table is emitted once per type and some specs have thousands.
 * The readability that matters is this file's, and this file is hand-written.
 */
export type Schema =
  /** string */
  | { readonly k: 'str' }
  /**
   * An RFC 3339 timestamp, revived as a `Date`.
   *
   * Only `date-time`. A `format: date` stays `str`, because JavaScript has no date-only type and
   * `new Date('2026-08-06')` is midnight *UTC* — so a caller in UTC-5 reading `.getDate()` gets the
   * day before. Handing someone a `Date` for a calendar date is how they walk into that
   * (SPEC.md §3.4.1.2).
   */
  | { readonly k: 'date' }
  /** number */
  | { readonly k: 'num' }
  /** integer — a number with no fractional part */
  | { readonly k: 'int' }
  /** boolean */
  | { readonly k: 'bool' }
  /** anything, including absent. `schema: {}` in the spec, or a union we chose not to narrow. */
  | { readonly k: 'any' }
  /** array */
  | { readonly k: 'arr'; readonly i: Schema }
  /** object with declared fields; extra keys are always allowed */
  | {
      readonly k: 'obj';
      readonly f: readonly (readonly [name: string, schema: Schema, required?: 1])[];
      /** Value schema for additional properties, when the spec declared one. */
      readonly a?: Schema;
    }
  /** map with homogeneous values */
  | { readonly k: 'map'; readonly v: Schema }
  /** the value may be null */
  | { readonly k: 'null'; readonly i: Schema }
  /** one of several shapes; passes if any branch passes */
  | { readonly k: 'or'; readonly o: readonly Schema[] }
  /** reference into the descriptor table, which is how recursive types terminate */
  | { readonly k: 'ref'; readonly n: string };

/** The emitted descriptor table: type name to schema. */
export type SchemaTable = Readonly<Record<string, Schema>>;

/** How strictly to enforce the contract. */
export type ValidationMode = 'strict' | 'warn' | 'off';

/** One contract violation. */
export interface ValidationProblem {
  /** JSON path from the response root, e.g. `data[0].email`. */
  readonly path: string;
  readonly message: string;
}

/**
 * Thrown when a response does not match the shape the spec promised.
 *
 * Deliberately **not** an `APIError`: the request succeeded and the *contract* was violated. That is a
 * different problem for the caller — and usually a different problem for the API owner — so it must
 * not be swallowed by a `catch` that meant "handle a 4xx".
 */
export class ResponseValidationError extends SDKError {
  readonly problems: readonly ValidationProblem[];
  /** The decoded body, so a caller who wants to proceed anyway still has it. */
  readonly body: unknown;

  constructor(operation: string, problems: readonly ValidationProblem[], body: unknown) {
    super(ResponseValidationError.describe(operation, problems));
    this.name = 'ResponseValidationError';
    this.problems = problems;
    this.body = body;
  }

  private static describe(operation: string, problems: readonly ValidationProblem[]): string {
    // The first few, not all of them: a response with a hundred violations is one broken contract,
    // and a hundred-line message buries the useful part.
    const shown = problems.slice(0, 3).map((p) => `${p.path || 'response'} ${p.message}`);
    const rest = problems.length - shown.length;
    const tail = rest > 0 ? `, and ${rest} more` : '';
    return `${operation}: the response did not match the API's declared shape — ${shown.join('; ')}${tail}`;
  }
}

const MAX_PROBLEMS = 50;

/**
 * Check a decoded body against a schema.
 *
 * Returns the problems found; an empty array means it conformed. Collecting rather than throwing lets
 * `warn` mode report without failing, and lets the error carry every violation at once.
 *
 * Stops at {@link MAX_PROBLEMS}. A response that violates its contract fifty times over is one broken
 * contract, and walking a large malformed payload to completion costs more than the information is
 * worth.
 */
export function validate(value: unknown, schema: Schema, table: SchemaTable): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  walk(value, schema, table, '', problems, 0);
  return problems;
}

/** Guard against a descriptor table with a reference cycle that does not consume input. */
const MAX_DEPTH = 64;

function walk(
  value: unknown,
  schema: Schema,
  table: SchemaTable,
  path: string,
  problems: ValidationProblem[],
  depth: number,
): void {
  if (problems.length >= MAX_PROBLEMS || depth > MAX_DEPTH) return;

  switch (schema.k) {
    case 'any':
      return;

    case 'ref': {
      const target = table[schema.n];
      if (target === undefined) {
        // A dangling reference is a generator bug, not a server one. Reported as such rather than
        // failing the response, because punishing the user for our mistake is the wrong trade.
        problems.push({ path, message: `references unknown schema \`${schema.n}\`` });
        return;
      }
      walk(value, target, table, path, problems, depth + 1);
      return;
    }

    case 'null':
      if (value === null) return;
      walk(value, schema.i, table, path, problems, depth + 1);
      return;

    case 'str':
      if (typeof value !== 'string') problems.push(mismatch(path, 'a string', value));
      return;

    case 'date':
      // Validated as a string *and* as parseable. A field the spec declared a timestamp but which
      // holds `"soon"` is a contract violation, and reporting it here is more useful than handing the
      // caller an `Invalid Date` to discover later.
      if (typeof value !== 'string') {
        problems.push(mismatch(path, 'a timestamp string', value));
      } else if (Number.isNaN(Date.parse(value))) {
        problems.push({ path, message: 'should be an RFC 3339 timestamp but could not be parsed' });
      }
      return;

    case 'num':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(mismatch(path, 'a number', value));
      }
      return;

    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        problems.push(mismatch(path, 'an integer', value));
      }
      return;

    case 'bool':
      if (typeof value !== 'boolean') problems.push(mismatch(path, 'a boolean', value));
      return;

    case 'arr': {
      if (!Array.isArray(value)) {
        problems.push(mismatch(path, 'an array', value));
        return;
      }
      for (let index = 0; index < value.length; index++) {
        walk(value[index], schema.i, table, `${path}[${index}]`, problems, depth + 1);
        if (problems.length >= MAX_PROBLEMS) return;
      }
      return;
    }

    case 'map': {
      if (!isRecord(value)) {
        problems.push(mismatch(path, 'an object', value));
        return;
      }
      for (const [key, inner] of Object.entries(value)) {
        walk(inner, schema.v, table, join(path, key), problems, depth + 1);
        if (problems.length >= MAX_PROBLEMS) return;
      }
      return;
    }

    case 'obj': {
      if (!isRecord(value)) {
        problems.push(mismatch(path, 'an object', value));
        return;
      }
      for (const [name, fieldSchema, required] of schema.f) {
        const present = name in value;
        const inner = value[name];
        if (!present || inner === undefined) {
          if (required === 1) {
            problems.push({ path: join(path, name), message: 'is required but was absent' });
          }
          continue;
        }
        walk(inner, fieldSchema, table, join(path, name), problems, depth + 1);
        if (problems.length >= MAX_PROBLEMS) return;
      }
      // Extra keys are never a problem. A server adding a field must not break a client, and this is
      // where that promise is kept.
      if (schema.a !== undefined) {
        const declared = new Set(schema.f.map(([name]) => name));
        for (const [key, inner] of Object.entries(value)) {
          if (declared.has(key)) continue;
          walk(inner, schema.a, table, join(path, key), problems, depth + 1);
          if (problems.length >= MAX_PROBLEMS) return;
        }
      }
      return;
    }

    case 'or': {
      // A union passes if any branch does. Only the *shortest* failure is reported when none do:
      // listing every branch's complaints for a three-way union is noise, and the branch that got
      // furthest is almost always the one the server meant.
      let best: ValidationProblem[] | undefined;
      for (const branch of schema.o) {
        const branchProblems: ValidationProblem[] = [];
        walk(value, branch, table, path, branchProblems, depth + 1);
        if (branchProblems.length === 0) return;
        if (best === undefined || branchProblems.length < best.length) best = branchProblems;
      }
      problems.push(...(best ?? [{ path, message: 'matched no variant of the union' }]));
      return;
    }
  }
}

function mismatch(path: string, expected: string, actual: unknown): ValidationProblem {
  return { path, message: `should be ${expected} but was ${describe(actual)}` };
}

/** A short, safe description of a value. Never interpolates the value itself — it may be a secret. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'undefined':
      return 'absent';
    case 'string':
      return 'a string';
    case 'number':
      return Number.isInteger(value) ? 'an integer' : 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'an object';
    default:
      return typeof value;
  }
}

function join(path: string, key: string): string {
  // A key needing quoting is rare but real; bracket form keeps the path copy-pasteable as JS.
  const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
  if (path === '') return safe ? key : `[${JSON.stringify(key)}]`;
  return safe ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a descriptor tree contains anything worth coercing.
 *
 * Computed once per schema so the common case — a spec with no timestamps — pays nothing. Memoised on
 * the table, because the answer cannot change for a given descriptor.
 */
const coercionNeeded = new WeakMap<object, boolean>();

function needsCoercion(schema: Schema, table: SchemaTable, seen = new Set<string>()): boolean {
  switch (schema.k) {
    case 'date':
      return true;
    case 'arr':
    case 'null':
      return needsCoercion(schema.i, table, seen);
    case 'map':
      return needsCoercion(schema.v, table, seen);
    case 'or':
      return schema.o.some((branch) => needsCoercion(branch, table, seen));
    case 'obj':
      return (
        schema.f.some(([, field]) => needsCoercion(field, table, seen)) ||
        (schema.a !== undefined && needsCoercion(schema.a, table, seen))
      );
    case 'ref': {
      // A recursive type must not recurse forever here either.
      if (seen.has(schema.n)) return false;
      seen.add(schema.n);
      const target = table[schema.n];
      return target === undefined ? false : needsCoercion(target, table, seen);
    }
    default:
      return false;
  }
}

/**
 * Convert wire values into their native form, following the same descriptor tree.
 *
 * Returns the input **by reference** when nothing changed, so an unchanged response is not copied. That
 * matters: this runs on every response, and copying a large payload to change nothing would be a real
 * cost for no benefit.
 */
export function coerce(value: unknown, schema: Schema, table: SchemaTable, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;

  switch (schema.k) {
    case 'date':
      if (typeof value !== 'string') return value;
      {
        const parsed = new Date(value);
        // An unparseable timestamp is left as the string it was. Validation already reported it, and
        // handing the caller an `Invalid Date` would be strictly less useful than the original text.
        return Number.isNaN(parsed.getTime()) ? value : parsed;
      }

    case 'ref': {
      const target = table[schema.n];
      return target === undefined ? value : coerce(value, target, table, depth + 1);
    }

    case 'null':
      return value === null ? value : coerce(value, schema.i, table, depth + 1);

    case 'arr': {
      if (!Array.isArray(value)) return value;
      let changed = false;
      const mapped = value.map((item) => {
        const next = coerce(item, schema.i, table, depth + 1);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? mapped : value;
    }

    case 'map': {
      if (!isRecord(value)) return value;
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        const next = coerce(inner, schema.v, table, depth + 1);
        if (next !== inner) changed = true;
        out[key] = next;
      }
      return changed ? out : value;
    }

    case 'obj': {
      if (!isRecord(value)) return value;
      let changed = false;
      const out: Record<string, unknown> = { ...value };
      for (const [name, fieldSchema] of schema.f) {
        if (!(name in value)) continue;
        const next = coerce(value[name], fieldSchema, table, depth + 1);
        if (next !== value[name]) {
          changed = true;
          out[name] = next;
        }
      }
      if (schema.a !== undefined) {
        const declared = new Set(schema.f.map(([name]) => name));
        for (const [key, inner] of Object.entries(value)) {
          if (declared.has(key)) continue;
          const next = coerce(inner, schema.a, table, depth + 1);
          if (next !== inner) {
            changed = true;
            out[key] = next;
          }
        }
      }
      return changed ? out : value;
    }

    case 'or': {
      // The first branch that changes something wins. A union of a timestamp and something else is
      // rare, and trying every branch and merging would be worse than taking the first that applies.
      for (const branch of schema.o) {
        const next = coerce(value, branch, table, depth + 1);
        if (next !== value) return next;
      }
      return value;
    }

    default:
      return value;
  }
}

/**
 * Apply a validation mode to a decoded body, returning it unchanged.
 *
 * Threaded through rather than validating inside the transport, because only the generated method
 * knows which schema a response has — and passing the schema down would put type knowledge in the
 * runtime, which is the boundary this design exists to keep.
 */
export function enforce<T>(
  value: T,
  schema: Schema | undefined,
  table: SchemaTable,
  operation: string,
  mode: ValidationMode,
): T {
  if (schema === undefined) return value;

  // Coercion runs even with validation off: the *types* promise a `Date`, and honouring that is not a
  // safety check a caller can reasonably decline. Turning validation off declines the *checking*, not
  // the shape of what comes back.
  const converted = (): T => {
    let needed = coercionNeeded.get(schema as object);
    if (needed === undefined) {
      needed = needsCoercion(schema, table);
      coercionNeeded.set(schema as object, needed);
    }
    return needed ? (coerce(value, schema, table) as T) : value;
  };

  if (mode === 'off') return converted();

  const problems = validate(value, schema, table);
  if (problems.length === 0) return converted();
  if (mode === 'warn') {
    // `console.warn` rather than a callback: a warning nobody wired up is a warning nobody sees, and
    // an SDK that silently drops diagnostics is worse than one that is briefly noisy.
    const error = new ResponseValidationError(operation, problems, value);
    console.warn(error.message);
    return converted();
  }
  throw new ResponseValidationError(operation, problems, value);
}

/**
 * Validate and coerce one item from a paginated response.
 *
 * Separate from {@link enforce} because a paginator has already unwrapped the envelope, and reporting
 * `[0].email` for something the caller received as a bare item would name a path they never saw. The
 * operation name still points at the method, which is what they can act on.
 */
export function enforceItem<T>(
  item: T,
  schema: Schema,
  table: SchemaTable,
  operation: string,
  mode: ValidationMode,
): T {
  return enforce(item, schema, table, operation, mode);
}
