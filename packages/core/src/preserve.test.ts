import { describe, expect, it } from 'vitest';
import {
  compileIgnore,
  extractRegions,
  mergePackageJson,
  mergeRegions,
  type PreservedRegion,
  regionsEnabled,
} from './preserve.js';

const TS = { lineComment: '//' };
const PY = { lineComment: '#' };

describe('extractRegions', () => {
  it('recovers a region body without the marker lines', () => {
    const { regions, problems } = extractRegions(
      ['before', '// #region assets', '  const x = 1;', '// #endregion assets', 'after'].join('\n'),
      TS,
    );
    expect(problems).toEqual([]);
    expect(regions).toEqual([{ name: 'assets', content: '  const x = 1;' }]);
  });

  it('accepts a bare #endregion', () => {
    const { regions } = extractRegions(['// #region a', 'x', '// #endregion'].join('\n'), TS);
    expect(regions[0]).toMatchObject({ name: 'a', content: 'x' });
  });

  it('works for any line-comment syntax', () => {
    const { regions } = extractRegions(['# #region a', 'x = 1', '# #endregion a'].join('\n'), PY);
    expect(regions[0]).toMatchObject({ name: 'a', content: 'x = 1' });
  });

  it('tolerates indentation before the marker', () => {
    const { regions } = extractRegions(
      ['    // #region a', '    body', '    // #endregion a'].join('\n'),
      TS,
    );
    expect(regions[0]?.content).toBe('    body');
  });

  it('reports an unclosed region rather than guessing where it ends', () => {
    const { problems } = extractRegions(['// #region a', 'x'].join('\n'), TS);
    expect(problems[0]).toContain('never closed');
  });

  it('reports a stray #endregion', () => {
    const { problems } = extractRegions(['// #endregion a'].join('\n'), TS);
    expect(problems[0]).toContain('no matching');
  });

  it('reports a mismatched close', () => {
    const { problems } = extractRegions(
      ['// #region a', 'x', '// #endregion b'].join('\n'),
      TS,
    );
    expect(problems.join(' ')).toContain('closed by');
  });

  it('reports a duplicated region name', () => {
    const { problems } = extractRegions(
      ['// #region a', '1', '// #endregion a', '// #region a', '2', '// #endregion a'].join('\n'),
      TS,
    );
    expect(problems.join(' ')).toContain('more than once');
  });

  it('finds nothing in a file with no markers', () => {
    expect(extractRegions('just code\n', TS).regions).toEqual([]);
  });
});

describe('mergeRegions', () => {
  const generated = ['header', '// #region a', '// #endregion a', 'footer'].join('\n');

  it('splices a preserved body into the matching region', () => {
    const result = mergeRegions(generated, [{ name: 'a', content: 'custom()' }], TS);
    expect(result.text).toBe(
      ['header', '// #region a', 'custom()', '// #endregion a', 'footer'].join('\n'),
    );
    expect(result.applied).toEqual(['a']);
    expect(result.orphaned).toEqual([]);
  });

  it('replaces whatever the generator put inside the region', () => {
    const withPlaceholder = ['// #region a', 'PLACEHOLDER', '// #endregion a'].join('\n');
    const result = mergeRegions(withPlaceholder, [{ name: 'a', content: 'mine' }], TS);
    expect(result.text).not.toContain('PLACEHOLDER');
    expect(result.text).toContain('mine');
  });

  it('orphans a region with content and no home — the abort signal', () => {
    // The property that matters most: this is what stops generation from deleting code.
    const result = mergeRegions(generated, [{ name: 'gone', content: 'important()' }], TS);
    expect(result.orphaned).toEqual([{ name: 'gone', content: 'important()' }]);
    expect(result.applied).toEqual([]);
  });

  it('does not orphan an empty region', () => {
    // An untouched region disappearing is not a loss, and must not block a restructuring of output.
    const result = mergeRegions(generated, [{ name: 'gone', content: '   \n  ' }], TS);
    expect(result.orphaned).toEqual([]);
  });

  it('leaves output untouched when nothing was preserved', () => {
    expect(mergeRegions(generated, [], TS).text).toBe(generated);
  });

  it('handles several regions in one file', () => {
    const multi = [
      '// #region a',
      '// #endregion a',
      'middle',
      '// #region b',
      '// #endregion b',
    ].join('\n');
    const preserved: PreservedRegion[] = [
      { name: 'a', content: 'A' },
      { name: 'b', content: 'B' },
    ];
    const result = mergeRegions(multi, preserved, TS);
    expect(result.applied.sort()).toEqual(['a', 'b']);
    expect(result.text).toContain('A');
    expect(result.text).toContain('B');
  });
});

