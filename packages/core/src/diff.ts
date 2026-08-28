/**
 * IR diffing, for `besdk diff` (SPEC.md §9, "versioning / breaking-change policy").
 *
 * **The diff operates on the IR, not on emitted code.** That is the whole design: a change is
 * breaking or not because of what it does to the *contract*, and the IR is the contract. Diffing
 * TypeScript text would need a TypeScript parser in the core — violating §3.7 — and would have to
 * be rewritten for every target. One IR diff covers all of them.
 *
 * The classification that matters most is direction-sensitive, and it is easy to get backwards:
 *
 *   - On a **read** model (data flowing *to* the caller) a field going required → optional is
 *     **breaking**: code that assumed presence must now handle absence.
 *   - On a **write** model (data flowing *from* the caller) it is the opposite — optional →
 *     required is breaking, because callers must now supply it.
 *
 * A `shared` model is used in both directions, so either flip is breaking.
 */

import type { Field, IR, Method, NamedType, Param, Resource, TypeRef } from '@besdk/protocol';

export type ChangeSeverity =
  /** Existing consumer code can stop compiling or start misbehaving. */
  | 'breaking'
  /** New surface only. Existing code is unaffected. */
  | 'additive'
  /** Neither: documentation, ordering, or internal detail. */
  | 'patch';

export interface Change {
  readonly severity: ChangeSeverity;
  /** Dotted path to what changed, e.g. `assets.list` or `Asset.studio`. */
  readonly path: string;
  readonly message: string;
  /** Why it breaks, when that is not obvious from the message. */
  readonly detail?: string;
}

export interface DiffResult {
  readonly changes: readonly Change[];
  readonly breaking: number;
  readonly additive: number;
  readonly patch: number;
}

/** Render a type reference as a stable string, for comparison and for messages. */
export function describeType(ref: TypeRef): string {
  switch (ref.kind) {
    case 'primitive':
      return ref.format === undefined ? ref.type : `${ref.type}<${ref.format}>`;
    case 'unknown':
      return 'unknown';
    case 'null':
      return 'null';
    case 'literal':
      return JSON.stringify(ref.value);
    case 'array':
      return `${describeType(ref.items)}[]`;
    case 'map':
      return `map<${describeType(ref.values)}>`;
    case 'named':
      return ref.id;
    case 'nullable':
      return `${describeType(ref.inner)}?null`;
    case 'binary':
      return 'binary';
    case 'union':
      return ref.variants.map(describeType).join('|');
  }
}

function describeResponse(method: Method): string {
  const response = method.response;
  switch (response.kind) {
    case 'empty':
      return 'void';
    case 'json':
      return describeType(response.type);
    case 'text':
      return 'string';
    case 'binary':
      return 'binary';
    case 'stream':
      return `stream<${describeType(response.event)}>`;
  }
}

function describeMethod(method: Method): string {
  const params = method.http.params
    .map((p) => `${p.wireName}${p.required ? '' : '?'}:${describeType(p.type)}`)
    .sort()
    .join(',');
  const body = method.body === undefined ? '' : describeType(method.body.type);
  return `(${params})${body === '' ? '' : ` body:${body}`} -> ${describeResponse(method)}`;
}

/** Flatten the resource tree into `id → resource`, so nesting changes are visible. */
function flattenResources(resources: readonly Resource[]): Map<string, Resource> {
  const flat = new Map<string, Resource>();
  const walk = (list: readonly Resource[]): void => {
    for (const resource of list) {
      flat.set(resource.id, resource);
      walk(resource.subresources);
    }
  };
  walk(resources);
  return flat;
}

function methodKey(method: Method): string {
  // Keyed on operationId: it survives renames, which is exactly what makes a rename detectable
  // rather than looking like one removal plus one addition.
  return method.operationId;
}

