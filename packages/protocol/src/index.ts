/**
 * `@graft/protocol` — the public contract.
 *
 * This package depends on nothing but `zod` and is the only thing a third-party target needs
 * to understand. See SPEC.md §3.5 and §3.7.
 */

export * from './branding.js';
export * from './ir.js';
export * from './diagnostic.js';
export * from './target.js';
