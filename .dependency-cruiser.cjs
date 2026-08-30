/**
 * Package boundary enforcement — SPEC.md §3.7.
 *
 * These four rules *are* the architecture. Every one of them is the kind of boundary that
 * erodes silently: someone needs one type from `core` inside a target, imports it, and the
 * subprocess protocol quietly stops being the real interface. Machine-check them.
 */
module.exports = {
  forbidden: [
    {
      name: 'protocol-is-standalone',
      severity: 'error',
      comment:
        '@graft/protocol is the public contract third-party targets depend on. If it grew an ' +
        'internal dependency, implementing a target would mean depending on graft internals.',
      from: { path: '^packages/protocol/' },
      to: { path: '^packages/(?!protocol/)' },
    },
    {
      name: 'core-must-not-import-target',
      severity: 'error',
      comment:
        'SPEC.md §3.7. The core reaches targets only by spawning them (§3.5). A direct import ' +
        'means the core has grown knowledge of one language, which is what the IR exists to prevent.',
      from: { path: '^packages/core/' },
      to: { path: '^packages/(target-|runtime-)' },
    },
    {
      name: 'target-must-not-import-core',
      severity: 'error',
      comment:
        'SPEC.md §3.5. Blessed targets get no in-process privileges. A target that imports the ' +
        'core is no longer exercising the protocol a third-party target must use.',
      from: { path: '^packages/target-' },
      to: { path: '^packages/(core|cli)/' },
    },
    {
      name: 'runtime-is-standalone',
      severity: 'error',
      comment:
        'The hand-written runtime is vendored verbatim into generated SDKs. Any dependency here ' +
        'becomes a dependency of every SDK we generate.',
      from: { path: '^packages/runtime-typescript/' },
      to: { path: '^packages/(?!runtime-typescript/)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports across these packages would mean the layering is fictional.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment:
        'An import that does not resolve is invisible to every rule above — it stays a bare ' +
        'specifier, matches no path pattern, and passes silently. That makes the boundary ' +
        'rules unsound, so treat unresolvable imports as errors in their own right.',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    // pnpm links workspace packages as symlinks. Preserving them (rather than resolving to
    // the real path) would report imports as `node_modules/@graft/*` and the rules above
    // would never match, so leave this false.
    preserveSymlinks: false,
    // Deliberately no `exclude` for dist/. Workspace `main` fields point into dist/, so a
    // cross-package import resolves to `packages/<name>/dist/index.js`. Excluding dist/ drops
    // exactly the node the rules above need to match, and every rule silently passes.
    // Entry points are restricted to src/ on the command line instead.
  },
};
