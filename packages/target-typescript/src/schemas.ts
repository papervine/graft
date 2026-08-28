/**
 * Emitting runtime validation descriptors.
 *
 * The generated SDK ships a table of compact descriptors; the hand-written runtime walks it
 * (SPEC.md §3.4.1.1). This module turns IR types into those descriptors.
 *
 * Two properties matter and neither is obvious:
 *
 * **Only reachable types are emitted.** A descriptor is useful only for a type that appears in a
 * *response*, and a spec's type graph is much larger than its response graph. Stripe declares 1,440
 * types; emitting all of them would put a large table in every consumer's bundle to validate shapes
 * they can never receive. Reachability is computed from response types outward.
 *
 * **Cycles terminate through the table, not through recursion.** A named type becomes a `ref` into the
 * table rather than an inlined subtree, so a self-referential schema is finite by construction rather
 * than by a depth cap.
 */

import type { IR, NamedType, TypeRef } from '@besdk/protocol';

/** Mirror of the runtime's `Schema`, kept structural so this module needs no runtime import. */
export type SchemaDescriptor =
  | { k: 'str' }
  | { k: 'date' }
  | { k: 'num' }
  | { k: 'int' }
  | { k: 'bool' }
  | { k: 'any' }
  | { k: 'arr'; i: SchemaDescriptor }
  | { k: 'obj'; f: Array<[string, SchemaDescriptor] | [string, SchemaDescriptor, 1]>; a?: SchemaDescriptor }
  | { k: 'map'; v: SchemaDescriptor }
  | { k: 'null'; i: SchemaDescriptor }
  | { k: 'or'; o: SchemaDescriptor[] }
  | { k: 'ref'; n: string };

export interface SchemaPlan {
  /** Descriptor per emitted type name, in stable order. */
  readonly table: ReadonlyMap<string, SchemaDescriptor>;
  /** Descriptor for each operation's response, keyed by `resourceId#methodName`. */
  readonly responses: ReadonlyMap<string, SchemaDescriptor>;
  /**
   * Build a descriptor for an arbitrary reference, adding anything it names to the table.
   *
   * Exposed because a paginated method needs a descriptor for its *item* type, which is not any
   * operation's response — the envelope is.
   */
  readonly describe: (ref: TypeRef) => SchemaDescriptor;
}

/**
 * Build the descriptor table and the per-operation response descriptors.
 *
 * `declaredName` maps an IR type id to the name the target chose, so the table keys match the emitted
 * type names — which is what makes a validation error legible next to the type a reader sees.
 */
export function planSchemas(ir: IR, declaredName: (typeId: string) => string): SchemaPlan {
  const byId = new Map(ir.types.map((type) => [type.id, type]));
  const table = new Map<string, SchemaDescriptor>();
  const responses = new Map<string, SchemaDescriptor>();

  /** Named types already emitted or in progress, so a cycle does not recurse forever. */
  const started = new Set<string>();

  const describe = (ref: TypeRef | undefined): SchemaDescriptor => {
    if (ref === undefined) return { k: 'any' };
    switch (ref.kind) {
      case 'primitive':
        switch (ref.type) {
          case 'string':
            // Only `date-time`. A `date` stays a string, because JavaScript has no date-only type and
            // a `Date` for a calendar date shifts by a timezone (SPEC.md §3.4.1.2).
            return ref.format === 'date-time' ? { k: 'date' } : { k: 'str' };
          case 'integer':
            return { k: 'int' };
          case 'number':
            return { k: 'num' };
          case 'boolean':
            return { k: 'bool' };
          default:
            return { k: 'any' };
        }
      case 'array':
        return { k: 'arr', i: describe(ref.items) };
      case 'map':
        return { k: 'map', v: describe(ref.values) };
      case 'nullable':
        return { k: 'null', i: describe(ref.inner) };
      case 'named': {
        const name = declaredName(ref.id);
        ensure(ref.id, name);
        return { k: 'ref', n: name };
      }
      case 'union': {
        // A scalar-coercion union exists only because the server is loose about encoding
        // (`oneOf: [string, integer]`). Validating it as a union is correct and cheap.
        const branches = ref.variants.map(describe);
        return { k: 'or', o: branches };
      }
      case 'binary':
        // Binary responses never reach the JSON validator; a `binary` inside a JSON body is a
        // base64 string.
        return { k: 'str' };
      case 'literal':
        // A literal is validated as its base type, for the same reason an enum is: a server widening
        // it must not become a decode failure.
        return typeof ref.value === 'string'
          ? { k: 'str' }
          : typeof ref.value === 'number'
            ? { k: 'num' }
            : { k: 'bool' };
      case 'null':
        return { k: 'any' };
      case 'unknown':
        return { k: 'any' };
      default:
        return { k: 'any' };
    }
  };

  /** Add a named type to the table, if it is not already there or being built. */
  const ensure = (typeId: string, name: string): void => {
    if (started.has(typeId)) return;
    started.add(typeId);
    const type = byId.get(typeId);
    if (type === undefined) {
      table.set(name, { k: 'any' });
      return;
    }
    // Reserved before recursing, so a self-reference finds the key present and emits a `ref`.
    table.set(name, { k: 'any' });
    table.set(name, describeNamed(type, describe));
  };

  for (const resource of flatten(ir)) {
    for (const method of resource.methods) {
      if (method.response.kind !== 'json') continue;
      const key = `${resource.id}#${method.name.tokens.join('.')}`;
      responses.set(key, describe(method.response.type));
    }
  }

  return { table, responses, describe };
}

