/**
 * Code preservation — keeping hand-written code across regeneration.
 *
 * Without this, the first customization anyone makes is destroyed by the next `generate`, which
 * makes the generator unusable for real work. Fern and Speakeasy each solved half of it:
 *
 *   - Fern's `.fernignore` protects whole files. Simple and robust, but a custom method has to live
 *     in a subclass, and an ignored file goes **stale silently**.
 *   - Speakeasy's `// #region` markers let a method land on the generated class itself. Finer
 *     grained, but the generator must read its own prior output.
 *
 * graft supports both, because they solve different problems, and adds the thing neither states:
 *
 * **Preservation failure never destroys code.** If a region exists on disk and the newly generated
 * file has no marker to put it back into, generation *aborts*. Silently dropping someone's
 * hand-written code is unforgivable, and "the marker moved" is exactly when it would happen.
 *
 * Markers are brand-neutral (`#region`, the common editor-folding convention) rather than
 * `graft:`-prefixed. A marker carrying the tool's name would appear in users' files, making a
 * rename of this project a breaking change for everyone who customized anything.
 */

/** A named span of hand-written code recovered from a previously generated file. */
export interface PreservedRegion {
  readonly name: string;
  /** Body between the markers, excluding the marker lines themselves. */
  readonly content: string;
}

export interface RegionMarkers {
  /** Line-comment prefix for the target language: `//`, `#`, `--`. */
  readonly lineComment: string;
}

function beginPattern(markers: RegionMarkers): RegExp {
  const comment = escapeRegExp(markers.lineComment);
  return new RegExp(`^[ \\t]*${comment}\\s*#region\\s+([A-Za-z0-9_.:-]+)[ \\t]*$`);
}

function endPattern(markers: RegionMarkers): RegExp {
  const comment = escapeRegExp(markers.lineComment);
  return new RegExp(`^[ \\t]*${comment}\\s*#endregion(?:\\s+([A-Za-z0-9_.:-]+))?[ \\t]*$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Recover every marked region from a file's text.
 *
 * Unterminated and duplicated regions are reported rather than guessed at: both mean the file was
 * edited in a way that makes automatic placement ambiguous, and guessing risks moving code
 * somewhere it does not belong.
 */
export function extractRegions(
  text: string,
  markers: RegionMarkers,
): { regions: PreservedRegion[]; problems: string[] } {
  const begin = beginPattern(markers);
  const end = endPattern(markers);
  const lines = text.split('\n');

  const regions: PreservedRegion[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  let openName: string | undefined;
  let openLine = 0;
  let body: string[] = [];

  lines.forEach((line, index) => {
    const beginMatch = begin.exec(line);
    if (beginMatch !== undefined && beginMatch !== null) {
      if (openName !== undefined) {
        problems.push(
          `region \`${openName}\` opened at line ${openLine} is still open at line ${index + 1}`,
        );
      }
      openName = beginMatch[1]!;
      openLine = index + 1;
      body = [];
      return;
    }

    const endMatch = end.exec(line);
    if (endMatch !== undefined && endMatch !== null) {
      if (openName === undefined) {
        problems.push(`\`#endregion\` at line ${index + 1} has no matching \`#region\``);
        return;
      }
      const named = endMatch[1];
      if (named !== undefined && named !== openName) {
        problems.push(
          `region \`${openName}\` is closed by \`#endregion ${named}\` at line ${index + 1}`,
        );
      }
      if (seen.has(openName)) {
        problems.push(`region \`${openName}\` appears more than once`);
      }
      seen.add(openName);
      regions.push({ name: openName, content: body.join('\n') });
      openName = undefined;
      return;
    }

    if (openName !== undefined) body.push(line);
  });

  if (openName !== undefined) {
    problems.push(`region \`${openName}\` opened at line ${openLine} is never closed`);
  }

  return { regions, problems };
}

export interface MergeResult {
  readonly text: string;
  /** Regions that were carried across. */
  readonly applied: readonly string[];
  /**
   * Regions that existed on disk with content but have no marker in the new output.
   *
   * Non-empty means generation must **abort**: writing would delete this code.
   */
  readonly orphaned: readonly PreservedRegion[];
}

/**
 * Splice preserved regions into newly generated text.
 *
 * Only regions with non-whitespace content can be orphaned. An empty region simply disappearing is
 * not a loss, so it must not block a legitimate restructuring of the output.
 */
