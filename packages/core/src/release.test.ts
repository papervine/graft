/**
 * Tests for version and changelog computation.
 *
 * The semver rules below are each a decision recorded in SPEC.md §3.5.1, and each is a place a
 * plausible implementation would be wrong in a way nobody notices until a version is published.
 */

import { describe, expect, it } from 'vitest';
import type { Change, DiffResult } from './diff.js';
import {
  INITIAL_VERSION,
  applyBump,
  formatVersion,
  insertChangelogEntry,
  parseVersion,
  planRelease,
  renderChangelogEntry,
} from './release.js';

function diff(changes: Change[]): DiffResult {
  return {
    changes,
    breaking: changes.filter((c) => c.severity === 'breaking').length,
    additive: changes.filter((c) => c.severity === 'additive').length,
    patch: changes.filter((c) => c.severity === 'patch').length,
  };
}

const breaking: Change = {
  severity: 'breaking',
  path: 'Widget.name',
  message: 'became optional',
  detail: 'Code that assumed it was present must handle absence.',
};
const additive: Change = { severity: 'additive', path: 'widgets.archive', message: 'method added' };
const cosmetic: Change = { severity: 'patch', path: 'Widget', message: 'description changed' };

describe('parsing', () => {
  it('accepts a plain version and a v prefix', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('keeps a pre-release and discards build metadata', () => {
    expect(parseVersion('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: 'rc.1' });
    expect(parseVersion('1.2.3+build.5')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('rejects what is not a version', () => {
    // Stripe's API version is a date. Treating it as a package version is what once produced a
    // pyproject.toml that ruff could not parse.
    expect(parseVersion('2026-07-29.dahlia')).toBeUndefined();
    expect(parseVersion('1.2')).toBeUndefined();
    expect(parseVersion('')).toBeUndefined();
  });
});

describe('bumping', () => {
  it('moves major, minor, and patch above 1.0.0', () => {
    const from = parseVersion('1.4.2')!;
    expect(formatVersion(applyBump(from, 'major'))).toBe('2.0.0');
    expect(formatVersion(applyBump(from, 'minor'))).toBe('1.5.0');
    expect(formatVersion(applyBump(from, 'patch'))).toBe('1.4.3');
  });

  it('treats a breaking change below 1.0.0 as a minor bump', () => {
    // The semver convention for 0.x: the major is pinned at zero to say "anything may change".
    // Treating a breaking change as major would push an unfinished SDK to 1.0.0 on its first rename.
    const from = parseVersion('0.3.1')!;
    expect(formatVersion(applyBump(from, 'major'))).toBe('0.4.0');
    expect(formatVersion(applyBump(from, 'minor'))).toBe('0.4.0');
    expect(formatVersion(applyBump(from, 'patch'))).toBe('0.3.2');
  });

  it('resolves a pre-release rather than bumping past it', () => {
    // `1.2.0-rc.1` was already claiming 1.2.0. Bumping again would skip a number nobody published.
    const from = parseVersion('1.2.0-rc.1')!;
    expect(formatVersion(applyBump(from, 'minor'))).toBe('1.2.0');
    expect(formatVersion(applyBump(from, 'major'))).toBe('1.2.0');
  });

  it('leaves the version alone for no change', () => {
    const from = parseVersion('1.4.2')!;
    expect(formatVersion(applyBump(from, 'none'))).toBe('1.4.2');
  });
});

describe('planning', () => {
  it('starts a first release at the initial version whatever the diff says', () => {
    // There is no published SDK for a change to be additive *to*. An earlier version reported 0.2.0
    // here, claiming a release that never happened.
    const plan = planRelease(undefined, diff([additive, additive]));
    expect(plan.next).toBe(INITIAL_VERSION);
    expect(plan.bump).toBe('none');
    expect(plan.because).toBe('first release');
    // The changes still reach the changelog — they are what the first release contains.
    expect(plan.changes).toHaveLength(2);
  });

  it('maps breaking to major, additive to minor, cosmetic to patch', () => {
    expect(planRelease('1.0.0', diff([breaking, additive])).next).toBe('2.0.0');
    expect(planRelease('1.0.0', diff([additive, cosmetic])).next).toBe('1.1.0');
    expect(planRelease('1.0.0', diff([cosmetic])).next).toBe('1.0.1');
    expect(planRelease('1.0.0', diff([])).bump).toBe('none');
  });

  it('explains a breaking change that moves the minor', () => {
    // Otherwise a reader comparing 0.3.0 to 0.4.0 would think the classification was wrong.
    const plan = planRelease('0.3.0', diff([breaking]));
    expect(plan.next).toBe('0.4.0');
    expect(plan.because).toContain('below 1.0.0');
  });

  it('honours an explicit version', () => {
    const plan = planRelease('0.9.0', diff([breaking]), '1.0.0');
    expect(plan.next).toBe('1.0.0');
    expect(plan.because).toBe('set explicitly');
  });

  it('rejects an explicit version that is not semver', () => {
    expect(() => planRelease('1.0.0', diff([]), 'next')).toThrowError(/not a semantic version/);
  });

  it('refuses to guess when the recorded version is corrupt', () => {
    // Starting over silently would publish a version that goes backwards.
    expect(() => planRelease('not-a-version', diff([additive]))).toThrowError(/Fix it/);
  });

  it('flags a Go module path change at major 2 and above', () => {
    // Go requires the major in the module path, so this is a rename of every import.
    expect(planRelease('1.9.0', diff([breaking])).goMajorSuffix).toBe('/v2');
    expect(planRelease('1.0.0', diff([additive])).goMajorSuffix).toBeUndefined();
    expect(planRelease('0.5.0', diff([breaking])).goMajorSuffix).toBeUndefined();
  });
});

describe('changelog rendering', () => {
  it('groups by severity and leads with breaking', () => {
    // The only question a reader has is "will this break me".
    const entry = renderChangelogEntry(planRelease('1.0.0', diff([additive, breaking])), '2026-08-06');
    expect(entry).toContain('## 2.0.0 — 2026-08-06');
    expect(entry.indexOf('### Breaking')).toBeLessThan(entry.indexOf('### Added'));
    // The detail is why it breaks, which is what a reader deciding whether to upgrade needs.
    expect(entry).toContain('Code that assumed it was present must handle absence.');
  });

  it('says so plainly when nothing changed', () => {
    const entry = renderChangelogEntry(planRelease('1.0.0', diff([])), '2026-08-06');
    expect(entry).toContain('No changes to the API contract.');
  });

  it('takes the date as an argument rather than reading the clock', () => {
    // A generator whose output depends on when it ran cannot be snapshot-tested.
    const first = renderChangelogEntry(planRelease('1.0.0', diff([additive])), '2020-01-01');
    const second = renderChangelogEntry(planRelease('1.0.0', diff([additive])), '2020-01-01');
    expect(first).toBe(second);
  });
});

describe('changelog insertion', () => {
  it('creates a file with a header when none exists', () => {
    const result = insertChangelogEntry(undefined, '## 0.1.0 — d\n\nfirst\n', '0.1.0');
    expect(result).toContain('# Changelog');
    expect(result).toContain('## 0.1.0');
  });

  it('inserts newest first, after the header', () => {
    const existing = '# Changelog\n\nintro\n\n## 1.0.0 — old\n\nold entry\n';
    const result = insertChangelogEntry(existing, '## 1.1.0 — new\n\nnew entry\n', '1.1.0');
    expect(result.indexOf('## 1.1.0')).toBeLessThan(result.indexOf('## 1.0.0'));
    expect(result).toContain('intro');
  });

  it('replaces an entry for a version already present', () => {
    // Re-running release for the same version must not produce two headings — the kind of thing
    // nobody notices until a consumer is comparing two changelogs.
    const existing = '# Changelog\n\n## 1.1.0 — old\n\nstale\n\n## 1.0.0 — older\n\nkeep\n';
    const result = insertChangelogEntry(existing, '## 1.1.0 — new\n\nfresh\n', '1.1.0');
    expect(result.match(/## 1\.1\.0/g)).toHaveLength(1);
    expect(result).toContain('fresh');
    expect(result).not.toContain('stale');
    expect(result).toContain('keep');
  });

  it('does not confuse a version with one that shares its prefix', () => {
    const existing = '# Changelog\n\n## 1.1.10 — x\n\nten\n';
    const result = insertChangelogEntry(existing, '## 1.1.1 — y\n\none\n', '1.1.1');
    expect(result).toContain('ten');
    expect(result).toContain('one');
  });
});
