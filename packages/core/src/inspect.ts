/**
 * The load → resolve → index → analyze aggregate.
 *
 * Lives in its own module rather than in `index.ts` so that consumers inside this package can
 * depend on {@link Inspection} without importing the barrel. Putting it in the barrel created a
 * genuine import cycle (`index` → `init` → `index`), which the boundary check in CI rejected.
 */

import type { Diagnostic } from '@besdk/protocol';
import { loadSpec, parseSpec, type LoadedSpec } from './load.js';
import { resolveSpec, type ResolvedSpec } from './resolve.js';
import { indexOperations, type OperationIndex } from './operations.js';
import { checkSpec, type AnalysisResult } from './analyze.js';

export interface Inspection {
  readonly spec: LoadedSpec;
  readonly resolved: ResolvedSpec;
  readonly index: OperationIndex;
  readonly analysis: AnalysisResult;
}

function inspectLoaded(spec: LoadedSpec, carried: readonly Diagnostic[]): Inspection {
  const { resolved, diagnostics: resolveDiagnostics } = resolveSpec(spec);
  const index = indexOperations(spec, resolved.resolve);
  const analysis = checkSpec(resolved, index, [...carried, ...resolveDiagnostics]);
  return { spec, resolved, index, analysis };
}

/**
 * Run the read-only half of the pipeline against spec text. This is the whole of what
 * `besdk check` needs, and it takes a string so tests and the snapshot suite can drive the
 * pipeline without touching the filesystem.
 */
export function inspectSpec(contents: string, source: string): Inspection {
  const { spec, diagnostics } = parseSpec(contents, source);
  return inspectLoaded(spec, diagnostics);
}

export async function inspectSpecFile(path: string): Promise<Inspection> {
  const { spec, diagnostics } = await loadSpec(path);
  return inspectLoaded(spec, diagnostics);
}
