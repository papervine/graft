/**
 * Name tokenization.
 *
 * The IR stores identifiers as ordered lowercase word tokens so each target can apply its own
 * convention (SPEC.md §3.2). This module is where wire names become tokens, and it is
 * foundational: every identifier in every generated SDK passes through here, so a bad split
 * shows up as awkward naming in all of them at once.
 *
 * Casing is applied by targets, never here.
 */

/** Initialisms that should survive as single tokens rather than being split per letter. */
const KNOWN_INITIALISMS = new Set([
  'id', 'url', 'uri', 'api', 'http', 'https', 'html', 'xml', 'json', 'jwt', 'sdk', 'ui', 'db',
  'ip', 'ttl', 'sms', 'mfa', 'sso', 'csv', 'pdf', 'png', 'jpeg', 'gif', 'svg', 'mp4', 'dcp',
  'ok', 'io', 'os', 'cpu', 'gpu', 'ram', 'ssl', 'tls', 'dns', 'cdn', 'acl', 'crud', 'uuid',
]);

/**
 * Vocabulary for splitting all-lowercase compound words.
 *
 * Specs frequently name a resource `assettypes` or `workrequests` — no case boundary, so
 * tokenization alone yields `Assettypes`, which reads as machine output. Splitting needs a
 * vocabulary; there is no way to infer word boundaries from `assettypes` otherwise.
 *
 * Curated rather than exhaustive, and deliberately conservative: a *wrong* split is worse than
 * no split, because it produces a confidently misspelled public identifier. Extend via
 * `naming.words` in `besdk.yaml` rather than guessing here.
 */
export const DEFAULT_COMPOUND_WORDS: readonly string[] = [
  // Generic API nouns
  'access', 'account', 'action', 'address', 'admin', 'api', 'asset', 'attribute', 'audit',
  'batch', 'billing', 'branch', 'bucket', 'build', 'cache', 'call', 'card', 'cart', 'category',
  'change', 'channel', 'chart', 'check', 'client', 'code', 'comment', 'commit', 'config',
  'contact', 'content', 'count', 'coupon', 'credit', 'customer', 'data', 'date', 'delivery',
  'detail', 'device', 'discount', 'document', 'domain', 'download', 'email', 'encode', 'entry',
  'error', 'event', 'export', 'feature', 'feed', 'field', 'file', 'filter', 'folder', 'form',
  'group', 'history', 'hook', 'host', 'image', 'import', 'info', 'ingest', 'invite', 'invoice',
  'item', 'job', 'key', 'label', 'language', 'layout', 'level', 'limit', 'line', 'link', 'list',
  'local', 'location', 'log', 'mail', 'market', 'master', 'media', 'member', 'message', 'meta',
  'method', 'metric', 'model', 'module', 'name', 'note', 'notification', 'number', 'object',
  'offline', 'option', 'order', 'organization', 'output', 'owner', 'package', 'page', 'param',
  'parent', 'password', 'payment', 'permission', 'person', 'phase', 'phone', 'photo', 'plan',
  'playlist', 'plugin', 'policy', 'pool', 'port', 'preview', 'price', 'product', 'profile',
  'project', 'property', 'provider', 'query', 'queue', 'quote', 'rate', 'record', 'refund',
  'region', 'reply', 'report', 'request', 'resource', 'response', 'result', 'role', 'route',
  'rule', 'schedule', 'schema', 'scope', 'search', 'secret', 'section', 'segment', 'series',
  'server', 'service', 'session', 'setting', 'share', 'shipping', 'site', 'size', 'slot',
  'source', 'space', 'state', 'status', 'step', 'stream', 'string', 'studio', 'subscription',
  'sync', 'tag', 'target', 'task', 'team', 'template', 'territory', 'test', 'text', 'theme',
  'thread', 'ticket', 'time', 'token', 'topic', 'track', 'transaction', 'transfer',
  'translation', 'type', 'unit', 'upload', 'usage', 'user', 'value', 'variant', 'version',
  'video', 'view', 'webhook', 'work', 'workflow', 'workspace', 'zone',
];

/** Does `candidate` appear in the vocabulary, allowing regular plural forms? */
function isVocabularyWord(candidate: string, vocabulary: ReadonlySet<string>): boolean {
  if (vocabulary.has(candidate)) return true;
  if (candidate.endsWith('ies') && vocabulary.has(`${candidate.slice(0, -3)}y`)) return true;
  if (candidate.endsWith('es') && vocabulary.has(candidate.slice(0, -2))) return true;
  if (candidate.endsWith('s') && vocabulary.has(candidate.slice(0, -1))) return true;
  return false;
}

/**
 * Split an all-lowercase compound into words, or return it unchanged.
 *
 * Guards against over-eager splitting:
 *   - tokens shorter than 6 characters are left alone, so `ass` (a subtitle format) survives;
 *   - a token that is itself a vocabulary word is never split, so `translations` stays whole;
 *   - every segment must be at least 3 characters and in the vocabulary;
 *   - the fewest-segment split wins, so `workrequests` prefers `work|requests`.
 */