/**
 * Whether a type change breaks consumers, given which direction the data flows.
 *
 * Type changes used to be unconditionally breaking, which is the same mistake required-ness once made:
 * it ignores direction. **Narrowing and widening break opposite sides.**
 *
 * A read field narrowed from `string` to `'member.invited'` breaks nothing — a consumer's
 * `const t: string = event.type` still compiles, because the literal is assignable to the wider type —
 * and it *adds* the ability to switch exhaustively. The same narrowing on a *write* field is breaking,
 * because a caller who passed an arbitrary string is now rejected.
 *
 * Deliberately narrow in what it recognises. Only a primitive-to-literal shift of the same base type is
 * treated as a narrowing; a general assignability analysis over the whole IR is a much larger thing, and
 * guessing wrong here would mislabel a genuinely breaking change as safe. Everything unrecognised stays
 * breaking, which is the conservative direction.
 */
function typeShiftBreaks(
  role: Extract<NamedType, { kind: 'object' }>['role'],
  before: TypeRef,
  after: TypeRef,
): { breaks: boolean; reason: string } {
  const direction = narrowingDirection(before, after);
  if (direction === undefined) {
    return { breaks: true, reason: 'the shape changed' };
  }

  const narrowed = direction === 'narrowed';
  if (role === 'read') {
    return narrowed
      ? { breaks: false, reason: 'still assignable to the old type, and now narrowable' }
      : { breaks: true, reason: 'code that relied on the narrower type must now handle more' };
  }
  if (role === 'create' || role === 'update') {
    return narrowed
      ? { breaks: true, reason: 'values callers used to send are now rejected' }
      : { breaks: false, reason: 'callers may send more than before' };
  }
  // A shared model flows both ways, so either direction breaks one side.
  return {
    breaks: true,
    reason: narrowed
      ? 'writers are now restricted (shared model)'
      : 'readers must now handle more (shared model)',
  };
}

/** Whether `after` is strictly narrower or wider than `before`, when that is decidable. */
function narrowingDirection(before: TypeRef, after: TypeRef): 'narrowed' | 'widened' | undefined {
  const literalBase = (ref: TypeRef): string | undefined =>
    ref.kind === 'literal' ? typeof ref.value : undefined;
  const primitiveName = (ref: TypeRef): string | undefined =>
    ref.kind === 'primitive' ? ref.type : undefined;

  const beforePrimitive = primitiveName(before);
  const afterLiteral = literalBase(after);
  if (beforePrimitive !== undefined && afterLiteral !== undefined) {
    // `string` → `'a'` narrows; `integer` → `'a'` is an unrelated change.
    return matchesBase(beforePrimitive, afterLiteral) ? 'narrowed' : undefined;
  }

  const beforeLiteral = literalBase(before);
  const afterPrimitive = primitiveName(after);
  if (beforeLiteral !== undefined && afterPrimitive !== undefined) {
    return matchesBase(afterPrimitive, beforeLiteral) ? 'widened' : undefined;
  }

  return undefined;
}

function matchesBase(primitive: string, literalType: string): boolean {
  if (primitive === 'string') return literalType === 'string';
  if (primitive === 'integer' || primitive === 'number') return literalType === 'number';
  if (primitive === 'boolean') return literalType === 'boolean';
  return false;
}

function fieldsByWireName(type: NamedType): Map<string, Field> {
  if (type.kind !== 'object') return new Map();
  return new Map(type.fields.map((field) => [field.wireName, field]));
}

/**
 * Whether a required-ness flip breaks consumers, given which direction the data flows.
 */
function requirednessBreaks(
  role: Extract<NamedType, { kind: 'object' }>['role'],
  before: boolean,
  after: boolean,
): { breaks: boolean; reason: string } | undefined {
  if (before === after) return undefined;
  const nowOptional = before && !after;

  if (role === 'create' || role === 'update') {
    return nowOptional
      ? { breaks: false, reason: 'callers may omit it now' }
      : { breaks: true, reason: 'callers must now supply it' };
  }
  if (role === 'read') {
    return nowOptional
      ? { breaks: true, reason: 'code that assumed presence must now handle absence' }
      : { breaks: false, reason: 'the value is now guaranteed' };
  }
  // A shared model flows both ways, so either direction breaks one side.
  return {
    breaks: true,
    reason: nowOptional
      ? 'readers must now handle absence (shared model)'
      : 'writers must now supply it (shared model)',
  };
}

