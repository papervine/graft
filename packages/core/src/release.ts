/**
 * Version and changelog computation (SPEC.md §3.5.1).
 *
 * graft owns the parts that need contract knowledge — what the next version is, and what changed — and
 * nothing else. It never publishes: a tool that needs registry credentials is a tool nobody runs
 * locally to see what it would do.
 *
 * The version comes from `graft diff`, which is the only thing in a release pipeline that knows a
 * required-ness flip breaks read and write models in opposite directions (§3.8). A commit message
 * cannot know that, and neither can a human skimming a diff.
 */

import { BRAND } from '@graft/protocol';

import type { Change, DiffResult } from './diff.js';
import { impliedBump } from './diff.js';

/** A parsed semantic version. Pre-release and build metadata are preserved but never invented. */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}

export type Bump = 'major' | 'minor' | 'patch' | 'none';

/**
 * The version a brand-new SDK starts at.
 *
 * `0.1.0` rather than `1.0.0`: a generator declaring someone's API stable on their behalf is
 * overstepping, and `0.x` accurately says "generated, not yet promised". Reaching 1.0.0 is a deliberate
 * act.
 */
export const INITIAL_VERSION = '0.1.0';

export function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] !== undefined ? { prerelease: match[4] } : {}),
  };
}

export function formatVersion(version: Version): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease === undefined ? base : `${base}-${version.prerelease}`;
}

/**
 * Apply a bump.
 *
 * Two rules that are easy to get wrong:
 *
 * **A pre-release is resolved rather than bumped.** `1.2.0-rc.1` with an additive change becomes
 * `1.2.0`, not `1.3.0`: the pre-release was already claiming that version, and bumping again would skip
 * a number nobody published.
 *
 * **Below 1.0.0, a breaking change bumps the minor.** That is the semver convention for `0.x` — the
 * major is pinned at zero precisely to say "anything may change" — and treating a breaking change as a
 * major bump would push an unfinished SDK to 1.0.0 on its first rename.
 */
export function applyBump(version: Version, bump: Bump): Version {
  if (bump === 'none') return version;

  if (version.prerelease !== undefined) {
    return { major: version.major, minor: version.minor, patch: version.patch };
  }

  if (version.major === 0) {
    switch (bump) {
      case 'major':
      case 'minor':
        return { major: 0, minor: version.minor + 1, patch: 0 };
      case 'patch':
        return { major: 0, minor: version.minor, patch: version.patch + 1 };
    }
  }

  switch (bump) {
    case 'major':
      return { major: version.major + 1, minor: 0, patch: 0 };
    case 'minor':
      return { major: version.major, minor: version.minor + 1, patch: 0 };
    case 'patch':
      return { major: version.major, minor: version.minor, patch: version.patch + 1 };
  }
}

export interface ReleasePlan {
  readonly current: string;
  readonly next: string;
  readonly bump: Bump;
  /** Reason the bump is what it is, for the command's output. */
  readonly because: string;
  readonly changes: readonly Change[];
  /**
   * True when a Go consumer would need the module path to change.
   *
   * Go requires `/v2` and above **in the module path**, so a major bump past 1 is not a version edit —
   * it is a rename of every import. Surfaced rather than performed, because it changes files a user may
   * have customised.
   */
  readonly goMajorSuffix?: string;
}

/** Work out what the next release should be. */
export function planRelease(
  currentVersion: string | undefined,
  diff: DiffResult,
  override?: string,
): ReleasePlan {
  const current = currentVersion ?? INITIAL_VERSION;
  const parsed = parseVersion(current);

  if (override !== undefined) {
    const explicit = parseVersion(override);
    if (explicit === undefined) {
      throw new Error(`\`${override}\` is not a semantic version, e.g. 1.4.0`);
    }
    return {
      current,
      next: formatVersion(explicit),
      bump: 'none',
      because: 'set explicitly',
      changes: diff.changes,
      ...goSuffix(explicit),
    };
  }

  if (currentVersion === undefined) {
    // A first release is the initial version, whatever the diff says. There is no published SDK for a
    // change to be additive *to* — the diff is against the IR baseline, which tracks the spec, not
    // against anything a consumer has installed. Reporting `0.2.0` here, as an earlier version did,
    // claimed a release that never happened.
    return {
      current: INITIAL_VERSION,
      next: INITIAL_VERSION,
      bump: 'none',
      because: 'first release',
      changes: diff.changes,
    };
  }

  if (parsed === undefined) {
    // An unparseable stored version is a corrupted file rather than a reason to guess. Starting over
    // silently would publish a version that goes backwards.
    throw new Error(
      `The recorded SDK version \`${current}\` is not a semantic version. Fix it, or pass --version.`,
    );
  }

  const bump = impliedBump(diff);
  const next = applyBump(parsed, bump);
  return {
    current,
    next: formatVersion(next),
    bump,
    because: describeBump(bump, diff, parsed),
    changes: diff.changes,
    ...goSuffix(next),
  };
}