export function splitCompound(token: string, vocabulary: ReadonlySet<string>): string[] {
  if (token.length < 6) return [token];
  if (isVocabularyWord(token, vocabulary)) return [token];

  const length = token.length;
  // best.get(i) = fewest-segment split of token.slice(0, i). Absent means unsplittable.
  const best = new Map<number, string[]>([[0, []]]);

  for (let end = 1; end <= length; end++) {
    for (let start = 0; start < end; start++) {
      const prefix = best.get(start);
      if (prefix === undefined) continue;
      const segment = token.slice(start, end);
      if (segment.length < 3) continue;
      if (!isVocabularyWord(segment, vocabulary)) continue;
      const candidate = [...prefix, segment];
      const existing = best.get(end);
      if (existing === undefined || candidate.length < existing.length) best.set(end, candidate);
    }
  }

  const split = best.get(length);
  return split !== undefined && split.length >= 2 ? split : [token];
}

/**
 * Reduce a plural token to its singular form.
 *
 * Used for array element type names: the items of a `replies` array are each a `Reply`, and
 * `RepliesItem` is the kind of name that marks output as generated.
 */
/**
 * Words that are already singular despite ending in `s`.
 *
 * Mass nouns and invariant plurals. `graphics` is the motivating case: stripping the `s` gives
 * `GraphicComment` where `GraphicsComment` is what the API means — "graphics" names a thing, it
 * is not a count of graphics.
 */
const INVARIANT_NOUNS = new Set([
  'graphics', 'news', 'series', 'species', 'physics', 'mathematics', 'statistics', 'analytics',
  'economics', 'politics', 'ethics', 'means', 'headquarters', 'works', 'lens', 'bonus', 'campus',
  'census', 'corpus', 'gas', 'plus', 'virus', 'alias', 'atlas', 'canvas', 'chaos', 'bias',
  'bus', 'status', 'address', 'class', 'process', 'access',
]);