function diffParams(
  path: string,
  before: readonly Param[],
  after: readonly Param[],
  changes: Change[],
): void {
  const beforeByName = new Map(before.map((p) => [`${p.location}:${p.wireName}`, p]));
  const afterByName = new Map(after.map((p) => [`${p.location}:${p.wireName}`, p]));

  for (const [key, param] of beforeByName) {
    if (!afterByName.has(key)) {
      changes.push({
        severity: 'breaking',
        path: `${path}(${param.wireName})`,
        message: `parameter \`${param.wireName}\` removed`,
        detail: 'callers passing it will no longer compile',
      });
    }
  }
  for (const [key, param] of afterByName) {
    const existing = beforeByName.get(key);
    if (existing === undefined) {
      changes.push({
        severity: param.required ? 'breaking' : 'additive',
        path: `${path}(${param.wireName})`,
        message: `parameter \`${param.wireName}\` added${param.required ? ' as required' : ''}`,
        ...(param.required ? { detail: 'every existing call site must be updated' } : {}),
      });
      continue;
    }
    if (existing.required !== param.required) {
      // A parameter flows from caller to server, so requiring it is the breaking direction.
      changes.push({
        severity: param.required ? 'breaking' : 'additive',
        path: `${path}(${param.wireName})`,
        message: `parameter \`${param.wireName}\` is now ${param.required ? 'required' : 'optional'}`,
      });
    }
    if (describeType(existing.type) !== describeType(param.type)) {
      changes.push({
        severity: 'breaking',
        path: `${path}(${param.wireName})`,
        message: `parameter \`${param.wireName}\` changed type`,
        detail: `${describeType(existing.type)} → ${describeType(param.type)}`,
      });
    }
  }
}

function diffMethods(resourceId: string, before: Resource, after: Resource, changes: Change[]): void {
  const beforeMethods = new Map(before.methods.map((m) => [methodKey(m), m]));
  const afterMethods = new Map(after.methods.map((m) => [methodKey(m), m]));

  for (const [key, method] of beforeMethods) {
    if (!afterMethods.has(key)) {
      changes.push({
        severity: 'breaking',
        path: `${resourceId}.${method.name.tokens.join('-')}`,
        message: 'method removed',
        detail: `operationId \`${key}\` is gone`,
      });
    }
  }

  for (const [key, method] of afterMethods) {
    const existing = beforeMethods.get(key);
    const path = `${resourceId}.${method.name.tokens.join('-')}`;
    if (existing === undefined) {
      changes.push({ severity: 'additive', path, message: 'method added' });
      continue;
    }

    const beforeName = existing.name.tokens.join('-');
    const afterName = method.name.tokens.join('-');
    if (beforeName !== afterName) {
      changes.push({
        severity: 'breaking',
        path: `${resourceId}.${beforeName}`,
        message: `method renamed to \`${afterName}\``,
        detail: 'existing call sites break',
      });
    }

    diffParams(path, existing.http.params, method.http.params, changes);

    if (describeResponse(existing) !== describeResponse(method)) {
      changes.push({
        severity: 'breaking',
        path,
        message: 'return type changed',
        detail: `${describeResponse(existing)} → ${describeResponse(method)}`,
      });
    }

    const beforeBody = existing.body === undefined ? undefined : describeType(existing.body.type);
    const afterBody = method.body === undefined ? undefined : describeType(method.body.type);
    if (beforeBody !== afterBody) {
      changes.push({
        severity: 'breaking',
        path,
        message: 'request body changed',
        detail: `${beforeBody ?? 'none'} → ${afterBody ?? 'none'}`,
      });
    }

    // Gaining or losing pagination changes the return type from a promise to an iterator.
    if ((existing.paginationId === undefined) !== (method.paginationId === undefined)) {
      changes.push({
        severity: 'breaking',
        path,
        message:
          method.paginationId === undefined
            ? 'no longer paginated'
            : 'is now paginated, so it returns an iterator rather than a single page',
      });
    }

    if (!existing.deprecated && method.deprecated) {
      changes.push({ severity: 'patch', path, message: 'marked deprecated' });
    }
  }
}

