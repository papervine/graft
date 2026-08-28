/**
 * `@besdk/runtime-typescript` — the hand-written runtime vendored into generated SDKs.
 *
 * Everything here is written and reviewed as a library, not as generator output. This is where
 * SDK quality actually lives (SPEC.md §3.3); generated code should be a thin surface over it.
 *
 * Generated SDKs receive this as `src/core/`, so these module paths are part of what the
 * emitter targets. Renaming a file here changes generated imports.
 */

export * from './errors.js';
export * from './auth.js';
export * from './coerce.js';
export * from './client.js';
export * from './pagination.js';
export * from './streaming.js';
export * from './validate.js';
export * from './oauth2.js';
export * from './webhooks.js';

export const RUNTIME_VERSION = '0.0.0';