function describeNamed(
  type: NamedType,
  describe: (ref: TypeRef | undefined) => SchemaDescriptor,
): SchemaDescriptor {
  switch (type.kind) {
    case 'enum':
      // Base type only, never membership. Servers add enum values without warning, and the open-enum
      // rule (SPEC.md §3.3.1) exists precisely so that does not break a client — checking membership
      // here would reintroduce the failure that rule prevents.
      return typeof type.members[0]?.wireValue === 'number' ? { k: 'num' } : { k: 'str' };
    case 'alias':
      return describe(type.target);
    case 'object': {
      const fields = type.fields.map((field) =>
        field.required
          ? ([field.wireName, describe(field.type), 1] as [string, SchemaDescriptor, 1])
          : ([field.wireName, describe(field.type)] as [string, SchemaDescriptor]),
      );
      const descriptor: SchemaDescriptor = { k: 'obj', f: fields };
      if (type.additional !== undefined) {
        return { ...descriptor, a: describe(type.additional) } as SchemaDescriptor;
      }
      return descriptor;
    }
    default:
      return { k: 'any' };
  }
}

function flatten(ir: IR): Array<{ id: string; methods: IR['resources'][number]['methods'] }> {
  const out: Array<{ id: string; methods: IR['resources'][number]['methods'] }> = [];
  const walk = (resources: IR['resources']): void => {
    for (const resource of resources) {
      out.push({ id: resource.id, methods: resource.methods });
      walk(resource.subresources);
    }
  };
  walk(ir.resources);
  return out;
}

/**
 * Render a descriptor as a TypeScript expression.
 *
 * Hand-rendered rather than `JSON.stringify`, for one reason that earns it: quoted keys. A descriptor
 * table for Stripe is tens of thousands of entries, and `{"k":"str"}` versus `{ k: 'str' }` is a
 * meaningful difference in a file a consumer ships. Prettier reformats it afterwards either way.
 */
export function renderDescriptor(descriptor: SchemaDescriptor): string {
  switch (descriptor.k) {
    case 'str':
    case 'date':
    case 'num':
    case 'int':
    case 'bool':
    case 'any':
      return `{ k: '${descriptor.k}' }`;
    case 'ref':
      return `{ k: 'ref', n: ${JSON.stringify(descriptor.n)} }`;
    case 'arr':
      return `{ k: 'arr', i: ${renderDescriptor(descriptor.i)} }`;
    case 'map':
      return `{ k: 'map', v: ${renderDescriptor(descriptor.v)} }`;
    case 'null':
      return `{ k: 'null', i: ${renderDescriptor(descriptor.i)} }`;
    case 'or':
      return `{ k: 'or', o: [${descriptor.o.map(renderDescriptor).join(', ')}] }`;
    case 'obj': {
      const fields = descriptor.f
        .map(([name, schema, required]) =>
          required === 1
            ? `[${JSON.stringify(name)}, ${renderDescriptor(schema)}, 1]`
            : `[${JSON.stringify(name)}, ${renderDescriptor(schema)}]`,
        )
        .join(', ');
      const additional =
        descriptor.a === undefined ? '' : `, a: ${renderDescriptor(descriptor.a)}`;
      return `{ k: 'obj', f: [${fields}]${additional} }`;
    }
  }
}