function diffTypes(before: IR, after: IR, changes: Change[]): void {
  const beforeTypes = new Map(before.types.map((t) => [t.id, t]));
  const afterTypes = new Map(after.types.map((t) => [t.id, t]));

  for (const [id] of beforeTypes) {
    if (!afterTypes.has(id)) {
      changes.push({
        severity: 'breaking',
        path: id,
        message: 'type removed',
        detail: 'any consumer importing it will no longer compile',
      });
    }
  }

  for (const [id, type] of afterTypes) {
    const existing = beforeTypes.get(id);
    if (existing === undefined) {
      changes.push({ severity: 'additive', path: id, message: 'type added' });
      continue;
    }

    if (existing.kind !== type.kind) {
      changes.push({
        severity: 'breaking',
        path: id,
        message: `changed from ${existing.kind} to ${type.kind}`,
      });
      continue;
    }

    if (type.kind === 'enum' && existing.kind === 'enum') {
      const beforeValues = new Set(existing.members.map((m) => String(m.wireValue)));
      const afterValues = new Set(type.members.map((m) => String(m.wireValue)));
      for (const value of beforeValues) {
        if (!afterValues.has(value)) {
          changes.push({
            severity: 'breaking',
            path: `${id}.${value}`,
            message: 'enum value removed',
          });
        }
      }
      for (const value of afterValues) {
        if (!beforeValues.has(value)) {
          changes.push({ severity: 'additive', path: `${id}.${value}`, message: 'enum value added' });
        }
      }
      continue;
    }

    if (type.kind === 'alias' && existing.kind === 'alias') {
      if (describeType(existing.target) !== describeType(type.target)) {
        changes.push({
          severity: 'breaking',
          path: id,
          message: 'alias target changed',
          detail: `${describeType(existing.target)} → ${describeType(type.target)}`,
        });
      }
      continue;
    }

    if (type.kind !== 'object' || existing.kind !== 'object') continue;

    const beforeFields = fieldsByWireName(existing);
    const afterFields = fieldsByWireName(type);

    for (const [wireName] of beforeFields) {
      if (!afterFields.has(wireName)) {
        changes.push({
          severity: 'breaking',
          path: `${id}.${wireName}`,
          message: 'field removed',
        });
      }
    }

    for (const [wireName, field] of afterFields) {
      const existingField = beforeFields.get(wireName);
      if (existingField === undefined) {
        // Adding a required field to a write model forces every caller to supply it.
        const breaks = field.required && (type.role === 'create' || type.role === 'update' || type.role === 'shared');
        changes.push({
          severity: breaks ? 'breaking' : 'additive',
          path: `${id}.${wireName}`,
          message: `field added${field.required ? ' as required' : ''}`,
          ...(breaks ? { detail: 'callers constructing this value must be updated' } : {}),
        });
        continue;
      }

      const flip = requirednessBreaks(type.role, existingField.required, field.required);
      if (flip !== undefined) {
        changes.push({
          severity: flip.breaks ? 'breaking' : 'additive',
          path: `${id}.${wireName}`,
          message: `now ${field.required ? 'required' : 'optional'}`,
          detail: flip.reason,
        });
      }

      if (describeType(existingField.type) !== describeType(field.type)) {
        const shift = typeShiftBreaks(type.role, existingField.type, field.type);
        changes.push({
          severity: shift.breaks ? 'breaking' : 'additive',
          path: `${id}.${wireName}`,
          message: 'field changed type',
          detail: `${describeType(existingField.type)} → ${describeType(field.type)}: ${shift.reason}`,
        });
      }

      if (!existingField.deprecated && field.deprecated) {
        changes.push({ severity: 'patch', path: `${id}.${wireName}`, message: 'marked deprecated' });
      }
    }
  }
}