describe('compileIgnore', () => {
  it('matches a bare filename at any depth, like gitignore', () => {
    const ignored = compileIgnore(['helpers.ts']);
    expect(ignored('helpers.ts')).toBe(true);
    expect(ignored('src/custom/helpers.ts')).toBe(true);
    expect(ignored('src/other.ts')).toBe(false);
  });

  it('anchors a pattern containing a slash', () => {
    const ignored = compileIgnore(['src/custom/helpers.ts']);
    expect(ignored('src/custom/helpers.ts')).toBe(true);
    expect(ignored('other/src/custom/helpers.ts')).toBe(false);
  });

  it('supports ** across directories', () => {
    const ignored = compileIgnore(['src/custom/**']);
    expect(ignored('src/custom/a.ts')).toBe(true);
    expect(ignored('src/custom/deep/b.ts')).toBe(true);
    expect(ignored('src/resources/a.ts')).toBe(false);
  });

  it('treats a trailing slash as a directory', () => {
    const ignored = compileIgnore(['src/custom/']);
    expect(ignored('src/custom/a.ts')).toBe(true);
  });

  it('supports * within a segment but not across separators', () => {
    const ignored = compileIgnore(['src/*.ts']);
    expect(ignored('src/a.ts')).toBe(true);
    expect(ignored('src/deep/a.ts')).toBe(false);
  });

  it('lets a later negation re-include a file', () => {
    const ignored = compileIgnore(['src/custom/**', '!src/custom/generated.ts']);
    expect(ignored('src/custom/a.ts')).toBe(true);
    expect(ignored('src/custom/generated.ts')).toBe(false);
  });

  it('skips comments and blank lines', () => {
    const ignored = compileIgnore(['# a comment', '', '  ', 'real.ts']);
    expect(ignored('real.ts')).toBe(true);
    expect(ignored('a.ts')).toBe(false);
  });

  it('ignores nothing when given nothing', () => {
    expect(compileIgnore([])('anything.ts')).toBe(false);
  });
});

describe('mergePackageJson', () => {
  const generated = JSON.stringify(
    { name: '@a/sdk', version: '1.0', devDependencies: { typescript: '^5' } },
    null,
    2,
  );

  it('returns the generated file when there is nothing to merge', () => {
    expect(mergePackageJson(generated, undefined).text).toBe(generated);
  });

  it('keeps a user-added dependency', () => {
    const existing = JSON.stringify({ name: '@a/sdk', dependencies: { 'date-fns': '^3' } });
    const { text, carried } = mergePackageJson(generated, existing);
    expect(JSON.parse(text).dependencies).toEqual({ 'date-fns': '^3' });
    expect(carried).toContain('dependencies.date-fns');
  });

  it('keeps user-added top-level fields', () => {
    const existing = JSON.stringify({ author: 'Jeff', repository: 'github:a/b' });
    const { text } = mergePackageJson(generated, existing);
    expect(JSON.parse(text).author).toBe('Jeff');
  });

  it('keeps generated values for fields graft owns', () => {
    // Renaming the package is a config decision, not something a stale file should win.
    const existing = JSON.stringify({ name: '@stale/name', version: '0.0.1' });
    const { text } = mergePackageJson(generated, existing);
    expect(JSON.parse(text).name).toBe('@a/sdk');
    expect(JSON.parse(text).version).toBe('1.0');
  });

  it("prefers the user's pin when both declare a dependency", () => {
    const existing = JSON.stringify({ devDependencies: { typescript: '5.4.2' } });
    const { text } = mergePackageJson(generated, existing);
    expect(JSON.parse(text).devDependencies.typescript).toBe('5.4.2');
  });

  it('falls back to the generated file when the existing one is unparseable', () => {
    const { text, carried } = mergePackageJson(generated, '{ not json');
    expect(text).toBe(generated);
    expect(carried).toEqual([]);
  });
});

describe('regionsEnabled', () => {
  /**
   * The bug this pins, in full: every target emits `#region` markers unconditionally and labels them
   * "preserved across regeneration". The gate read `regions !== true`, so with no `preserve` config a
   * hand-written method between those markers was silently deleted on the next `generate` — which is
   * precisely the outcome SPEC.md §3.9 declares unforgivable, caused by the default rather than by any
   * fault in the merging logic, which was correct all along.
   *
   * So the direction of the default is the thing under test, not the mechanism.
   */
  it('is on when nothing is configured', () => {
    expect(regionsEnabled({})).toBe(true);
    expect(regionsEnabled({ preserve: {} })).toBe(true);
    expect(regionsEnabled({ preserve: { regions: undefined } })).toBe(true);
  });

  it('is off only when explicitly disabled', () => {
    expect(regionsEnabled({ preserve: { regions: false } })).toBe(false);
  });

  it('is on when explicitly enabled', () => {
    expect(regionsEnabled({ preserve: { regions: true } })).toBe(true);
  });
});
