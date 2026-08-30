/**
 * Suppressing diagnostics the config already answers.
 *
 * The bug: `graft init` writes the split, the promoted required fields, and the pagination scheme into
 * `graft.yaml` — and `check` reported all three anyway, because nothing connected a diagnostic to the
 * config key that resolves it. So the documented flow (init, edit, gate CI on `check --strict`) could
 * never pass, which makes `--strict` unusable for the one job it exists to do.
 */

import { describe, expect, it } from 'vitest';
import { configHasPath, withoutResolved, type Diagnostic } from './diagnostic.js';

function warn(code: string, resolvedBy?: string[]): Diagnostic {
  return { severity: 'warn', code, message: 'x', ...(resolvedBy !== undefined ? { resolvedBy } : {}) };
}

describe('configHasPath', () => {
  it('walks a dotted path', () => {
    expect(configHasPath({ models: { Widget: { split: { read: 'Widget' } } } }, 'models.Widget.split')).toBe(true);
    expect(configHasPath({ models: { Widget: {} } }, 'models.Widget.split')).toBe(false);
    expect(configHasPath({}, 'models.Widget.split')).toBe(false);
  });

  it('treats an empty list or object as unanswered', () => {
    // `required: []` says nothing was promoted, so the diagnostic that asked for it still applies.
    expect(configHasPath({ models: { W: { required: [] } } }, 'models.W.required')).toBe(false);
    expect(configHasPath({ pagination: { default: {} } }, 'pagination.default')).toBe(false);
    expect(configHasPath({ models: { W: { required: ['id'] } } }, 'models.W.required')).toBe(true);
  });

  it('does not walk into a non-object', () => {
    expect(configHasPath({ models: 'nope' }, 'models.Widget.split')).toBe(false);
    expect(configHasPath(null, 'models.Widget.split')).toBe(false);
  });
});

describe('withoutResolved', () => {
  it('drops a diagnostic whose config path is set', () => {
    const config = { pagination: { default: { style: 'offset' } } };
    expect(withoutResolved([warn('P001', ['pagination.default'])], config)).toEqual([]);
  });

  it('keeps a diagnostic that declares nothing', () => {
    // Only a diagnostic that says what would answer it can be answered. Silence-by-default would let
    // an unrelated config key suppress an unrelated warning.
    expect(withoutResolved([warn('S001')], { anything: true })).toHaveLength(1);
  });

  it('requires every path, not any', () => {
    // The aggregate case that makes OR wrong: one diagnostic covers five conflated schemas, so
    // configuring one leaves the warning true of the other four.
    const diagnostics = [warn('M001', ['models.A.split', 'models.B.split'])];
    expect(withoutResolved(diagnostics, { models: { A: { split: { read: 'A' } } } })).toHaveLength(1);
    expect(
      withoutResolved(diagnostics, {
        models: { A: { split: { read: 'A' } }, B: { split: { read: 'B' } } },
      }),
    ).toEqual([]);
  });
});
