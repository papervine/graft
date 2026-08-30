/**
 * Target resolution, which two commands used to implement separately and disagree about.
 *
 * `generate` honoured `targets.<name>.command`; `targets` read only the config keys and went straight
 * to `PATH`. So `graft targets` reported the configured Python and Go targets as "not installed" while
 * `generate` ran them without complaint — the command whose entire job is reporting usability was wrong
 * about two thirds of the project. These tests pin the order so one resolver stays one resolver.
 */

import { describe, expect, it } from 'vitest';
import { TARGET_EXECUTABLE_PREFIX } from '@graft/protocol';
import { resolveTarget } from './target-resolution.js';

describe('resolveTarget', () => {
  it('prefers a configured command, which is the whole bug', () => {
    // The only way to reach a target that is neither an npm package nor on PATH — the normal situation
    // for a target written in another language, which is how Python and Go run from a checkout.
    const resolved = resolveTarget('python', ['uv', 'run', 'graft-target-python']);
    expect(resolved.command).toBe('uv');
    expect(resolved.args).toEqual(['run', 'graft-target-python']);
    expect(resolved.origin).toBe('config');
  });

  it('ignores an empty configured command rather than spawning nothing', () => {
    expect(resolveTarget('go', []).origin).not.toBe('config');
  });

  it('finds an installed in-tree target, so a checkout needs no global install', () => {
    const resolved = resolveTarget('typescript', undefined);
    expect(resolved.origin).toBe('in-tree');
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args[0]).toMatch(/target-typescript/);
  });

  it('falls back to PATH for a target it cannot find', () => {
    // Never fails: the caller reports a missing executable rather than an absent resolution.
    const resolved = resolveTarget('elixir', undefined);
    expect(resolved.origin).toBe('PATH');
    expect(resolved.command).toBe(`${TARGET_EXECUTABLE_PREFIX}elixir`);
    expect(resolved.args).toEqual([]);
  });
});