export function mergeRegions(
  generated: string,
  preserved: readonly PreservedRegion[],
  markers: RegionMarkers,
): MergeResult {
  const withContent = preserved.filter((region) => region.content.trim() !== '');
  if (withContent.length === 0) {
    return { text: generated, applied: [], orphaned: [] };
  }

  const byName = new Map(withContent.map((region) => [region.name, region]));
  const begin = beginPattern(markers);
  const end = endPattern(markers);

  const lines = generated.split('\n');
  const out: string[] = [];
  const applied: string[] = [];

  let skippingUntilEnd = false;

  for (const line of lines) {
    if (skippingUntilEnd) {
      // Drop whatever the generator put inside the region; the preserved body replaced it.
      if (end.test(line)) {
        out.push(line);
        skippingUntilEnd = false;
      }
      continue;
    }

    out.push(line);

    const beginMatch = begin.exec(line);
    if (beginMatch === null) continue;

    const name = beginMatch[1]!;
    const region = byName.get(name);
    if (region === undefined) continue;

    out.push(region.content);
    applied.push(name);
    byName.delete(name);
    skippingUntilEnd = true;
  }

  return {
    text: out.join('\n'),
    applied,
    // Anything still in the map had content and found no home.
    orphaned: [...byName.values()],
  };
}

// ---------------------------------------------------------------------------
// File-level protection
// ---------------------------------------------------------------------------

/**
 * Compile gitignore-style globs into a matcher.
 *
 * Deliberately a small subset — `*`, `**`, `?`, a trailing `/` for directories, and a leading `!`
 * for negation. Enough for the patterns people actually write about SDK output, and small enough to
 * reason about. A dependency here would be carried by every install of the CLI.
 */
export function compileIgnore(patterns: readonly string[]): (path: string) => boolean {
  const compiled = patterns
    .map((raw) => raw.trim())
    .filter((raw) => raw !== '' && !raw.startsWith('#'))
    .map((raw) => {
      const negated = raw.startsWith('!');
      const body = negated ? raw.slice(1) : raw;
      // A trailing slash means "this directory and everything under it".
      const normalized = body.endsWith('/') ? `${body}**` : body;
      return { negated, regex: globToRegExp(normalized) };
    });

  return (path: string): boolean => {
    let ignored = false;
    // Later patterns win, so a negation can re-include something an earlier pattern matched.
    for (const { negated, regex } of compiled) {
      if (regex.test(path)) ignored = !negated;
    }
    return ignored;
  };
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(char);
  }
  // An unanchored pattern matches at any depth, the way gitignore behaves.
  const anchored = pattern.includes('/') ? `^${source}$` : `^(?:.*/)?${source}$`;
  return new RegExp(anchored);
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

/**
 * Merge a user's additions back into a regenerated `package.json`.
 *
 * Dependencies a user added by hand — or that a preserved region needs — must survive, but the
 * generator still owns the fields it derives from the spec. So generated values win on the keys it
 * manages, and everything else is carried across.
 */
export function mergePackageJson(
  generated: string,
  existing: string | undefined,
): { text: string; carried: string[] } {
  if (existing === undefined) return { text: generated, carried: [] };

  let generatedJson: Record<string, unknown>;
  let existingJson: Record<string, unknown>;
  try {
    generatedJson = JSON.parse(generated) as Record<string, unknown>;
    existingJson = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    // An unparseable existing file is not something to guess about; the generator's version wins
    // and the caller reports it.
    return { text: generated, carried: [] };
  }

  const carried: string[] = [];
  const merged: Record<string, unknown> = { ...generatedJson };

  // Keys graft derives from the spec and config. Everything else belongs to the user.
  const owned = new Set(['name', 'version', 'type', 'main', 'types', 'exports', 'files', 'scripts']);
  for (const [key, value] of Object.entries(existingJson)) {
    if (owned.has(key)) continue;
    if (!(key in merged)) {
      merged[key] = value;
      carried.push(key);
    }
  }

  // Dependency maps are unioned, with the user's pins winning: they chose that version on purpose.
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const mine = generatedJson[field];
    const theirs = existingJson[field];
    if (theirs === undefined || typeof theirs !== 'object' || theirs === null) continue;
    const base = typeof mine === 'object' && mine !== null ? (mine as Record<string, string>) : {};
    const union = { ...base, ...(theirs as Record<string, string>) };
    if (Object.keys(union).length > 0) {
      merged[field] = union;
      for (const name of Object.keys(theirs as Record<string, string>)) {
        if (!(name in base)) carried.push(`${field}.${name}`);
      }
    }
  }

  return { text: `${JSON.stringify(merged, null, 2)}\n`, carried };
}

/**
 * Whether in-file `#region` blocks are carried across regeneration.
 *
 * A named predicate rather than an inline check, because the inline version was the bug: it read
 * `config.preserve?.regions !== true`, making the safe behaviour opt-in. Every target emits region
 * markers unconditionally and labels them as preserved, so the default deleted hand-written code on the
 * next run — reproduced, not theorised (SPEC.md §3.9).
 *
 * Opt-out, therefore, and only an explicit `false` disables it.
 */
export function regionsEnabled(config: {
  preserve?: { regions?: boolean | undefined } | undefined;
}): boolean {
  return config.preserve?.regions !== false;
}
