/**
 * IR type references → TypeScript type expressions.
 *
 * This is where "idiomatic" is decided for the type layer, and most of the decisions are about
 * refusing to widen. `unknown` instead of `any`; `Record<string, T>` instead of a union with an
 * array; `T | null` distinct from an optional property.
 */

import type { IR, NamedType, TypeRef } from '@graft/protocol';
import { pascal } from './naming.js';

/**
 * Names the vendored runtime exports into every resource module.
 *
 * A generated type taking one of these shadows the import and fails to compile — Stripe has a
 * schema that names itself `RequestOptions`. Reserved here rather than in the core because *which*
 * names are taken is a property of this target's runtime, not of the IR.
 */
/**
 * TypeScript utility and lib types the emitter itself writes into type expressions.
 *
 * Shadowing one of these is fatal, not cosmetic: GitHub declares a schema named `Record`, and every
 * emitted `Record<string, T>` then failed with "Type 'Record' is not generic". Unlike a global such
 * as `Event` — which a spec may legitimately name and which only shadows — these break compilation,
 * so a spec-declared name is renamed here even though the core generally keeps what the author wrote.
 */
const TS_UTILITY_TYPES = new Set([
  'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract',
  'NonNullable', 'Parameters', 'ReturnType', 'Awaited', 'InstanceType', 'ThisType',
  'Array', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Iterable', 'AsyncIterable',
  'AsyncGenerator', 'Generator', 'Blob', 'Response', 'Headers', 'FormData', 'Error',
]);

const RUNTIME_EXPORTS = new Set([
  'ResponseValidationError',
  'OAuth2Error',
  'TokenSource',
  'OAuth2Config',
  'ValidationMode',
  'ValidationProblem',
  'Schema',
  'SchemaTable',
  'BaseClient',
  'RequestOptions',
  'ClientOptions',
  'Paginator',
  'Page',
  'pageParams',
  'compact',
  'streamSSE',
  'streamJSONLines',
  'APIError',
  'SDKError',
  'Auth',
  'QueryValue',
  'RawResponse',
  'InternalRequest',
  'ResponseType',
  'BodyKind',
]);

export class TypeMapper {
  /** Type id → the TypeScript name it is emitted under. */
  private readonly names = new Map<string, string>();

  constructor(ir: IR) {
    // Seeded so a generated type can never claim a name the runtime or the language occupies.
    const used = new Set<string>([...RUNTIME_EXPORTS, ...TS_UTILITY_TYPES]);
    for (const type of ir.types) {
      let name = pascal(type.name);
      if (name === '' || /^\d/.test(name)) name = `Type${name}`;
      // Two IR types can tokenize to the same TS name; disambiguate deterministically so
      // snapshots stay stable. `Model` is tried before a digit, because `RecordModel` reads as a
      // deliberate name where `Record2` reads as a generator giving up.
      let candidate = name;
      if (used.has(candidate)) candidate = `${name}Model`;
      let suffix = 2;
      while (used.has(candidate)) candidate = `${name}${suffix++}`;
      used.add(candidate);
      this.names.set(type.id, candidate);
    }
  }

  nameOf(id: string): string {
    return this.names.get(id) ?? 'unknown';
  }

  /** Reverse lookup, for resolving which module declares an emitted name. */
  idForName(name: string): string | undefined {
    this.reverse ??= new Map([...this.names].map(([id, declared]) => [declared, id]));
    return this.reverse.get(name);
  }
  private reverse: Map<string, string> | undefined;

  declaredName(type: NamedType): string {
    return this.nameOf(type.id);
  }

  /** Render a type reference as a TypeScript type expression. */
  render(ref: TypeRef): string {
    switch (ref.kind) {
      case 'primitive':
        return this.renderPrimitive(ref);
      // `unknown`, never `any`: callers must narrow before use.
      case 'unknown':
        return 'unknown';
      case 'null':
        return 'null';
      case 'literal':
        return typeof ref.value === 'string' ? JSON.stringify(ref.value) : String(ref.value);
      case 'array': {
        const inner = this.render(ref.items);
        // `Array<T>` only when `T[]` would be ambiguous or unreadable.
        return needsArrayGeneric(inner) ? `Array<${inner}>` : `${inner}[]`;
      }
      case 'map':
        return `Record<string, ${this.render(ref.values)}>`;
      case 'named':
        return this.nameOf(ref.id);
      case 'nullable':
        return `${this.render(ref.inner)} | null`;
      case 'binary':
        return 'Blob';
      case 'union': {
        const variants = ref.variants.map((v) => this.render(v));
        return [...new Set(variants)].join(' | ');
      }
    }
  }

  private renderPrimitive(ref: Extract<TypeRef, { kind: 'primitive' }>): string {
    if (ref.type === 'boolean') return 'boolean';
    if (ref.type === 'string') {
      // A `date-time` is revived as a `Date` by the runtime's coercion pass, so the type is honest.
      //
      // This used to return `string` with the note "claiming `Date` would be a lie unless the runtime
      // revived it" — which was correct then. Response validation (§3.4.1.1) added a walk over every
      // response, so reviving now costs one branch in a pass that already happens, and the premise the
      // old decision rested on is gone.
      //
      // `format: date` deliberately stays a string: JavaScript has no date-only type, and
      // `new Date('2026-08-06')` is midnight UTC — so a caller in UTC-5 reading `.getDate()` gets the
      // day before. See SPEC.md §3.4.1.2.
      return ref.format === 'date-time' ? 'Date' : 'string';
    }
    // int64 exceeds Number.MAX_SAFE_INTEGER; widening to `number` would silently lose precision.
    if (ref.format === 'int64') return 'number';
    return 'number';
  }
}

function needsArrayGeneric(inner: string): boolean {
  return inner.includes('|') || inner.includes('=>') || inner.endsWith('null');
}
