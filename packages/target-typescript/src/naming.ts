/**
 * Casing for TypeScript.
 *
 * Deliberately duplicated rather than imported from `@graft/core`: a target must not depend on
 * the core (SPEC.md §3.5), and casing is precisely the decision each target owns. The IR hands
 * over token sequences; turning `["user","id"]` into `userId` is this file's job and nobody
 * else's.
 */

import type { IR, Name } from '@graft/protocol';

function capitalize(token: string): string {
  return token.length === 0 ? token : token[0]!.toUpperCase() + token.slice(1);
}

/** `["user","id"]` → `userId`. Idiomatic TS writes `userId`, never `userID`. */
export function camel(name: Name | readonly string[]): string {
  const tokens = Array.isArray(name) ? name : (name as Name).tokens;
  if (tokens.length === 0) return '_';
  return [tokens[0]!.toLowerCase(), ...tokens.slice(1).map(capitalize)].join('');
}

/** `["assets","response"]` → `AssetsResponse`. */
export function pascal(name: Name | readonly string[]): string {
  const tokens = Array.isArray(name) ? name : (name as Name).tokens;
  if (tokens.length === 0) return '_';
  return tokens.map(capitalize).join('');
}

/**
 * Words that cannot be used as a *binding* name — a variable, parameter, or import.
 *
 * Deliberately narrower than "TypeScript keywords": ES5 onward allows every reserved word as a
 * member name, so `client.assets.delete(id)` and `.get(id)` are legal and are what every
 * mainstream SDK writes. Suffixing those to `delete_`/`get_` would be a self-inflicted wound —
 * see {@link safeMemberName}.
 */
const RESERVED_BINDINGS = new Set([
  'break','case','catch','class','const','continue','debugger','default','do','else',
  'enum','export','extends','false','finally','for','function','if','import','in','instanceof',
  'new','null','return','super','switch','this','throw','true','try','typeof','var','void',
  'while','with','let','static','yield','await','async','implements','interface','package',
  'private','protected','public','delete',
]);

/** Make an identifier safe to use as a variable, parameter, or import binding. */
export function safeIdentifier(base: string): string {
  if (base === '') return '_';
  const cleaned = /^[A-Za-z_$]/.test(base) ? base : `_${base}`;
  return RESERVED_BINDINGS.has(cleaned) ? `${cleaned}_` : cleaned;
}

/**
 * Make an identifier safe to use as a class member or property name.
 *
 * Reserved words are legal here, so this only guards against characters that are not valid in
 * an identifier at all. Keeping `get`, `set`, and `delete` intact is the difference between
 * `client.assets.delete(id)` and the tell-tale generated `client.assets.delete_(id)`.
 */
export function safeMemberName(base: string): string {
  if (base === '') return '_';
  return /^[A-Za-z_$]/.test(base) ? base : `_${base}`;
}

/** Whether a property key can be written unquoted. */
export function isSafeKey(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

/** Quote a property key only when it needs it. */
export function propertyKey(wireName: string): string {
  return isSafeKey(wireName) ? wireName : JSON.stringify(wireName);
}

/**
 * The service name as prose, for a README line or a file header.
 *
 * `displayName` first, because it carries the author's own casing — `OpenAI`, `IBM Cloud`, `Widget Co`.
 * `name.tokens` is lowercase by contract, so joining it produced "TypeScript SDK for widget co", which
 * is the one place a reader forms an impression of whether this output was written by a person.
 */
export function serviceLabel(ir: IR): string {
  const display = ir.service.displayName?.trim();
  return display !== undefined && display !== '' ? display : ir.service.name.tokens.join(' ');
}