export function singularize(token: string, vocabulary?: ReadonlySet<string>): string {
  if (token.length <= 3) return token;
  if (INVARIANT_NOUNS.has(token)) return token;

  // The vocabulary settles cases regex cannot. English gives no way to tell `studios` (plural
  // of `studio`) from `status` (singular) by shape alone, and guessing wrong is very visible:
  // `Studios` as a single-item type name, or `statu` as a field type.
  if (vocabulary !== undefined) {
    if (vocabulary.has(token)) return token;
    if (token.endsWith('ies') && vocabulary.has(`${token.slice(0, -3)}y`)) {
      return `${token.slice(0, -3)}y`;
    }
    if (token.endsWith('es') && vocabulary.has(token.slice(0, -2))) return token.slice(0, -2);
    if (token.endsWith('s') && vocabulary.has(token.slice(0, -1))) return token.slice(0, -1);
  }

  // `aliases` → `alias`, `buses` → `bus`: the stem itself ends in `s`, so the plural suffix is
  // the whole `es`. Without this, stripping a bare `s` yields `aliase`.
  if (token.endsWith('es') && INVARIANT_NOUNS.has(token.slice(0, -2))) return token.slice(0, -2);

  // Words whose trailing `s` belongs to the stem. Only endings where that is reliably true:
  // an earlier `os$` entry here wrongly protected `studios`.
  if (/(ss|us|is)$/.test(token)) return token;
  if (/ies$/.test(token)) return `${token.slice(0, -3)}y`;
  // `es` is only a plural suffix after a sibilant or `ss`. Including a bare `s` turned `phases`
  // into `phas` and `houses` into `hous`.
  if (/(ch|sh|x|z|ss)es$/.test(token)) return token.slice(0, -2);
  if (/s$/.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * Trailing comparison operators used in query-parameter names.
 *
 * Twilio spells inequality filters `StartTime<` and `StartTime>`. Stripping the operator as
 * punctuation collapses all three variants onto `startTime`, producing duplicate identifiers — so
 * the operator is translated into the word it means. `startTimeBefore` also reads better than any
 * numeric suffix a collision resolver could invent.
 */
const COMPARISON_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ['<=', 'orBefore'],
  ['>=', 'orAfter'],
  ['<', 'before'],
  ['>', 'after'],
  ['!=', 'not'],
];

/** Translate a trailing comparison operator into words, leaving other names untouched. */
export function expandComparisonSuffix(raw: string): string {
  for (const [operator, word] of COMPARISON_SUFFIXES) {
    if (raw.endsWith(operator)) {
      return `${raw.slice(0, -operator.length)} ${word}`;
    }
  }
  return raw;
}

/**
 * Split an identifier into lowercase word tokens.
 *
 * Handles the shapes real specs actually contain:
 *   `_id` → `[id]`                     leading separators dropped
 *   `userId` → `[user, id]`            camelCase
 *   `user_id` → `[user, id]`           snake_case
 *   `X-Content-Range` → `[x, content, range]`   header style
 *   `AssetsResponse` → `[assets, response]`     PascalCase
 *   `HTTPResponse` → `[http, response]`         consecutive capitals
 *   `oauth2Token` → `[oauth2, token]`           trailing digits stay attached
 *   `ass` → `[ass]`                    left alone; see SPEC.md §3.1.2
 */
export function tokenize(raw: string, vocabulary?: ReadonlySet<string>): string[] {
  if (raw === '') return [];
  raw = expandComparisonSuffix(raw);

  // Split on any non-alphanumeric run first: handles snake_case, kebab-case, dots, spaces.
  const chunks = raw.split(/[^A-Za-z0-9]+/).filter((chunk) => chunk !== '');
  const tokens: string[] = [];

  for (const chunk of chunks) {
    // Within a chunk, split camelCase and PascalCase, keeping consecutive capitals together:
    //   "HTTPResponse" → ["HTTP", "Response"], "userId" → ["user", "Id"]
    const parts = chunk
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // HTTPResponse → HTTP|Response
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // userId → user|Id
      .split(' ')
      .filter((part) => part !== '');
    for (const part of parts) {
      const lowered = part.toLowerCase();
      // A compound can only hide where there is no *internal* case boundary to find. That
      // covers `assettypes` and `Assettypes` alike — a leading capital is just a sentence-case
      // word, not a word boundary. `AssetTypes` was already split by the case pass above.
      const hasInternalCase = part.slice(1) !== part.slice(1).toLowerCase();
      if (vocabulary !== undefined && !hasInternalCase) {
        tokens.push(...splitCompound(lowered, vocabulary));
      } else {
        tokens.push(lowered);
      }
    }
  }

  return tokens;
}

/** Tokenize, dropping tokens that carry no meaning in a generated name. */
export function tokenizeName(
  raw: string,
  drop: readonly string[] = [],
  vocabulary?: ReadonlySet<string>,
): string[] {
  const dropped = new Set(drop.map((d) => d.toLowerCase()));
  const tokens = tokenize(raw, vocabulary).filter((token) => !dropped.has(token));
  return tokens.length > 0 ? tokens : tokenize(raw, vocabulary);
}

// ---------------------------------------------------------------------------
// Casing — used by targets, and by the core only for diagnostics
// ---------------------------------------------------------------------------

function capitalize(token: string): string {
  return token.length === 0 ? token : token[0]!.toUpperCase() + token.slice(1);
}

/**
 * `[user, id]` → `userId`.
 *
 * Initialisms stay uppercase only in Pascal/Go style, not here: idiomatic TypeScript writes
 * `userId` and `apiUrl`, not `userID` or `apiURL`.
 */
export function camelCase(tokens: readonly string[]): string {
  if (tokens.length === 0) return '';
  return [tokens[0]!.toLowerCase(), ...tokens.slice(1).map(capitalize)].join('');
}

/** `[assets, response]` → `AssetsResponse`. */
export function pascalCase(tokens: readonly string[]): string {
  return tokens.map(capitalize).join('');
}

/** `[user, id]` → `user_id`. */
export function snakeCase(tokens: readonly string[]): string {
  return tokens.map((t) => t.toLowerCase()).join('_');
}

/** `[user, id]` → `USER_ID`. */
export function screamingSnakeCase(tokens: readonly string[]): string {
  return tokens.map((t) => t.toUpperCase()).join('_');
}

/** `[user, id]` → `user-id`. */
export function kebabCase(tokens: readonly string[]): string {
  return tokens.map((t) => t.toLowerCase()).join('-');
}

/** `[user, id]` → `UserID`, uppercasing recognized initialisms. Go convention. */
export function goExportedCase(tokens: readonly string[]): string {
  return tokens.map((t) => (KNOWN_INITIALISMS.has(t) ? t.toUpperCase() : capitalize(t))).join('');
}

// ---------------------------------------------------------------------------
// Identifier safety
// ---------------------------------------------------------------------------

/**
 * TypeScript reserved words plus identifiers that shadow globals a generated SDK relies on.
 * A property named `constructor` or `__proto__` is a genuine hazard, not a style question.
 */
const TS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'as', 'implements', 'interface', 'let',
  'package', 'private', 'protected', 'public', 'static', 'yield', 'any', 'boolean', 'constructor',
  'declare', 'get', 'module', 'require', 'number', 'set', 'string', 'symbol', 'type', 'from',
  'of', 'await', 'async', 'never', 'unknown', 'object', 'bigint',
]);

export function isTypeScriptReserved(identifier: string): boolean {
  return TS_RESERVED.has(identifier);
}

/**
 * Whether a string is a valid JS identifier, i.e. can be written as `obj.name` and as an
 * unquoted object key. Anything else must be quoted and bracket-accessed.
 */
export function isSafeIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
