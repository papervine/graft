/**
 * Deciding which file each generated type lives in.
 *
 * One 2,700-line `models.ts` compiles fine — types are erased, so there is no bundle-size
 * argument either way — but it is unpleasant to navigate, and it is not how the SDKs people
 * like are laid out. The convention worth copying is *colocation*: the types a resource returns
 * live next to that resource, and only genuinely shared types get a common home.
 *
 * The rule is reachability. A type reachable from exactly one resource belongs to that resource;
 * anything reachable from several, or from none, goes to `shared.ts`. That keeps the common file
 * small without forcing an arbitrary owner on a type two resources both use.
 */

import type { IR, Method, NamedType, Resource, TypeRef } from '@besdk/protocol';

/** Where a type is emitted. `null` means the shared module. */
export type TypeOwner = string | null;

export interface Ownership {
  /** Type id → owning resource id, or `null` for the shared module. */
  readonly owners: ReadonlyMap<string, TypeOwner>;
  /** Type ids that live in the shared module, in IR order. */
  readonly shared: readonly string[];
  /** Resource id → type ids emitted into that resource's file, in IR order. */
  readonly byResource: ReadonlyMap<string, readonly string[]>;
}

/** Every named type id directly mentioned by a type reference. */
function referencedIds(ref: TypeRef, into: Set<string>): void {
  switch (ref.kind) {
    case 'named':
      into.add(ref.id);
      return;
    case 'array':
      return referencedIds(ref.items, into);
    case 'map':
      return referencedIds(ref.values, into);
    case 'nullable':
      return referencedIds(ref.inner, into);
    case 'union':
      for (const variant of ref.variants) referencedIds(variant, into);
      return;
    default:
      return;
  }
}

/** Type ids a named type depends on. */
export function dependenciesOf(type: NamedType): Set<string> {
  const ids = new Set<string>();
  if (type.kind === 'object') {
    for (const field of type.fields) referencedIds(field.type, ids);
    if (type.additional !== undefined) referencedIds(type.additional, ids);
  } else if (type.kind === 'alias') {
    referencedIds(type.target, ids);
  }
  return ids;
}

/** Type ids a method's signature mentions directly. */
function methodTypeIds(method: Method): Set<string> {
  const ids = new Set<string>();
  for (const param of method.http.params) referencedIds(param.type, ids);
  if (method.body !== undefined) referencedIds(method.body.type, ids);
  const response = method.response;
  if (response.kind === 'json') referencedIds(response.type, ids);
  if (response.kind === 'stream') referencedIds(response.event, ids);
  return ids;
}

export function computeOwnership(ir: IR): Ownership {
  const typesById = new Map(ir.types.map((type) => [type.id, type]));

  // Transitive closure of the types each resource's own methods can reach. Sub-resources are
  // separate owners: they get their own file, so a type only they use belongs with them.
  const reachableBy = new Map<string, Set<string>>();

  const walk = (resources: readonly Resource[]): void => {
    for (const resource of resources) {
      const reachable = new Set<string>();
      const queue: string[] = [];
      for (const method of resource.methods) {
        for (const id of methodTypeIds(method)) queue.push(id);
      }
      while (queue.length > 0) {
        const id = queue.pop()!;
        if (reachable.has(id)) continue;
        reachable.add(id);
        const type = typesById.get(id);
        if (type === undefined) continue;
        for (const dependency of dependenciesOf(type)) queue.push(dependency);
      }
      reachableBy.set(resource.id, reachable);
      walk(resource.subresources);
    }
  };
  walk(ir.resources);

  // Count how many resources reach each type.
  const claimants = new Map<string, string[]>();
  for (const [resourceId, reachable] of reachableBy) {
    for (const id of reachable) {
      const list = claimants.get(id) ?? [];
      list.push(resourceId);
      claimants.set(id, list);
    }
  }

  const owners = new Map<string, TypeOwner>();
  for (const type of ir.types) {
    const claiming = claimants.get(type.id) ?? [];
    // Exactly one claimant → colocate. Zero (unreferenced, e.g. an error body) or several →
    // shared, because inventing an owner would make the location arbitrary and unstable.
    owners.set(type.id, claiming.length === 1 ? claiming[0]! : null);
  }

  const shared: string[] = [];
  const byResource = new Map<string, string[]>();
  // Iterate `ir.types` so emission order matches the IR's topological order in every file.
  for (const type of ir.types) {
    const owner = owners.get(type.id) ?? null;
    if (owner === null) {
      shared.push(type.id);
    } else {
      const list = byResource.get(owner) ?? [];
      list.push(type.id);
      byResource.set(owner, list);
    }
  }

  return { owners, shared, byResource };
}