function goSuffix(version: Version): { goMajorSuffix?: string } {
  return version.major >= 2 ? { goMajorSuffix: `/v${version.major}` } : {};
}

/**
 * Explain why the version moved the way it did.
 *
 * Keyed on the *classification* and the current major together, not on the bump label alone. Below
 * 1.0.0 a breaking change is classified `major` but moves the **minor**, so describing it from the
 * label produced "1 breaking change" next to `0.3.0 → 0.4.0` and left a reader thinking the
 * classification was wrong.
 */
function describeBump(bump: Bump, diff: DiffResult, current: Version): string {
  const plural = (count: number, word: string): string =>
    `${count} ${word}${count === 1 ? '' : 's'}`;

  switch (bump) {
    case 'major':
      return current.major === 0
        ? `${plural(diff.breaking, 'breaking change')}, which moves the minor below 1.0.0`
        : plural(diff.breaking, 'breaking change');
    case 'minor':
      return plural(diff.additive, 'additive change');
    case 'patch':
      return `${plural(diff.patch, 'change')} with no effect on consumers`;
    case 'none':
      return 'no contract changes';
  }
}

/**
 * Render a changelog entry.
 *
 * Grouped by severity rather than listed flat, because the only question a reader has is "will this
 * break me". `date` is passed in rather than read from the clock, so the same inputs produce the same
 * output — a generator whose output depends on when it ran cannot be snapshot-tested.
 */
export function renderChangelogEntry(plan: ReleasePlan, date: string): string {
  const lines: string[] = [`## ${plan.next} — ${date}`, ''];

  if (plan.changes.length === 0) {
    lines.push('No changes to the API contract.', '');
    return lines.join('\n');
  }

  const groups: Array<[label: string, severity: Change['severity'], note?: string]> = [
    ['Breaking', 'breaking', 'These require changes in code that uses this SDK.'],
    ['Added', 'additive'],
    ['Other', 'patch'],
  ];

  for (const [label, severity, note] of groups) {
    const matching = plan.changes.filter((change) => change.severity === severity);
    if (matching.length === 0) continue;
    lines.push(`### ${label}`, '');
    if (note !== undefined) lines.push(note, '');
    for (const change of matching) {
      lines.push(`- \`${change.path}\` — ${change.message}`);
      // The `detail` is why it breaks, which is the part a reader actually needs when deciding
      // whether to upgrade.
      if (change.detail !== undefined) lines.push(`  ${change.detail}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Insert an entry into a changelog, newest first.
 *
 * Idempotent on the version: re-running `release` for a version already present replaces that entry
 * rather than adding a second one. A duplicated heading in a changelog is the kind of thing nobody
 * notices until a consumer is comparing two of them.
 */
export function insertChangelogEntry(existing: string | undefined, entry: string, version: string): string {
  const header =
    `# Changelog\n\nEvery entry is generated from the API contract by \`${BRAND.name} release\`.\n`;
  if (existing === undefined || existing.trim() === '') {
    return `${header}\n${entry}`;
  }

  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const already = new RegExp(`^## ${escaped}\\b`, 'm');
  if (already.test(existing)) {
    // Replace from this heading up to the next one, or the end.
    const start = existing.search(already);
    const rest = existing.slice(start);
    const nextHeading = rest.slice(1).search(/^## /m);
    const end = nextHeading === -1 ? existing.length : start + 1 + nextHeading;
    return existing.slice(0, start) + entry + existing.slice(end);
  }

  // Newest first, after the file's own header.
  const firstEntry = existing.search(/^## /m);
  if (firstEntry === -1) {
    return `${existing.replace(/\n*$/, '\n')}\n${entry}`;
  }
  return existing.slice(0, firstEntry) + entry + existing.slice(firstEntry);
}
