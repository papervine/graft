/**
 * Stage 2: resolve — build the `$ref` graph and find cycles.
 *
 * Cycles are *detected and recorded*, never inlined. Inlining a cycle either loops forever or
 * silently truncates the type; both are worse than telling the target "this type is cyclic,
 * break it however your language breaks cycles" (SPEC.md §3.2).
 */

import { DIAGNOSTIC_CODES, type Diagnostic } from '@besdk/protocol';
import {
  entriesOf,
  isArray,
  isObject,
  pointer,
  resolvePointer,
  type Json,
  type JsonObject,
} from './json.js';
import type { LoadedSpec } from './load.js';

const COMPONENT_SCHEMA_PREFIX = '#/components/schemas/';

export interface ResolvedSpec {
  readonly spec: LoadedSpec;
  /** Named component schemas, keyed by name. */
  readonly schemas: ReadonlyMap<string, JsonObject>;
  /** For each schema name, the schema names it references directly. */
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  /** Schema names participating in a reference cycle. */
  readonly cyclic: ReadonlySet<string>;
  /** Every `$ref` string in the document that could not be resolved. */
  readonly unresolved: readonly string[];
  resolve(ref: string): Json | undefined;
}

/** Extract the component name from a local schema `$ref`, if it is one. */
export function componentSchemaName(ref: string): string | undefined {
  return ref.startsWith(COMPONENT_SCHEMA_PREFIX)
    ? ref.slice(COMPONENT_SCHEMA_PREFIX.length)
    : undefined;
}

/** Walk every node, yielding each `$ref` string encountered with its containing pointer. */
export function* walkRefs(root: Json, path: string[] = []): Generator<{ ref: string; at: string }> {
  if (isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      yield* walkRefs(root[i] as Json, [...path, String(i)]);
    }
    return;
  }
  if (!isObject(root)) return;

  const ref = root['$ref'];
  if (typeof ref === 'string') {
    yield { ref, at: pointer(...path) };
    // A node with `$ref` may still carry siblings (legal in 3.1, common as a mistake in
    // 3.0), so keep walking rather than returning early.
  }
  for (const [key, value] of Object.entries(root)) {
    if (key === '$ref') continue;
    yield* walkRefs(value as Json, [...path, key]);
  }
}

/**
 * Tarjan-style cycle detection over the schema reference graph.
 *
 * Returns every schema that sits on at least one cycle, including self-references. Iterative
 * rather than recursive: schema graphs in real specs get deep enough to blow the stack.
 */
function findCyclicSchemas(edges: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const cyclic = new Set<string>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;

  for (const root of edges.keys()) {
    if (index.has(root)) continue;

    // Explicit work stack: each frame is a node plus how many of its edges we have consumed.
    const work: Array<{ node: string; neighbours: string[]; cursor: number }> = [
      { node: root, neighbours: [...(edges.get(root) ?? [])], cursor: 0 },
    ];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.cursor < frame.neighbours.length) {
        const next = frame.neighbours[frame.cursor]!;
        frame.cursor += 1;
        if (next === frame.node) {
          cyclic.add(next); // self-reference
          continue;
        }
        if (!edges.has(next)) continue; // dangling ref; reported separately
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, neighbours: [...(edges.get(next) ?? [])], cursor: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      }
      // Root of a strongly connected component: pop it and record if non-trivial.
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let popped: string | undefined;
        do {
          popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== frame.node);
        if (component.length > 1) {
          for (const member of component) cyclic.add(member);
        }
      }
    }
  }

  return cyclic;
}

export function resolveSpec(spec: LoadedSpec): { resolved: ResolvedSpec; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const document = spec.document;

  const schemas = new Map<string, JsonObject>();
  const components = document['components'];
  for (const [name, schema] of entriesOf(components, 'schemas')) {
    if (isObject(schema)) schemas.set(name, schema);
  }

  // Direct schema→schema edges, and every unresolvable ref in the whole document.
  const edges = new Map<string, Set<string>>();
  for (const name of schemas.keys()) edges.set(name, new Set());

  const unresolved = new Set<string>();
  for (const { ref } of walkRefs(document)) {
    if (resolvePointer(document, ref) === undefined) unresolved.add(ref);
  }
  for (const [name, schema] of schemas) {
    const target = edges.get(name)!;
    for (const { ref } of walkRefs(schema)) {
      const referenced = componentSchemaName(ref);
      if (referenced !== undefined && schemas.has(referenced)) target.add(referenced);
    }
  }

  const cyclic = findCyclicSchemas(edges);

  if (cyclic.size > 0) {
    diagnostics.push({
      severity: 'info',
      code: DIAGNOSTIC_CODES.REFERENCE_CYCLE,
      message: `${cyclic.size} schema${cyclic.size === 1 ? '' : 's'} participate in reference cycles.`,
      detail: [...cyclic].sort().slice(0, 10),
      count: cyclic.size,
    });
  }

  if (unresolved.size > 0) {
    diagnostics.push({
      severity: 'warn',
      code: DIAGNOSTIC_CODES.SPEC_VIOLATION_TOLERATED,
      message: `${unresolved.size} \`$ref\`${unresolved.size === 1 ? '' : 's'} could not be resolved.`,
      detail: [
        ...[...unresolved].sort().slice(0, 10),
        'These become `unknown` in generated output.',
      ],
      count: unresolved.size,
    });
  }

  return {
    resolved: {
      spec,
      schemas,
      edges,
      cyclic,
      unresolved: [...unresolved].sort(),
      resolve: (ref) => resolvePointer(document, ref),
    },
    diagnostics,
  };
}
