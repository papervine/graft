/**
 * `@graft/core` — the pipeline: load → resolve → normalize → overlay → ir.
 *
 * Boundary rules (SPEC.md §3.7), both enforced in CI by `pnpm boundaries`:
 *   - this package must never import a target;
 *   - this barrel must stay a pure re-export, so modules inside the package import each other
 *     directly and no cycle can form through it.
 */

export const PIPELINE_STAGES = ['load', 'resolve', 'normalize', 'overlay', 'ir'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export * from './json.js';
export * from './load.js';
export * from './resolve.js';
export * from './operations.js';
export * from './analyze.js';
export * from './config.js';
export * from './inspect.js';
export * from './names.js';
export * from './buildIR.js';
export * from './diff.js';
export * from './release.js';
export * from './preserve.js';
export * from './extensions.js';
export * from './init.js';