function diffService(before: IR, after: IR, changes: Change[]): void {
  // The service name becomes the exported client class name, so renaming it breaks every import
  // in every consumer. Omitting this check let a rename pass `diff --strict` silently while the
  // repo's own conformance tests stopped compiling.
  const beforeName = before.service.displayName ?? before.service.name.tokens.join(' ');
  const afterName = after.service.displayName ?? after.service.name.tokens.join(' ');
  if (beforeName !== afterName) {
    changes.push({
      severity: 'breaking',
      path: 'service.name',
      message: `renamed from \`${beforeName}\` to \`${afterName}\``,
      detail: 'the exported client class is renamed, so every `import { … }` breaks',
    });
  }

  if (before.service.version !== after.service.version) {
    changes.push({
      severity: 'patch',
      path: 'service',
      message: `version ${before.service.version} → ${after.service.version}`,
    });
  }

  const beforeAuth = new Set(before.service.auth.map((a) => a.kind));
  const afterAuth = new Set(after.service.auth.map((a) => a.kind));
  for (const kind of beforeAuth) {
    if (!afterAuth.has(kind)) {
      changes.push({
        severity: 'breaking',
        path: 'service.auth',
        message: `\`${kind}\` authentication removed`,
        detail: 'clients constructed with those credentials stop working',
      });
    }
  }
  for (const kind of afterAuth) {
    if (!beforeAuth.has(kind)) {
      changes.push({ severity: 'additive', path: 'service.auth', message: `\`${kind}\` authentication added` });
    }
  }

  const beforeDefault = before.service.servers.find((s) => s.default)?.url;
  const afterDefault = after.service.servers.find((s) => s.default)?.url;
  if (beforeDefault !== afterDefault) {
    // Not a compile break, but it silently redirects every request — worth flagging loudly.
    changes.push({
      severity: 'breaking',
      path: 'service.baseURL',
      message: 'default server changed',
      detail: `${beforeDefault ?? 'none'} → ${afterDefault ?? 'none'}; existing clients will call a different host`,
    });
  }
}

export function diffIR(before: IR, after: IR): DiffResult {
  const changes: Change[] = [];

  diffService(before, after, changes);

  const beforeResources = flattenResources(before.resources);
  const afterResources = flattenResources(after.resources);

  for (const [id] of beforeResources) {
    if (!afterResources.has(id)) {
      changes.push({
        severity: 'breaking',
        path: id,
        message: 'resource removed',
        detail: 'the accessor and every method on it are gone',
      });
    }
  }
  for (const [id, resource] of afterResources) {
    const existing = beforeResources.get(id);
    if (existing === undefined) {
      changes.push({ severity: 'additive', path: id, message: 'resource added' });
      continue;
    }
    diffMethods(id, existing, resource, changes);
  }

  diffTypes(before, after, changes);

  const order: Record<ChangeSeverity, number> = { breaking: 0, additive: 1, patch: 2 };
  changes.sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path));

  return {
    changes,
    breaking: changes.filter((c) => c.severity === 'breaking').length,
    additive: changes.filter((c) => c.severity === 'additive').length,
    patch: changes.filter((c) => c.severity === 'patch').length,
  };
}

/** Semver bump the change set implies. */
export function impliedBump(result: DiffResult): 'major' | 'minor' | 'patch' | 'none' {
  if (result.breaking > 0) return 'major';
  if (result.additive > 0) return 'minor';
  if (result.patch > 0) return 'patch';
  return 'none';
}
