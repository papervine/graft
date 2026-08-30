/**
 * The TypeScript emitter.
 *
 * Uses ts-morph rather than string templates (AGENTS.md "Quality bar"): the structure-based API
 * manages imports, keeps declarations well-formed, and lets the printer decide layout. String
 * concatenation is what makes generated code read dead.
 *
 * The shape produced here is modelled on hand-written SDKs people like:
 *
 *   const client = new Pixwel({ token })
 *   const asset  = await client.assets.create({ studio, project })   // no _id
 *   for await (const asset of client.assets.list({ limit: 50 })) { … }
 *
 * Path parameters are positional, the body is next, and `options` is always last — the ordering
 * every mainstream TypeScript SDK uses, so it needs no learning.
 */

import {
  ModuleKind,
  Project,
  Scope,
  ScriptTarget,
  StructureKind,
  VariableDeclarationKind,
  type ImportDeclarationStructure,
  type SourceFile,
  type StatementStructures,
} from 'ts-morph';
import { attribution, BRAND } from '@graft/protocol';
import type {
  Brand,
  Docs,
  Field,
  IR,
  Method,
  NamedType,
  Param,
  Resource,
  Server,
  TypeRef,
  GeneratedFile,
} from '@graft/protocol';
import { TypeMapper } from './types.js';
import { camel, pascal, propertyKey, safeIdentifier, safeMemberName, serviceLabel } from './naming.js';
import { computeOwnership, type Ownership } from './ownership.js';
import {
  renderApiReference,
  renderExamples,
  renderOperationExamples,
  renderOperationTests,
  renderReadme,
  type DocsContext,
} from './docs.js';
import { planSchemas, renderDescriptor, type SchemaPlan } from './schemas.js';

export interface EmitOptions {
  readonly packageName?: string;
  readonly runtimeFiles: ReadonlyMap<string, string>;
  /**
   * Default response-validation mode baked into the generated client.
   *
   * Declared here rather than read off a loose record, so forgetting to forward it from the protocol
   * entry point is a compile error rather than a silently-ignored config key — which is exactly what
   * happened the first time.
   */
  readonly validation?: 'strict' | 'warn' | 'off';
  /**
   * The SDK's own version, recorded by `graft release`.
   *
   * Distinct from `ir.service.version`, which is the *API's* version — Stripe's is
   * `2026-07-29.dahlia`, which no package manager accepts (SPEC.md §3.5.1).
   */
  readonly sdkVersion?: string;
  /** Header an idempotency key is sent in, when the API does not use the default. */
  readonly idempotencyHeader?: string;
  /**
   * The project's own name and the strings derived from it, from `TargetInput.brand`.
   *
   * Taken from the protocol rather than imported from `@graft/protocol`, even though this target
   * *can* import it. A field only the non-TypeScript targets read is a field that rots, and the
   * blessed target exercising the protocol it ships is the same argument as it running as a
   * subprocess (SPEC.md §3.7).
   */
  readonly brand: Brand;
}

/** Wrap prose as a JSDoc comment, collapsing the whitespace specs are careless with. */
function docComment(docs: Docs, extra: readonly string[] = []): string | undefined {
  const lines: string[] = [];
  const summary = docs.summary?.trim();
  const description = docs.description?.trim();
  if (summary !== undefined && summary !== '') lines.push(collapse(summary));
  if (description !== undefined && description !== '' && description !== summary) {
    if (lines.length > 0) lines.push('');
    lines.push(collapse(description));
  }
  if (extra.length > 0) {
    // One blank line before the block, then the block verbatim: blank lines between every
    // entry would break up a fenced @example into disconnected fragments.
    if (lines.length > 0) lines.push('');
    lines.push(...extra);
  }
  return lines.length === 0 ? undefined : lines.join('\n');
}

/**
 * Make prose safe to place inside a JSDoc block.
 *
 * A comment-close sequence — star followed by slash — inside a description terminates the comment
 * and injects a syntax error into the emitted file. Two GitHub descriptions contain one, and
 * generation failed with a ts-morph "a syntax error was inserted" that pointed at the property
 * rather than at the prose. It is escaped by inserting a backslash between the two characters,
 * which renders identically in an editor and is the conventional fix.
 *
 * (This very comment cannot contain the literal sequence, for the same reason.)
 *
 * Control characters are stripped on the same principle: invisible in a diff, and able to break the
 * emitted file in ways that are very hard to trace back to a spec.
 */
function collapse(text: string): string {
  return text
    .replace(/\*\//g, '*\\/')
    // eslint-disable-next-line no-control-regex -- deliberately targeting control characters
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Ensure one blank line between the import block and the declaration after it.
 *
 * ts-morph's writer inserts that blank line before an interface or a class but not before a type
 * alias, an export, or a raw comment — so on a first pass 49 of Stripe's 76 resource files lost
 * theirs, every one of them a file that happened to declare a type alias first.
 *
 * Measured from the emitted text rather than predicted from the statement kind. A table of "these
 * kinds get a blank line, those do not" would encode a detail of ts-morph's writer that nothing in
 * this repository tests, and it would drift on upgrade; asking the file where its declarations
 * actually landed cannot drift.
 */
function separateImportBlock(file: SourceFile): void {
  const lastImport = file.getImportDeclarations().at(-1);
  if (lastImport === undefined) return;
  const next = lastImport.getNextSibling();
  if (next === undefined) return;
  // `true` counts a JSDoc block as part of the declaration's start, which is what a reader sees.
  if (next.getStartLineNumber(true) > lastImport.getEndLineNumber() + 1) return;
  next.prependWhitespace('\n');
}

export class TypeScriptEmitter {
  private readonly project: Project;
  private readonly types: TypeMapper;
  private readonly clientName: string;
  /** Which file each generated type lives in. */
  private readonly ownership: Ownership;
  /** Runtime validation descriptors, keyed by emitted type name (SPEC.md §3.4.1.1). */
  private readonly schemas: SchemaPlan;
  /**
   * The generated client's default validation mode.
   *
   * `strict` unless the config says otherwise; see SPEC.md §3.4.1.1 for why that is the default even
   * though it is the stricter choice.
   */
  private readonly validationDefault: 'strict' | 'warn' | 'off';

  constructor(
    private readonly ir: IR,
    private readonly options: EmitOptions,
  ) {
    this.project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: ScriptTarget.ES2022,
        module: ModuleKind.NodeNext,
        strict: true,
        declaration: true,
      },
    });
    this.types = new TypeMapper(ir);
    this.clientName = resolveClientName(ir);
    this.ownership = computeOwnership(ir);
    // Planned once: the table is shared by every resource module, and building it per-file would
    // both duplicate work and risk two files disagreeing about a type's descriptor.
    this.validationDefault = options.validation ?? 'strict';
    this.schemas = planSchemas(ir, (typeId) => {
      const type = ir.types.find((candidate) => candidate.id === typeId);
      return type === undefined ? typeId : this.types.declaredName(type);
    });
  }

  /** Depth-first list of every resource in the tree, parents before children. */
  private get allResources(): Resource[] {
    const flat: Resource[] = [];
    const walk = (resources: readonly Resource[]): void => {
      for (const resource of resources) {
        flat.push(resource);
        walk(resource.subresources);
      }
    };
    walk(this.ir.resources);
    return flat;
  }

  /**
   * Resource id → the accumulated name tokens from the root down to it.
   *
   * Built from `name.tokens`, never from the dotted id: the id holds the raw group name from the
   * spec, so deriving a scope from it loses compound splitting and turns `AssetTypesListParams`
   * back into `AssettypesListParams`.
   */
  private get resourceScopes(): Map<string, string[]> {
    if (this.resourceScopeCache !== undefined) return this.resourceScopeCache;
    const scopes = new Map<string, string[]>();
    const walk = (resources: readonly Resource[], prefix: readonly string[]): void => {
      for (const resource of resources) {
        const tokens = [...prefix, ...resource.name.tokens];
        scopes.set(resource.id, tokens);
        walk(resource.subresources, tokens);
      }
    };
    walk(this.ir.resources, []);
    this.resourceScopeCache = scopes;
    return scopes;
  }
  private resourceScopeCache: Map<string, string[]> | undefined;

  /** Error classes the hand-written runtime already provides. */
  private static readonly RUNTIME_ERRORS = new Set([
    'BadRequestError',
    'AuthenticationError',
    'PermissionDeniedError',
    'NotFoundError',
    'ConflictError',
    'UnprocessableEntityError',
    'RateLimitError',
    'InternalServerError',
  ]);

  /** Declared statuses with no runtime class, in status order. */
  private get generatedErrors(): Array<{ name: string; statusCode: number }> {
    const seen = new Set<string>();
    return this.ir.errors.byStatus
      .map((entry) => ({ name: pascal(entry.name), statusCode: entry.statusCode }))
      .filter((entry) => {
        if (TypeScriptEmitter.RUNTIME_ERRORS.has(entry.name) || seen.has(entry.name)) return false;
        seen.add(entry.name);
        return true;
      })
      .sort((a, b) => a.statusCode - b.statusCode);
  }

  /**
   * Emit an error class per declared status the runtime does not cover.
   *
   * A spec that declares a 408 should give its users a `RequestTimeoutError` to narrow on. Without
   * this the taxonomy named classes that did not exist, and the generated example failed to
   * compile — which is exactly what the gate is for.
   */
  private emitGeneratedErrors(): void {
    const errors = this.generatedErrors;
    if (errors.length === 0) return;

    this.createFile(
      'src/errors.ts',
      [
        {
          kind: StructureKind.ImportDeclaration,
          moduleSpecifier: './core/index.js',
          namedImports: [{ name: 'APIError' }],
        },
        ...errors.map((error) => ({
          kind: StructureKind.Class as const,
          name: error.name,
          isExported: true,
          // Threaded into the base so `error.body` is typed, not just declared.
          extends: 'APIError<TBody>',
          typeParameters: [{ name: 'TBody', default: 'unknown' }],
          docs: withDocs(`HTTP ${error.statusCode}.`),
          properties: [
            {
              name: 'status',
              isReadonly: true,
              hasOverrideKeyword: true,
              initializer: `${error.statusCode} as const`,
            },
          ],
        })),
      ],
      [
        '/**',
        ' * Error classes for statuses this API declares that the runtime does not special-case.',
        ' *',
        ' * They extend `APIError`, so `instanceof APIError` still catches them all.',
        ' */',
      ].join('\n'),
    );
  }

  /**
   * Create a source file from its complete statement list, in a single parse.
   *
   * This is the difference between generating Stripe's SDK in seconds and in minutes. ts-morph
   * reparses the containing file after **every** structural mutation, so building a file with
   * `addInterface` then a loop of `addProperty` costs O(n) parses of a file that is itself growing
   * — quadratic. A CPU profile of the Stripe run attributed 63% of 308 seconds to the scanner and
   * JSDoc parser, and a further 18% to the garbage collector feeding them.
   *
   * Passing the whole structure to `createSourceFile` parses once. `formatText()` is the only
   * subsequent mutation, and it is deliberate: it is what makes the output layout look printed
   * rather than assembled.
   *
   * The consequence for callers is a rule, not a preference: **build structures, return them, and
   * concatenate.** Never hold a `SourceFile` and mutate it. Statement order in the array is
   * statement order in the file, so imports must come first.
   */
  private createFile(
    path: string,
    statements: (string | StatementStructures)[],
    header?: string,
  ): SourceFile {
    const file = this.project.createSourceFile(path, { statements }, { overwrite: true });
    file.formatText();
    separateImportBlock(file);
    if (header !== undefined) {
      // Prepended as text, and always followed by a blank line, so it reads as a file header. A
      // comment block written as the first *statement* is parsed as the JSDoc of whatever follows
      // it, which put the note "types used across more than one resource" on a single interface.
      file.insertText(0, `${header}\n\n`);
    }
    return file;
  }

  emit(): GeneratedFile[] {
    this.emitSharedModels();
    this.emitSchemas();
    this.emitWebhooks();
    this.emitGeneratedErrors();
    for (const resource of this.allResources) this.emitResource(resource);
    this.emitClient();
    this.emitIndex();

    const files: GeneratedFile[] = this.project
      .getSourceFiles()
      .map((file) => ({
        path: file.getFilePath().replace(/^\//, ''),
        contents: file.getFullText(),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));

    // The hand-written runtime is vendored verbatim so generated SDKs are self-contained and
    // carry no graft dependency at all (SPEC.md §9).
    for (const [name, contents] of this.options.runtimeFiles) {
      files.push({ path: `src/core/${name}`, contents });
    }
    files.push(...this.scaffold());
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------

  /** Module path a type is emitted into. */
  private moduleOf(typeId: string): string {
    const owner = this.ownership.owners.get(typeId) ?? null;
    return owner === null
      ? 'src/shared.ts'
      : `src/resources/${owner.replace(/[^A-Za-z0-9_-]/g, '-')}.ts`;
  }

  /**
   * Add type-only imports for every type a file needs but does not declare.
   *
   * Cross-file type cycles are fine — types are erased, so `import type` never creates a runtime
   * cycle — which is what makes colocation safe here.
   */
  private typeImportStatements(needed: Set<string>, ownModule: string): ImportDeclarationStructure[] {
    const byModule = new Map<string, Set<string>>();
    for (const declared of needed) {
      const typeId = this.types.idForName(declared);
      if (typeId === undefined) continue;
      const module = this.moduleOf(typeId);
      if (module === ownModule) continue;
      const names = byModule.get(module) ?? new Set<string>();
      names.add(declared);
      byModule.set(module, names);
    }

    return [...byModule]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([module, names]) => ({
        kind: StructureKind.ImportDeclaration as const,
        moduleSpecifier: relativeModule(ownModule, module),
        namedImports: [...names].sort().map((name) => ({ name, isTypeOnly: true })),
      }));
  }

  /**
   * Emit the runtime validation descriptor table.
   *
   * Data, not code: a generated `validateWidget()` per type would make output size scale with the
   * type count, and Stripe has 1,440 (SPEC.md §3.4.1.1).
   */
  private emitSchemas(): void {
    // `off` omits the table entirely rather than emitting it unused. That is what makes the config
    // key meaningful for bundle size and not only for behaviour: the descriptors are one object
    // literal, so a bundler cannot tree-shake the entries a consumer never touches. On Stripe the
    // table is 624 KB of a 4.2 MB SDK, which is a real cost to be able to decline.
    if (this.validationDefault === 'off') return;
    // Deliberately *not* gated on the table being non-empty. `schemas.ts` holds the named-type table, but
    // resource modules import it whenever any *response descriptor* is worth checking — and those are two
    // different collections. A spec whose every response is `string[]` has no named types and a non-empty
    // response map, so the file was skipped while `widgets.ts` still imported it: an SDK that does not
    // compile, from a spec with nothing unusual in it.
    //
    // This is the same bug the Go target shipped, in the same place, found the same way — by generating
    // from a spec simpler than any corpus entry (SPEC.md §3.3.4). An empty table exports `{}`, which costs
    // a line and cannot be wrong.
    const entries = [...this.schemas.table]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, descriptor]) => `  ${JSON.stringify(name)}: ${renderDescriptor(descriptor)},`);

    this.createFile(
      'src/schemas.ts',
      [
        {
          kind: StructureKind.ImportDeclaration,
          moduleSpecifier: './core/index.js',
          namedImports: [{ name: 'Schema', isTypeOnly: true }, { name: 'SchemaTable', isTypeOnly: true }],
        },
        `export const schemas: SchemaTable = {\n${entries.join('\n')}\n};`,
        // Exported so a caller can validate a payload they obtained some other way — a webhook body,
        // a fixture in their own tests.
        `export type { Schema, SchemaTable };`,
      ],
      [
        '/**',
        ' * Runtime validation descriptors.',
        ' *',
        " * Walked by the vendored runtime's validator. Data rather than generated code, so output size",
        ' * does not scale with the number of types.',
        ' */',
      ].join('\n'),
    );
  }

  /**
   * The webhook surface: a typed union of events, and a verifier when a signature scheme is configured.
   *
   * Nothing is emitted for a spec declaring no webhooks, which is most of them — an empty accessor would be
   * a promise about a feature the API does not have.
   *
   * Two halves, deliberately unequal in ambition. The event union is ordinary generation. The verifier is a
   * *thin* wrapper over the hand-written runtime, which is the whole point: a generated HMAC comparison is
   * short, security-critical, and has three ways to be subtly wrong (SPEC.md §3.4.1.3), so this emits a
   * call to code that was reviewed once rather than crypto per SDK.
   */
  private emitWebhooks(): void {
    const webhooks = this.ir.webhooks;
    if (webhooks === undefined || webhooks.events.length === 0) return;

    const statements: (string | { kind: StructureKind.ImportDeclaration; moduleSpecifier: string; namedImports: Array<{ name: string; isTypeOnly?: boolean }> })[] = [];
    const modelImports = new Set<string>();

    // One interface per event, tagged by the name the provider sends. The tag is what makes the union
    // narrowable — `if (event.type === 'invoice.paid')` — which is the entire reason to generate a union
    // rather than hand back `unknown`.
    const members: string[] = [];
    for (const event of webhooks.events) {
      const payload = this.types.render(event.type);
      this.collectModelImports(event.type, modelImports);
      const name = `${pascal(event.tokens)}Webhook`;
      const docs = event.docs.summary ?? `The \`${event.name}\` webhook.`;
      statements.push(
        [
          '/**',
          ` * ${docs.replace(/\*\//g, '* /')}`,
          ' */',
          `export interface ${name} {`,
          `  readonly type: ${JSON.stringify(event.name)};`,
          `  readonly data: ${payload};`,
          '}',
        ].join('\n'),
      );
      members.push(name);
    }

    statements.push(
      [
        '/**',
        ' * Every webhook this API sends.',
        ' *',
        ' * Narrow on `type` to reach the payload:',
        ' *',
        ' * ```ts',
        ` * if (event.type === ${JSON.stringify(webhooks.events[0]!.name)}) {`,
        ' *   event.data;',
        ' * }',
        ' * ```',
        ' */',
        `export type WebhookEvent = ${members.join(' | ')};`,
      ].join('\n'),
    );

    const signature = webhooks.signature;
    if (signature === undefined) {
      // No scheme configured, so no verifier. Emitting one that returned true because it checked something
      // meaningless would be strictly worse than its absence: the false confidence is what stops anyone
      // from thinking about the problem, and the failure is silent and total.
      statements.push(
        [
          '/**',
          ' * Parse a webhook body **without verifying it**.',
          ' *',
          ' * No signature scheme is configured, so this SDK cannot verify anything — see',
          " * `webhooks.signature` in your config. Until you set it, treat every payload as untrusted",
          ' * input from the internet, because that is what it is.',
          ' */',
          'export function parseWebhookUnverified(body: string): WebhookEvent {',
          '  return JSON.parse(body) as WebhookEvent;',
          '}',
        ].join('\n'),
      );
    } else {
      statements.push(
        [
          '/**',
          ' * The signature scheme this API uses, as declared in your config.',
          ' */',
          `const scheme: WebhookSignatureScheme = ${JSON.stringify(signature, null, 2)};`,
        ].join('\n'),
      );
      statements.push(
        [
          '/**',
          ' * Verify a webhook and parse it, throwing when the signature does not hold.',
          ' *',
          ' * `body` must be the **raw bytes as received**. Passing a re-serialized object is the classic',
          " * mistake: it passes in testing and breaks the moment the sender's key order or whitespace",
          " * differs from your serializer's. Read the body before any JSON middleware touches it.",
          ' *',
          ' * @example',
          ' * ```ts',
          ' * const event = await verifyWebhook(await request.text(), request.headers, secret);',
          ' * ```',
          ' */',
          'export async function verifyWebhook(',
          '  body: string | Uint8Array,',
          '  headers: HeaderSource,',
          '  secret: string,',
          '): Promise<WebhookEvent> {',
          '  await verifyWebhookSignature(scheme, { body, headers, secret });',
          '  // Parsed only after verification succeeds, so untrusted bytes are never decoded on trust.',
          '  return JSON.parse(typeof body === \'string\' ? body : new TextDecoder().decode(body)) as WebhookEvent;',
          '}',
        ].join('\n'),
      );
    }

    const imports: Array<{ kind: StructureKind.ImportDeclaration; moduleSpecifier: string; namedImports: Array<{ name: string; isTypeOnly?: boolean }> }> = [];
    if (signature !== undefined) {
      imports.push({
        kind: StructureKind.ImportDeclaration,
        moduleSpecifier: './core/index.js',
        namedImports: [
          { name: 'verifyWebhookSignature' },
          { name: 'HeaderSource', isTypeOnly: true },
          { name: 'WebhookSignatureScheme', isTypeOnly: true },
        ],
      });
    }
    // Grouped by *owning module*, not assumed to be `shared.ts`. A webhook payload is frequently a schema
    // the API also returns, so it lives in that resource's module — importing it from `shared.js` produced
    // an SDK that did not compile, which the typecheck gate caught on the first run.
    const byModule = new Map<string, string[]>();
    for (const name of [...modelImports].sort()) {
      const typeId = this.types.idForName(name) ?? name;
      const module = this.moduleOf(typeId)
        .replace(/^src\//, './')
        .replace(/\.ts$/, '.js');
      const existing = byModule.get(module);
      if (existing === undefined) byModule.set(module, [name]);
      else existing.push(name);
    }
    for (const [module, names] of [...byModule].sort(([a], [b]) => a.localeCompare(b))) {
      imports.push({
        kind: StructureKind.ImportDeclaration,
        moduleSpecifier: module,
        namedImports: names.map((name) => ({ name, isTypeOnly: true })),
      });
    }

    this.createFile(
      'src/webhooks.ts',
      [...imports, ...statements],
      [
        '/**',
        ' * Webhooks this API sends.',
        ' *',
        ' * The event types come from the spec. Verification is performed by the vendored runtime, which is',
        ' * hand-written: an HMAC comparison is exactly the code that should not be generated.',
        ' */',
      ].join('\n'),
    );
  }

  /** Types used by more than one resource, or by none, live here. */
  private emitSharedModels(): void {
    const needed = new Set<string>();
    const types: StatementStructures[] = [];
    for (const typeId of this.ownership.shared) {
      const type = this.typeById.get(typeId);
      if (type === undefined) continue;
      types.push(this.namedTypeStatement(type));
      this.collectTypeDependencies(type, needed);
    }

    this.createFile(
      'src/shared.ts',
      [...this.typeImportStatements(needed, 'src/shared.ts'), ...types],
      [
        '/**',
        ' * Types used across more than one resource.',
        ' *',
        ' * Interfaces rather than classes: they are structural, cost nothing at runtime, and let',
        ' * callers pass plain object literals.',
        ' */',
      ].join('\n'),
    );
  }

  /**
   * Types by id.
   *
   * A map rather than `ir.types.find`: the previous linear scan ran once per type per resource,
   * which is 1,440 x 76 comparisons on Stripe for a lookup that should be constant.
   */
  private get typeById(): ReadonlyMap<string, NamedType> {
    this.typeByIdCache ??= new Map(this.ir.types.map((t) => [t.id, t]));
    return this.typeByIdCache;
  }
  private typeByIdCache: Map<string, NamedType> | undefined;

  /** Names of the types a named type refers to, for import resolution. */
  private collectTypeDependencies(type: NamedType, into: Set<string>): void {
    if (type.kind === 'object') {
      for (const field of type.fields) this.collectModelImports(field.type, into);
      if (type.additional !== undefined) this.collectModelImports(type.additional, into);
    } else if (type.kind === 'alias') {
      this.collectModelImports(type.target, into);
    }
  }

  private namedTypeStatement(type: NamedType): StatementStructures {
    const name = this.types.declaredName(type);

    if (type.kind === 'enum') {
      // A union of literals, not a TS `enum`: enums emit runtime code, cannot be `const`-folded
      // by consumers, and are widely avoided in modern TypeScript.
      const members = type.members.map((m) =>
        typeof m.wireValue === 'string' ? JSON.stringify(m.wireValue) : String(m.wireValue),
      );
      // Open enums union with `string`, because servers add values without warning and an
      // exhaustive type would turn a new value into a decode failure.
      const body = type.open ? [...members, '(string & {})'].join(' | ') : members.join(' | ');
      return {
        kind: StructureKind.TypeAlias,
        name,
        isExported: true,
        type: body,
        docs: withDocs(docComment(type.docs, type.open ? ['The server may add values; unknown values are preserved.'] : [])),
      };
    }

    if (type.kind === 'alias') {
      return {
        kind: StructureKind.TypeAlias,
        name,
        isExported: true,
        type: this.types.render(type.target),
        docs: withDocs(docComment(type.docs)),
      };
    }

    return {
      kind: StructureKind.Interface,
      name,
      isExported: true,
      docs: withDocs(docComment(type.docs)),
      properties: type.fields.map((field) => ({
        name: propertyKey(field.wireName),
        // Presence and nullability stay distinct: `?` for absent, `| null` for null.
        hasQuestionToken: !field.required,
        type: this.types.render(field.type),
        docs: withDocs(docComment(field.docs, fieldNotes(field))),
      })),
      ...(type.additional !== undefined
        ? {
            indexSignatures: [
              {
                keyName: 'key',
                keyType: 'string',
                returnType: this.indexSignatureType(type),
                docs: withDocs(
                  'Additional properties chosen at runtime and not part of the contract.',
                ),
              },
            ],
          }
        : {}),
    };
  }

  /**
   * The index-signature type for an interface that has both declared properties and open
   * `additionalProperties`.
   *
   * TypeScript requires the index type to be a supertype of every declared property's type, so
   * `{ playlist?: string; [key: string]: string }` is an error — `string | undefined` is not
   * assignable to `string`. Union in each property's type (plus `undefined` for optional ones)
   * so the declaration is valid without widening everything to `unknown`.
   */
  private indexSignatureType(type: Extract<NamedType, { kind: 'object' }>): string {
    const additional = type.additional === undefined ? 'unknown' : this.types.render(type.additional);
    if (type.fields.length === 0) return additional;

    const members = new Set<string>([additional]);
    for (const field of type.fields) {
      members.add(this.types.render(field.type));
      if (!field.required) members.add('undefined');
    }
    // If a member is already `unknown`, the union collapses to it.
    if (members.has('unknown')) return 'unknown';
    return [...members].join(' | ');
  }

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  private resourceFileName(resource: Resource): string {
    return `src/resources/${resource.id.replace(/[^A-Za-z0-9_-]/g, '-')}.ts`;
  }

  /**
   * Class name for a resource.
   *
   * Suffixed with `Resource` when the bare name would collide with a model type imported into
   * the same file — `session` yields both a `Session` model and a session resource. The class
   * name is an implementation detail: callers reach it as `client.session`, whose accessor comes
   * from the resource name, so disambiguating here costs the public API nothing.
   */
  private resourceClassName(resource: Resource): string {
    const base = pascal(resource.name) || 'Resource';
    return this.declaredTypeNames.has(base) ? `${base}Resource` : base;
  }

  /** Every name declared in `models.ts`, used to detect class/type collisions. */
  private get declaredTypeNames(): Set<string> {
    this.declaredTypeNamesCache ??= new Set(this.ir.types.map((t) => this.types.declaredName(t)));
    return this.declaredTypeNamesCache;
  }
  private declaredTypeNamesCache: Set<string> | undefined;

  /** `AssetsListParams` — resource-scoped so two resources' `list` params never collide. */
  private paramsTypeName(resource: Resource, method: Method): string {
    // Scoped by the full path so `orgs.invoices` and a top-level `invoices` cannot collide.
    const scope = this.resourceScopes.get(resource.id) ?? resource.name.tokens;
    return `${pascal(scope)}${pascal(method.name)}Params`;
  }

  private emitResource(resource: Resource): void {
    this.usesSchemas = false;
    const modelImports = new Set<string>();
    const runtimeImports = new Set<string>(['type BaseClient', 'type RequestOptions']);
    const paramInterfaces: Array<{ name: string; params: readonly Param[]; method: Method }> = [];

    // Types only this resource reaches are declared here, next to the methods that return them.
    const ownTypes: StatementStructures[] = [];
    for (const typeId of this.ownership.byResource.get(resource.id) ?? []) {
      const type = this.typeById.get(typeId);
      if (type === undefined) continue;
      ownTypes.push(this.namedTypeStatement(type));
      this.collectTypeDependencies(type, modelImports);
    }

    // Methods are built first: emitMethod is what discovers which imports the file needs, so the
    // import statements cannot be assembled until every method has been rendered.
    // `flatMap`, because a streaming operation contributes *two* methods: `stream()` yielding payloads
    // and `streamEvents()` yielding the same payloads with their framing metadata (SPEC.md §3.4.1.2).
    const methods = resource.methods.flatMap((method) => {
      const paramsName = this.paramsTypeName(resource, method);
      const emitted = this.emitMethod(resource, method, paramsName, modelImports, runtimeImports);
      if (emitted.paramsFields.length > 0) {
        paramInterfaces.push({ name: paramsName, params: emitted.paramsFields, method });
      }
      const primary = {
        name: safeMemberName(camel(method.name)),
        parameters: emitted.parameters,
        returnType: emitted.returnType,
        isAsync: emitted.isAsync,
        ...(emitted.isGenerator === true ? { isGenerator: true } : {}),
        docs: withDocs(docComment(method.docs, emitted.notes)),
        statements: emitted.statements,
      };
      if (emitted.metadataSibling === undefined) return [primary];
      return [primary, emitted.metadataSibling];
    });

    const resourceClass: StatementStructures = {
      kind: StructureKind.Class,
      name: this.resourceClassName(resource),
      isExported: true,
      docs: withDocs(docComment(resource.docs)),
      // Sub-resources are properties on their parent, so `client.orgs.invoices` reads naturally.
      properties: resource.subresources.map((sub) => ({
        name: safeMemberName(camel(sub.name)),
        type: this.resourceClassName(sub),
        isReadonly: true,
        docs: withDocs(docComment(sub.docs)),
      })),
      ctors: [
        {
          // A parameter property, expressed as scope + readonly rather than by rewriting the
          // parameter text afterwards. The rewrite worked but cost a full reparse of the file.
          parameters: [
            { name: 'client', type: 'BaseClient', scope: Scope.Protected, isReadonly: true },
          ],
          statements: resource.subresources.map(
            (sub) =>
              `this.${safeMemberName(camel(sub.name))} = new ${this.resourceClassName(sub)}(client);`,
          ),
        },
      ],
      methods,
    };

    const file = this.createFile(this.resourceFileName(resource), [
      ...resource.subresources.map((sub) => ({
        kind: StructureKind.ImportDeclaration as const,
        moduleSpecifier: `./${sub.id.replace(/[^A-Za-z0-9_-]/g, '-')}.js`,
        namedImports: [{ name: this.resourceClassName(sub) }],
      })),
      ...this.typeImportStatements(modelImports, this.resourceFileName(resource)),
      {
        kind: StructureKind.ImportDeclaration,
        moduleSpecifier: '../core/index.js',
        namedImports: [...runtimeImports].sort().map((entry) =>
          entry.startsWith('type ')
            ? { name: entry.slice(5), isTypeOnly: true }
            : { name: entry },
        ),
      },
      ...(this.usesSchemas
        ? [
            {
              kind: StructureKind.ImportDeclaration as const,
              moduleSpecifier: '../schemas.js',
              namedImports: [{ name: 'schemas' }],
            },
          ]
        : []),
      ...ownTypes,
      resourceClass,
      // Params interfaces live beside the resource that uses them, which is where a reader looks.
      ...paramInterfaces.map(({ name, params, method }) => ({
        kind: StructureKind.Interface as const,
        name,
        isExported: true,
        docs: withDocs(`Parameters for \`${camel(method.name)}\`.`),
        properties: params.map((param) => ({
          name: propertyKey(camel(param.name)),
          hasQuestionToken: !param.required,
          type: this.types.render(param.type),
          docs: withDocs(docComment(param.docs)),
        })),
      })),
    ]);

    // A place for hand-written methods to live *on the generated class*, so callers write
    // `client.assets.myHelper()` with no subclass. Carried across regeneration when
    // `preserve.regions` is enabled; see the Custom code guide.
    //
    // The one mutation this file needs after its single parse. A class structure takes members by
    // kind, never as free text, and the markers must sit *inside* the class body — placed after
    // the closing brace, a method the user writes between them is a top-level syntax error. One
    // reparse per resource file is linear and affordable; the loop of `addProperty`/`addMethod`
    // calls this replaced was not.
    file
      .getClassOrThrow(this.resourceClassName(resource))
      .addMember(
        `\n// Custom methods added between these markers are preserved across regeneration.\n// Set \`preserve.regions: false\` in ${BRAND.configFile} to opt out.\n// #region ${resource.id}\n// #endregion ${resource.id}\n`,
      );
    file.formatText();
  }

  /**
   * The rendered response descriptor for an operation, or undefined when there is nothing to check.
   *
   * `any` is returned as undefined rather than as a descriptor: validating against "anything" costs a
   * walk and can never fail, so emitting it would be pure overhead in every generated method.
   */
  private responseDescriptor(resource: Resource, method: Method): string | undefined {
    if (this.validationDefault === 'off') return undefined;
    const key = `${resource.id}#${method.name.tokens.join('.')}`;
    const descriptor = this.schemas.responses.get(key);
    if (descriptor === undefined || descriptor.k === 'any') return undefined;
    this.usesSchemas = true;
    return renderDescriptor(descriptor);
  }

  /**
   * The rendered descriptor for a paginated method's *item* type.
   *
   * Distinct from `responseDescriptor`, which describes the whole envelope. A paginator validates the
   * items it yields, because that is what the caller receives — the envelope's own fields are read by
   * path and never handed over.
   */
  private itemDescriptor(
    _resource: Resource,
    method: Method,
    scheme: IR['pagination'][number],
  ): string | undefined {
    if (this.validationDefault === 'off') return undefined;
    const ref = this.paginatedItemRef(method, scheme);
    if (ref === undefined) return undefined;
    const descriptor = this.schemas.describe(ref);
    if (descriptor.k === 'any') return undefined;
    this.usesSchemas = true;
    return renderDescriptor(descriptor);
  }

  /** Set when any method in the module being built needs the descriptor table imported. */
  private usesSchemas = false;

  private emitMethod(
    resource: Resource,
    method: Method,
    paramsTypeName: string,
    modelImports: Set<string>,
    runtimeImports: Set<string>,
  ): {
    parameters: Array<{ name: string; type: string; hasQuestionToken?: boolean }>;
    returnType: string;
    isAsync: boolean;
    isGenerator?: boolean;
    statements: string[];
    notes: string[];
    paramsFields: readonly Param[];
    /**
     * A second method this operation contributes, when it needs one.
     *
     * Only streaming operations do: `streamEvents()` alongside `stream()` (SPEC.md §3.4.1.2). Returned
     * rather than emitted here, because the resource emitter owns the class body and this function owns
     * one method's shape.
     */
    metadataSibling?: {
      name: string;
      parameters: Array<{ name: string; type: string; hasQuestionToken?: boolean }>;
      returnType: string;
      isAsync: boolean;
      isGenerator: boolean;
      docs: ReturnType<typeof withDocs>;
      statements: string[];
    };
  } {
    const noteLines: string[] = [];
    const pathParams = method.http.params.filter((p) => p.location === 'path');
    const queryParams = method.http.params.filter((p) => p.location === 'query');
    const headerParams = method.http.params.filter((p) => p.location === 'header');

    const parameters: Array<{ name: string; type: string; hasQuestionToken?: boolean }> = [];

    // Path parameters, positional and in path order — `get(id)` reads better than `get({ id })`.
    for (const param of pathParams) {
      parameters.push({
        name: safeIdentifier(camel(param.name)),
        type: this.renderParam(param, modelImports),
      });
    }

    // Request body, second.
    if (method.body !== undefined) {
      this.collectModelImports(method.body.type, modelImports);
      parameters.push({
        name: 'body',
        type: this.types.render(method.body.type),
        ...(method.body.required ? {} : { hasQuestionToken: true }),
      });
    }

    // Query and non-constant header params collapse into one optional `params` object.
    const paramsFields = [...queryParams, ...headerParams];
    for (const param of paramsFields) this.collectModelImports(param.type, modelImports);
    const hasParams = paramsFields.length > 0;
    if (hasParams) {
      // Required when any member is required, so callers are not told a mandatory filter is
      // optional.
      const anyRequired = paramsFields.some((p) => p.required);
      parameters.push({
        name: 'params',
        type: paramsTypeName,
        ...(anyRequired ? {} : { hasQuestionToken: true }),
      });
    }

    parameters.push({ name: 'options', type: 'RequestOptions', hasQuestionToken: true });

    // TypeScript forbids a required parameter after an optional one. It happens when a body is
    // optional but `params` carries a required member — Stripe has several. Rather than reorder the
    // signature (which would break the positional convention), widen the earlier optionals to
    // explicit `| undefined`, which is what a caller passes anyway.
    const lastRequired = parameters.reduce(
      (last, parameter, index) => (parameter.hasQuestionToken === true ? last : index),
      -1,
    );
    for (let index = 0; index < lastRequired; index++) {
      const parameter = parameters[index]!;
      if (parameter.hasQuestionToken !== true) continue;
      parameters[index] = {
        name: parameter.name,
        type: `${parameter.type} | undefined`,
      };
    }

    // --- body of the method ---
    const statements: string[] = [];
    const pathExpression = this.renderPath(method, pathParams);

    const queryEntries = queryParams.map(
      (p) => `${propertyKey(p.wireName)}: params?.${camel(p.name)}`,
    );
    const headerEntries = headerParams.map(
      (p) => `${propertyKey(p.wireName)}: params?.${camel(p.name)}`,
    );

    const isPaginated = method.paginationId !== undefined;
    const scheme = this.ir.pagination.find((p) => p.id === method.paginationId);

    if (isPaginated && scheme !== undefined) {
      runtimeImports.add('Paginator');
      runtimeImports.add('pageParams');
      const itemType = this.paginatedItemType(method, scheme, modelImports);

      // Parameters the paginator drives itself. They must be excluded from the static query
      // object: emitting `{ ...page, offset: params?.offset }` lets an `undefined` overwrite the
      // computed offset on every page after the first, so the SDK refetches page 1 forever.
      const controlled = new Set(
        [scheme.limitParam, scheme.offsetParam, scheme.pageParam, scheme.cursorParam].filter(
          (name): name is string => name !== undefined,
        ),
      );
      const staticEntries = queryParams
        .filter((p) => !controlled.has(p.wireName))
        .map((p) => `${propertyKey(p.wireName)}: params?.${camel(p.name)}`);

      const requestParts = [
        `method: '${method.http.verb}'`,
        `path: ${pathExpression}`,
        // `...page` last so the paginator's own cursor/offset always wins.
        `query: { ${[...staticEntries, '...page'].join(', ')} }`,
        ...(headerEntries.length > 0 ? [`headers: compact({ ${headerEntries.join(', ')} })`] : []),
        'options',
      ];
      if (headerEntries.length > 0) runtimeImports.add('compact');

      // Seed the paginator with whichever paging values the caller supplied.
      const seed = [...controlled]
        .filter((wireName) => queryParams.some((p) => p.wireName === wireName))
        .map((wireName) => {
          const param = queryParams.find((p) => p.wireName === wireName)!;
          return `${propertyKey(wireName)}: params?.${camel(param.name)}`;
        });

      // The item transform: validation and date coercion for each page.
      //
      // Paginated methods call `requestRaw` directly, so they never reached `requestValidated` — every
      // paginated response was unchecked and uncoerced. A list method is the most common thing in an
      // SDK, so that was most of the surface.
      const itemDescriptor = this.itemDescriptor(resource, method, scheme);
      const transform =
        itemDescriptor === undefined
          ? undefined
          : `  (items) => items.map((item) => enforceItem<${itemType}>(item, ${itemDescriptor}, schemas, ${JSON.stringify(
              `${camel(resource.name)}.${camel(method.name)}`,
            )}, this.client.validationMode)),`;
      if (transform !== undefined) runtimeImports.add('enforceItem');

      statements.push(
        `return new Paginator<${itemType}>(`,
        `  ${JSON.stringify(paginationConfigLiteral(scheme))},`,
        `  (page) => this.client.requestRaw({ ${requestParts.join(', ')} }),`,
        `  pageParams({ ${seed.join(', ')} }),`,
        ...(transform !== undefined ? [transform] : []),
        ');',
      );
      noteLines.push(
        'Returns a paginator: `await` it for the first page, or `for await` to walk every item.',
      );
      return {
        parameters,
        returnType: `Paginator<${itemType}>`,
        isAsync: false,
        statements,
        notes: noteLines,
        paramsFields,
      };
    }

    const returnType = this.renderReturn(method, modelImports);
    // The encoding the spec declared, not a default. Sending JSON to a form-encoded endpoint is the same
    // class of bug as sending it to a multipart one: it compiles, it typechecks, and the server rejects it.
    // Twilio declares `application/x-www-form-urlencoded` on all 62 of its write operations, and every one
    // was being sent as JSON until a generated test asserted the content type.
    const contentType = method.body?.contentType ?? '';
    const bodyKind = /multipart\//i.test(contentType)
      ? 'multipart'
      : /x-www-form-urlencoded/i.test(contentType)
        ? 'form'
        : undefined;
    const requestParts = [
      `method: '${method.http.verb}'`,
      `path: ${pathExpression}`,
      ...(queryEntries.length > 0 ? [`query: { ${queryEntries.join(', ')} }`] : []),
      ...(method.body !== undefined ? ['body'] : []),
      ...(bodyKind !== undefined ? [`bodyKind: '${bodyKind}' as const`] : []),
      ...(headerEntries.length > 0 ? [`headers: compact({ ${headerEntries.join(', ')} })`] : []),
      'options',
    ];
    if (headerEntries.length > 0) runtimeImports.add('compact');
    const requestArgs = `{ ${requestParts.join(', ')} }`;

    switch (method.response.kind) {
      case 'text':
        statements.push(`return this.client.requestText(${requestArgs});`);
        break;
      case 'binary':
        statements.push(`return this.client.requestBinary(${requestArgs});`);
        break;
      case 'stream': {
        // A stream is an AsyncIterable, matching how pagination reads. The response body is
        // handed to the decoder unread so it can be consumed incrementally.
        const sse = method.response.encoding === 'sse';
        const decoder = sse ? 'streamSSE' : 'streamJSONLines';
        const eventDecoder = sse ? 'streamSSEEvents' : 'streamJSONLineEvents';
        runtimeImports.add(decoder);
        runtimeImports.add(eventDecoder);
        // `type StreamEvent`, not `StreamEvent`. The set's `type ` prefix is what marks an import as
        // type-only, and `verbatimModuleSyntax` — which the conformance tsconfig enables and the generated
        // package's does not — rejects a type imported as a value. The generated SDK's own gate passed while
        // the stricter config did not, which is the more useful reading: a target must satisfy the strictest
        // configuration a consumer might have, not the one it ships.
        runtimeImports.add('type StreamEvent');
        statements.push(
          `const response = await this.client.requestStream(${requestArgs});`,
          `yield* ${decoder}<${returnType}>(response);`,
        );
        if (method.deprecated) noteLines.push('@deprecated');
        noteLines.push('Yields events as they arrive; iterate with `for await`.');

        // The metadata sibling. Same request, same payload type; it yields the `id` needed to resume and
        // the `retry` the server suggested. graft does not reconnect — see SPEC.md §3.4.1.2.
        const siblingName = safeMemberName(camel({ tokens: [...method.name.tokens, 'events'] }));
        const siblingNotes = [
          `As \`${camel(method.name)}\`, with each event's framing metadata.`,
          '',
          "Use `id` to resume: pass it as `lastEventId` in a later call's options. This SDK does not",
          'reconnect for you, because nothing in the spec says whether replaying from an id yields the',
          'missed events or restarts the stream.',
          ...(method.deprecated ? ['@deprecated'] : []),
        ];
        return {
          parameters,
          returnType: `AsyncGenerator<${returnType}>`,
          isAsync: true,
          isGenerator: true,
          statements,
          notes: noteLines,
          paramsFields,
          metadataSibling: {
            name: siblingName,
            parameters,
            returnType: `AsyncGenerator<StreamEvent<${returnType}>>`,
            isAsync: true,
            isGenerator: true,
            docs: withDocs(siblingNotes.join('\n')),
            statements: [
              `const response = await this.client.requestStream(${requestArgs});`,
              `yield* ${eventDecoder}<${returnType}>(response);`,
            ],
          },
        };
      }
      default: {
        // A validated call when the spec described the response shape, a plain one when it did not.
        // `requestValidated` lives on the client rather than in the transport because only generated
        // code knows which schema an operation has — see SPEC.md §3.4.1.1.
        const descriptor = this.responseDescriptor(resource, method);
        if (descriptor === undefined) {
          statements.push(`return this.client.request<${returnType}>(${requestArgs});`);
        } else {
          // No `Schema` import: the descriptor is an inline literal and the parameter is inferred, so
          // importing the type would leave an unused import in every resource module.
          statements.push(
            `return this.client.requestValidated<${returnType}>(`,
            `  ${requestArgs},`,
            `  ${descriptor},`,
            `  schemas,`,
            `  ${JSON.stringify(`${camel(resource.name)}.${camel(method.name)}`)},`,
            `);`,
          );
        }
      }
    }

    if (method.deprecated) noteLines.push('@deprecated');

    return {
      parameters,
      returnType: `Promise<${returnType}>`,
      isAsync: false,
      statements,
      notes: noteLines,
      paramsFields,
    };
  }

  /** `/assets/{id}` → `` `/assets/${id}` ``, with each segment encoded. */
  private renderPath(method: Method, pathParams: readonly Param[]): string {
    if (pathParams.length === 0) return JSON.stringify(method.http.path);
    let template = method.http.path;
    for (const param of pathParams) {
      template = template.replace(
        `{${param.wireName}}`,
        `\${encodeURIComponent(String(${safeIdentifier(camel(param.name))}))}`,
      );
    }
    return `\`${template}\``;
  }

  private renderParam(param: Param, modelImports: Set<string>): string {
    this.collectModelImports(param.type, modelImports);
    return this.types.render(param.type);
  }

  private renderReturn(method: Method, modelImports: Set<string>): string {
    const response = method.response;
    switch (response.kind) {
      case 'empty':
        return 'void';
      case 'text':
        return 'string';
      case 'binary':
        return 'Blob';
      case 'stream':
        this.collectModelImports(response.event, modelImports);
        return this.types.render(response.event);
      case 'json':
        this.collectModelImports(response.type, modelImports);
        return this.types.render(response.type);
    }
  }

  /** Follow a `{ kind: 'named' }` reference, and through any alias chain, to a concrete type. */
  private resolveNamed(ref: TypeRef): NamedType | undefined {
    let current = ref;
    for (let hops = 0; hops < 8; hops++) {
      if (current.kind !== 'named') return undefined;
      const found = this.ir.types.find((t) => t.id === (current as { id: string }).id);
      if (found === undefined) return undefined;
      if (found.kind !== 'alias') return found;
      current = found.target;
    }
    return undefined;
  }

  /**
   * The element type a paginated method yields.
   *
   * Two shapes to handle: a bare array response, and an envelope such as
   * `{ data: [...], next_cursor }`. For an envelope, walk the pagination scheme's `itemsSource`
   * path into the response type — otherwise the paginator is typed `Paginator<unknown>` and the
   * caller loses every field, which defeats the point of generating types at all.
   */
  /**
   * The IR reference for the items a paginated method yields.
   *
   * Separated from {@link paginatedItemType} so the rendered name and the reference come from one walk.
   * Two copies of this traversal would drift, which this codebase has learned three times.
   */
  private paginatedItemRef(
    method: Method,
    scheme: IR['pagination'][number] | undefined,
  ): TypeRef | undefined {
    const response = method.response;
    if (response.kind !== 'json') return undefined;

    const unwrap = (ref: TypeRef): TypeRef => (ref.kind === 'nullable' ? unwrap(ref.inner) : ref);

    let current = unwrap(response.type);
    const source = scheme?.itemsSource;
    if (source !== undefined && source.kind === 'body') {
      for (const segment of source.path) {
        const named = this.resolveNamed(current);
        if (named === undefined || named.kind !== 'object') return undefined;
        const field = named.fields.find((f) => f.wireName === segment);
        if (field === undefined) return undefined;
        current = unwrap(field.type);
      }
    }
    return current.kind === 'array' ? current.items : undefined;
  }

  private paginatedItemType(
    method: Method,
    scheme: IR['pagination'][number] | undefined,
    modelImports: Set<string>,
  ): string {
    const items = this.paginatedItemRef(method, scheme);
    if (items === undefined) return 'unknown';
    this.collectModelImports(items, modelImports);
    return this.types.render(items);
  }

  private collectModelImports(ref: Method['response'] | Param['type'] | unknown, into: Set<string>): void {
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      const typed = node as { kind?: string; id?: string; items?: unknown; values?: unknown; inner?: unknown; variants?: unknown[] };
      if (typed.kind === 'named' && typeof typed.id === 'string') {
        into.add(this.types.nameOf(typed.id));
        return;
      }
      if (typed.items !== undefined) walk(typed.items);
      if (typed.values !== undefined) walk(typed.values);
      if (typed.inner !== undefined) walk(typed.inner);
      if (Array.isArray(typed.variants)) typed.variants.forEach(walk);
    };
    walk(ref);
  }

  // -------------------------------------------------------------------------
  // Client
  // -------------------------------------------------------------------------

  /**
   * The constructor snippet used in generated examples.
   *
   * Derived from the spec's own auth schemes, not hardcoded. The previous version always wrote
   * `{ token: … }`, so a spec declaring only an API key documented an option that **does not exist**
   * on the generated options interface — a snippet that could not compile, in the client's own
   * doc comment. Exactly the failure the examples-inside-the-typecheck-gate rule exists to prevent,
   * except this one lived in a comment where the gate cannot see it.
   */
  private constructorExample(): string {
    // The env-var suffix matches `docs.ts`, which already got this right — `_API_KEY` for a key and
    // `_TOKEN` for a token — so the README and the doc comment name the same variable.
    const base = `process.env.${screaming(this.clientName)}`;
    const auth = this.ir.service.auth;
    const has = (kind: string): boolean => auth.some((scheme) => scheme.kind === kind);

    if (has('bearer')) return `new ${this.clientName}({ token: ${base}_TOKEN })`;
    if (has('apiKey')) return `new ${this.clientName}({ apiKey: ${base}_API_KEY })`;
    if (has('basic')) {
      return `new ${this.clientName}({ username: 'you@example.com', password: ${base}_PASSWORD })`;
    }
    return `new ${this.clientName}()`;
  }

  private emitClient(): void {
    const optionsName = `${this.clientName}Options`;

    const defaultServer = this.ir.service.servers.find((s) => s.default) ?? this.ir.service.servers[0];
    const hasBearer = this.ir.service.auth.some((a) => a.kind === 'bearer');
    const hasBasic = this.ir.service.auth.some((a) => a.kind === 'basic');
    const apiKey = this.ir.service.auth.find((a) => a.kind === 'apiKey');
    const oauth2 = this.ir.service.auth.find((a) => a.kind === 'oauth2');

    const optionsInterface: StatementStructures = {
      kind: StructureKind.Interface,
      name: optionsName,
      isExported: true,
      docs: withDocs('Options accepted by the client constructor.'),
      extends: ['Omit<ClientOptions, \'auth\'>'],
      properties: [
        ...(hasBearer
          ? [{
              name: 'token',
              hasQuestionToken: true,
              type: 'string',
              docs: withDocs(
                bearerDocs(this.ir),
              ),
            }]
          : []),
        ...(hasBasic
          ? [
              { name: 'username', hasQuestionToken: true, type: 'string', docs: withDocs('Used with `password` for HTTP Basic auth.') },
              { name: 'password', hasQuestionToken: true, type: 'string', docs: withDocs('Used with `username` for HTTP Basic auth.') },
            ]
          : []),
        ...(apiKey !== undefined && apiKey.kind === 'apiKey'
          ? [
              {
                name: 'apiKey',
                hasQuestionToken: true,
                type: 'string',
                docs: withDocs(`Sent as the \`${apiKey.wireName}\` ${apiKey.location}.`),
              },
            ]
          : []),
        ...(oauth2 !== undefined && oauth2.kind === 'oauth2' && oauth2.flow === 'clientCredentials'
          ? [
              {
                name: 'clientId',
                hasQuestionToken: true,
                type: 'string',
                docs: withDocs(
                  'OAuth2 client id. With `clientSecret`, the SDK obtains and refreshes tokens for you.',
                ),
              },
              {
                name: 'clientSecret',
                hasQuestionToken: true,
                type: 'string',
                docs: withDocs('OAuth2 client secret. Used with `clientId`.'),
              },
              {
                name: 'scopes',
                hasQuestionToken: true,
                type: 'string[]',
                docs: withDocs(
                  oauth2.scopes.length > 0
                    ? `Scopes to request. Declared by this API: ${oauth2.scopes
                        .map((scope) => `\`${scope.name}\``)
                        .slice(0, 8)
                        .join(', ')}${oauth2.scopes.length > 8 ? ', …' : ''}.`
                    : 'Scopes to request.',
                ),
              },
            ]
          : []),
        ...(oauth2 !== undefined && oauth2.kind === 'oauth2' && oauth2.flow === 'refreshToken'
          ? [
              {
                name: 'refreshToken',
                hasQuestionToken: true,
                type: 'string',
                docs: withDocs(
                  'A refresh token obtained through your own authorization-code flow. The SDK keeps ' +
                    'the access token current; it cannot perform the redirect itself.',
                ),
              },
              { name: 'clientId', hasQuestionToken: true, type: 'string', docs: withDocs('OAuth2 client id, when the token endpoint requires it.') },
              { name: 'clientSecret', hasQuestionToken: true, type: 'string', docs: withDocs('OAuth2 client secret, when the token endpoint requires it.') },
            ]
          : []),
        // One option per server variable, so a templated URL is configurable without making the
        // caller assemble a hostname. A variable with an `enum` becomes a union: the spec listed the
        // valid values, and widening them to `string` would leave a caller guessing at a region name.
        ...(defaultServer?.variables ?? []).map((variable) => ({
          name: camel(variable.name),
          hasQuestionToken: true,
          type:
            variable.enum !== undefined
              ? variable.enum.map((value) => JSON.stringify(value)).join(' | ')
              : 'string',
          docs: withDocs(
            [
              variable.description?.trim(),
              `Substituted into the base URL. Defaults to \`${variable.default}\`.`,
            ]
              .filter((line): line is string => line !== undefined && line !== '')
              .join(' '),
          ),
        })),
      ],
    };

    /**
     * Credentials resolved once, at the top of the constructor: explicit option first, environment
     * variable second.
     *
     * A local per credential rather than `token ?? readEnv(…)` inlined at each use, because
     * several of the branches below mention the same credential twice — once in the condition and once
     * in the value — and reading the environment in a condition but not in the value is precisely the
     * bug that shape invites.
     */
    const credentials: string[] = [];
    const resolve = (option: string, envVar: string | undefined): string => {
      credentials.push(
        envVar === undefined
          ? `const ${option} = options.${option};`
          : `const ${option} = options.${option} ?? readEnv(${JSON.stringify(envVar)});`,
      );
      return option;
    };
    const bearer = this.ir.service.auth.find((a) => a.kind === 'bearer');
    const basic = this.ir.service.auth.find((a) => a.kind === 'basic');
    if (bearer !== undefined && bearer.kind === 'bearer') resolve('token', bearer.envVar);
    if (basic !== undefined && basic.kind === 'basic') {
      resolve('username', basic.usernameEnvVar);
      resolve('password', basic.passwordEnvVar);
    }
    if (apiKey !== undefined && apiKey.kind === 'apiKey') resolve('apiKey', apiKey.envVar);
    if (oauth2 !== undefined && oauth2.kind === 'oauth2') {
      if (oauth2.flow === 'clientCredentials') {
        resolve('clientId', oauth2.clientIdEnvVar);
        resolve('clientSecret', oauth2.clientSecretEnvVar);
      } else {
        resolve('refreshToken', oauth2.refreshTokenEnvVar);
        resolve('clientId', oauth2.clientIdEnvVar);
        resolve('clientSecret', oauth2.clientSecretEnvVar);
      }
    }
    const readsEnv = credentials.some((line) => line.includes('readEnv('));

    const authStatements: string[] = [];

    /**
     * Every non-OAuth2 credential the spec declares, as rungs of one conditional expression.
     *
     * The single builder is the point. It started as the OAuth2 *fallback* alongside a hand-written
     * branch per scheme combination, and both halves grew the same bug from opposite directions: the
     * fallback checked only for a bearer token, so a spec declaring OAuth2 *and* an API key ignored
     * `apiKey`; the branch cascade had no case for Basic alone, so Twilio's spec produced
     * `{ type: 'none' }`. Both compiled and read as correct, and neither could authenticate. One
     * builder, driven by what the spec declares, cannot be incomplete for a combination nobody thought
     * to enumerate.
     */
    const authFallback = (indent: number, head = false): string[] => {
      const pad = ' '.repeat(indent);
      const rungs: string[] = [];
      // `head` means this expression stands alone rather than continuing an OAuth2 ternary, so the
      // first rung is a bare condition instead of an `else`.
      const open = (condition: string, value: string): void => {
        const lead = rungs.length === 0 ? (head ? '' : ': ') : '  : ';
        const mark = rungs.length === 0 ? '  ? ' : '    ? ';
        rungs.push(`${pad}${lead}${condition}`, `${pad}${mark}${value}`);
      };
      if (hasBearer) open('token !== undefined', "{ type: 'bearer', token }");
      if (hasBasic) {
        open(
          'username !== undefined && password !== undefined',
          "{ type: 'basic', username, password }",
        );
      }
      if (apiKey !== undefined && apiKey.kind === 'apiKey') {
        open(
          'apiKey !== undefined',
          `{ type: 'apiKey', key: apiKey, name: ${JSON.stringify(apiKey.wireName)}, in: ${JSON.stringify(apiKey.location)} }`,
        );
      }
      // The terminal rung. Its indentation follows however many rungs preceded it, which is exactly
      // the kind of layout arithmetic worth letting prettier finish.
      rungs.push(`${pad}${rungs.length === 0 ? '' : '  '.repeat(1)}: { type: 'none' };`);
      return rungs;
    };

    if (oauth2 !== undefined && oauth2.kind === 'oauth2') {
      // OAuth2 first when present: a spec declaring it alongside a plain bearer scheme means "fetch a
      // token, or accept one I already have", and fetching is the branch that needs the machinery.
      const scopes =
        oauth2.scopes.length > 0
          ? `options.scopes ?? ${JSON.stringify(oauth2.scopes.map((scope) => scope.name))}`
          : 'options.scopes';
      if (oauth2.flow === 'clientCredentials') {
        authStatements.push(
          '// The SDK holds the credentials and manages the token: one request per refresh however',
          '// many calls are in flight, refreshed before expiry, and retried once on a 401.',
          'const auth: Auth =',
          '  clientId !== undefined && clientSecret !== undefined',
          '    ? {',
          "        type: 'oauth2',",
          '        source: new TokenSource(',
          '          {',
          "            flow: 'clientCredentials',",
          `            tokenUrl: ${JSON.stringify(oauth2.tokenUrl)},`,
          '            clientId,',
          '            clientSecret,',
          `            scopes: ${scopes},`,
          '          },',
          '          options.fetch ?? globalThis.fetch,',
          '        ),',
          '      }',
          ...authFallback(4),
        );
      } else {
        authStatements.push(
          '// A refresh token the caller obtained through their own authorization-code flow. The',
          '// redirect needs a browser, so it stays your application\'s job; keeping the access token',
          '// current does not.',
          'const auth: Auth =',
          '  refreshToken !== undefined',
          '    ? {',
          "        type: 'oauth2',",
          '        source: new TokenSource(',
          '          {',
          "            flow: 'refreshToken',",
          `            tokenUrl: ${JSON.stringify(oauth2.tokenUrl)},`,
          '            refreshToken,',
          '            ...(clientId !== undefined ? { clientId } : {}),',
          '            ...(clientSecret !== undefined',
          '              ? { clientSecret }',
          '              : {}),',
          `            scopes: ${scopes},`,
          '          },',
          '          options.fetch ?? globalThis.fetch,',
          '        ),',
          '      }',
          ...authFallback(4),
        );
      }
    } else if (hasBearer || hasBasic || apiKey !== undefined) {
      // One builder rather than a branch per combination. The branch-per-combination version handled
      // `apiKey` alone, `bearer` + `basic`, and `bearer` alone — and silently emitted `{ type: 'none' }`
      // for `basic` alone, which is exactly what Twilio's spec declares. A client that cannot
      // authenticate compiles fine, so nothing caught it until the credentials became visible.
      authStatements.push('const auth: Auth =', ...authFallback(2, true));
    } else {
      authStatements.push("const auth: Auth = { type: 'none' };");
    }

    const constantHeaders = Object.entries(this.ir.service.constantHeaders);
    const clientConstructor = {
      parameters: [{ name: 'options', type: optionsName, initializer: '{}' }],
      statements: [
        ...credentials,
        ...authStatements,
        'super({',
        `  baseURL: options.baseURL ?? ${defaultBaseUrlExpression(defaultServer)},`,
        ...(this.options.idempotencyHeader !== undefined
          ? [`  idempotencyHeader: ${JSON.stringify(this.options.idempotencyHeader)},`]
          : []),
        // Before `...options`, so a caller's own choice still wins. A configured default is a
        // default, not an override.
        ...(this.validationDefault !== 'strict'
          ? [
              `  // Default from \`validation: ${this.validationDefault}\` in ${BRAND.configFile}.`,
              `  validation: ${JSON.stringify(this.validationDefault)},`,
            ]
          : []),
        '  ...options,',
        '  auth,',
        '  defaultHeaders: {',
        ...(constantHeaders.length > 0
          ? [
              '    // Constant on every operation in the spec, so hoisted out of method signatures.',
              ...constantHeaders.map(([k, v]) => `    ${propertyKey(k)}: ${JSON.stringify(v)},`),
            ]
          : []),
        '    ...options.defaultHeaders,',
        '  },',
        '});',
        '',
        ...this.ir.resources.map(
          (r) => `this.${safeMemberName(camel(r.name))} = new ${this.resourceClassName(r)}(this);`,
        ),
      ],
    };

    const file = this.createFile('src/client.ts', [
      {
        kind: StructureKind.ImportDeclaration,
        moduleSpecifier: './core/index.js',
        namedImports: [
          { name: 'BaseClient' },
          // Imported only when the spec declares a flow the SDK can perform, so a bearer-only SDK
          // does not carry the token machinery.
          ...(oauth2 !== undefined ? [{ name: 'TokenSource' }] : []),
          // Only when a credential actually falls back to one, so an SDK with no auth at all does not
          // import a function it never calls — which `noUnusedLocals` would reject anyway.
          ...(readsEnv ? [{ name: 'readEnv' }] : []),
          { name: 'Auth', isTypeOnly: true },
          { name: 'ClientOptions', isTypeOnly: true },
        ],
      },
      ...this.ir.resources.map((resource) => ({
        kind: StructureKind.ImportDeclaration as const,
        moduleSpecifier: `./resources/${resource.id.replace(/[^A-Za-z0-9_-]/g, '-')}.js`,
        namedImports: [{ name: this.resourceClassName(resource) }],
      })),
      optionsInterface,
      {
        kind: StructureKind.Class,
        name: this.clientName,
        isExported: true,
        extends: 'BaseClient',
        docs: withDocs(
          docComment(this.ir.service.docs, [
            '@example',
            '```ts',
            `const client = ${this.constructorExample()};`,
            '```',
          ]),
        ),
        properties: this.ir.resources.map((resource) => ({
          name: safeMemberName(camel(resource.name)),
          type: this.resourceClassName(resource),
          isReadonly: true,
          docs: withDocs(docComment(resource.docs)),
        })),
        ctors: [clientConstructor],
      },
    ]);

    // Inside the class body, for the same reason as the resource region.
    file
      .getClassOrThrow(this.clientName)
      .addMember(
        `\n// Custom methods added between these markers are preserved across regeneration.\n// #region client\n// #endregion client\n`,
      );
    file.formatText();
  }

  private emitIndex(): void {
    const exports: StatementStructures[] = [];
    exports.push({
      kind: StructureKind.ExportDeclaration,
      moduleSpecifier: './client.js',
      namedExports: [{ name: this.clientName }, { name: `${this.clientName}Options`, isTypeOnly: true }],
    });
    exports.push({ kind: StructureKind.ExportDeclaration, moduleSpecifier: './shared.js' });
    // Webhooks reach the public surface, because a handler is the caller's code and lives outside the SDK.
    // Verification a consumer cannot import is verification nobody performs.
    if (this.ir.webhooks !== undefined && this.ir.webhooks.events.length > 0) {
      exports.push({ kind: StructureKind.ExportDeclaration, moduleSpecifier: './webhooks.js' });
    }
    if (this.generatedErrors.length > 0) {
      exports.push({ kind: StructureKind.ExportDeclaration, moduleSpecifier: './errors.js' });
    }
    exports.push({
      kind: StructureKind.ExportDeclaration,
      moduleSpecifier: './core/index.js',
      namedExports: [
        'SDKError',
        'APIError',
        'APIConnectionError',
        'APIConnectionTimeoutError',
        'APIUserAbortError',
        'BadRequestError',
        'AuthenticationError',
        'PermissionDeniedError',
        'NotFoundError',
        'ConflictError',
        'UnprocessableEntityError',
        'RateLimitError',
        // So a handler can distinguish a forged request from a stale one; see `WebhookVerificationError`.
        ...(this.ir.webhooks?.signature !== undefined ? ['WebhookVerificationError'] : []),
        'InternalServerError',
        'isAPIError',
        'isSDKError',
        'Page',
        'Paginator',
        'StreamDecodeError',
        // Response validation. `ResponseValidationError` is deliberately not an `APIError`, so a caller
        // needs to be able to name it to catch it.
        'ResponseValidationError',
        // OAuth2. `OAuth2Error` is not an APIError, so a caller needs to name it to catch it.
        'OAuth2Error',
        'TokenSource',
      ].map((name) => ({ name })),
    });
    // The brand a consumer sees in a catch block should be *theirs*, not the generator's, so the
    // role-named base is aliased to `<ClientName>Error` — the shape `OpenAIError` has.
    exports.push({
      kind: StructureKind.ExportDeclaration,
      moduleSpecifier: './core/index.js',
      namedExports: [{ name: 'SDKError', alias: `${this.clientName}Error` }],
    });
    exports.push({
      kind: StructureKind.ExportDeclaration,
      moduleSpecifier: './core/index.js',
      namedExports: [
        { name: 'RequestOptions', isTypeOnly: true },
        { name: 'ClientOptions', isTypeOnly: true },
        { name: 'ValidationMode', isTypeOnly: true },
        { name: 'ValidationProblem', isTypeOnly: true },
      ],
    });
    // `export *` rather than naming the class: resource modules now also declare the types they
    // own, plus their `*Params` interfaces, and all of it is public API. Listing only the class
    // made every colocated type unreachable from the package entry point.
    for (const resource of this.allResources) {
      exports.push({
        kind: StructureKind.ExportDeclaration,
        moduleSpecifier: `./resources/${resource.id.replace(/[^A-Za-z0-9_-]/g, '-')}.js`,
      });
    }

    this.createFile(
      'src/index.ts',
      [
        ...exports,
        `\n// Re-export your own modules between these markers; preserved across regeneration.\n// #region exports\n// #endregion exports\n`,
      ],
      `/**\n * ${pascal(this.ir.service.name)} SDK.\n */`,
    );
  }

  // -------------------------------------------------------------------------
  // Scaffold
  // -------------------------------------------------------------------------

  private scaffold(): GeneratedFile[] {
    const packageName = this.options.packageName ?? `@${kebab(this.clientName)}/sdk`;
    const packageJson = {
      name: packageName,
      version: this.options.sdkVersion ?? '0.1.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      files: ['dist'],
      scripts: {
        build: 'tsc -p tsconfig.json',
        typecheck:
          'tsc -p tsconfig.json --noEmit && tsc -p tsconfig.examples.json && tsc -p tsconfig.tests.json',
        test: 'vitest run',
      },
      // vitest, because the generated tests need a runner and picking one for the user is better than
      // emitting tests that need a choice made before they run. It is a dev dependency, so it reaches
      // nobody who installs the published package.
      devDependencies: { typescript: '^5.8.3', vitest: '^3.2.0' },
      engines: { node: '>=18' },
      sideEffects: false,
    };

    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noUncheckedIndexedAccess: true,
        declaration: true,
        outDir: 'dist',
        rootDir: 'src',
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    };

    /**
     * A second config that typechecks `examples/` alongside `src/`.
     *
     * Separate because the build needs `rootDir: src` to lay out `dist/` correctly, and a
     * `rootDir` cannot contain files outside itself. The gate runs both, so an example that stops
     * compiling fails generation rather than shipping a snippet that lies.
     */
    const tsconfigExamples = {
      extends: './tsconfig.json',
      compilerOptions: {
        noEmit: true,
        rootDir: '.',
        outDir: undefined,
        // No ambient `@types/*` packages. Without this the examples typecheck only where
        // `@types/node` happens to be resolvable — which made the gate pass inside graft's own
        // workspace and fail in a bare directory. `env.d.ts` supplies the one global they need,
        // and an empty `types` guarantees it cannot collide with a real `@types/node`.
        types: [],
      },
      include: ['src/**/*.ts', 'examples/**/*.ts'],
    };

    /**
     * A third config covering the generated tests, which cannot be part of the gate above.
     *
     * The tests `import { describe } from 'vitest'`, and a freshly generated directory has not had
     * `npm install` run in it yet — so folding them into the examples gate made **every first
     * generation fail**, on the one command a new user runs first. `optional` on a gate covers a missing
     * *executable*, not a gate that runs and fails, so it could not have rescued this.
     *
     * The tests are not therefore unverified: they are verified by being *run*, which is the stronger
     * check and which vitest performs without needing anything installed in the output. This config is
     * what `npm run typecheck` uses once dependencies are present, so a user who installs gets both.
     */
    const tsconfigTests = {
      extends: './tsconfig.json',
      compilerOptions: { noEmit: true, rootDir: '.', outDir: undefined },
      include: ['src/**/*.ts', 'tests/**/*.ts'],
    };

    // Ship an explicit prettier config so regenerating produces identical bytes regardless of
    // whatever prettier config happens to sit above the output directory.
    const prettierrc = { semi: true, singleQuote: true, trailingComma: 'all', printWidth: 100 };

    const docs: DocsContext = {
      ir: this.ir,
      types: this.types,
      clientName: this.clientName,
      packageName,
      envVar: screaming(this.clientName),
      brand: this.options.brand,
    };
    const examples = renderExamples(docs);
    // Per-operation examples and tests (SPEC.md §3.11). The values come from `Method.example` in the IR,
    // so every language shows the same data for the same operation.
    const operationExamples = renderOperationExamples(docs);
    const operationTests = renderOperationTests(docs);

    return [
      { path: 'package.json', contents: `${JSON.stringify(packageJson, null, 2)}\n` },
      { path: 'tsconfig.json', contents: `${JSON.stringify(tsconfig, null, 2)}\n` },
      { path: 'tsconfig.examples.json', contents: `${JSON.stringify(tsconfigExamples, null, 2)}\n` },
      { path: 'tsconfig.tests.json', contents: `${JSON.stringify(tsconfigTests, null, 2)}\n` },
      { path: '.prettierrc.json', contents: `${JSON.stringify(prettierrc, null, 2)}\n` },
      { path: 'README.md', contents: renderReadme(docs) },
      { path: 'api.md', contents: renderApiReference(docs) },
      ...examples,
      ...operationExamples,
      ...operationTests,
    ];
  }

  private readme(packageName: string): string {
    const first = this.ir.resources.find((r) =>
      r.methods.some((m) => m.paginationId !== undefined),
    ) ?? this.ir.resources[0];
    const accessor = first === undefined ? 'resource' : camel(first.name);
    const lines = [
      `# ${packageName}`,
      '',
      `TypeScript SDK for ${serviceLabel(this.ir)} v${this.ir.service.version}.`,
      '',
      '## Install',
      '',
      '```sh',
      `npm install ${packageName}`,
      '```',
      '',
      '## Usage',
      '',
      '```ts',
      `import { ${this.clientName} } from '${packageName}';`,
      '',
      `const client = ${this.constructorExample()};`,
      '',
      `// Paginated list methods are async-iterable.`,
      `for await (const item of client.${accessor}.list()) {`,
      '  console.log(item);',
      '}',
      '```',
      '',
      '## Errors',
      '',
      '```ts',
      `import { NotFoundError } from '${packageName}';`,
      '',
      'try {',
      `  await client.${accessor}.get('missing');`,
      '} catch (error) {',
      '  if (error instanceof NotFoundError) {',
      '    console.log(error.status, error.requestId);',
      '  }',
      '}',
      '```',
      '',
      '---',
      '',
      this.options.brand.attribution,
      '',
    ];
    return lines.join('\n');
  }
}

/**
 * The default base URL, as a TypeScript expression.
 *
 * A plain string literal unless the server was templated, in which case it is a template literal that
 * reads each variable off the client options and falls back to the spec's default. Emitted inline
 * rather than through a runtime helper because the result is more readable than the machinery would
 * be — `https://${options.region ?? 'us-east-1'}.api.example.com` says exactly what it does.
 *
 * Substituting into `urlTemplate` rather than building from parts, so a URL where a variable appears
 * twice, or inside a path segment, comes out right without special cases.
 */
function defaultBaseUrlExpression(server: Server | undefined): string {
  const variables = server?.variables ?? [];
  if (server === undefined || variables.length === 0 || server.urlTemplate === undefined) {
    return JSON.stringify(server?.url ?? '');
  }
  // Backticks and `${` in a URL would break out of the template literal. Neither is legal in a URL,
  // but a malformed spec is not a reason to emit code that does not parse.
  const escaped = server.urlTemplate.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${');
  const substituted = variables.reduce(
    (acc, variable) =>
      acc
        .split(`{${variable.wireName}}`)
        .join(`\${options.${camel(variable.name)} ?? ${JSON.stringify(variable.default)}}`),
    escaped,
  );
  return `\`${substituted}\``;
}

function bearerDocs(ir: IR): string {
  const bearer = ir.service.auth.find((a) => a.kind === 'bearer');
  const prefix = bearer !== undefined && 'tokenPrefix' in bearer ? bearer.tokenPrefix : undefined;
  return prefix === undefined
    ? 'Bearer token.'
    : `Bearer token. Typically begins with \`${prefix}\`.`;
}

/**
 * The runtime config literal for a pagination scheme.
 *
 * Filtered by style, because the runtime's per-style config types are discriminated unions: an
 * offset parameter on a cursor scheme is a type error, not a harmless extra key.
 */
function paginationConfigLiteral(scheme: IR['pagination'][number]): Record<string, unknown> {
  const config: Record<string, unknown> = { style: scheme.style, itemsSource: scheme.itemsSource };
  if (scheme.limitParam !== undefined) config['limitParam'] = scheme.limitParam;

  if (scheme.style === 'offset') {
    if (scheme.offsetParam !== undefined) config['offsetParam'] = scheme.offsetParam;
    if (scheme.totalSource !== undefined) config['totalSource'] = scheme.totalSource;
  } else if (scheme.style === 'page') {
    if (scheme.pageParam !== undefined) config['pageParam'] = scheme.pageParam;
    if (scheme.totalSource !== undefined) config['totalSource'] = scheme.totalSource;
  } else {
    if (scheme.cursorParam !== undefined) config['cursorParam'] = scheme.cursorParam;
    if (scheme.cursorSource !== undefined) config['cursorSource'] = scheme.cursorSource;
  }
  return config;
}

function fieldNotes(field: Field): string[] {
  const notes: string[] = [];
  if (field.deprecated) notes.push('@deprecated');
  if (field.serverOwned) notes.push('Assigned by the server.');
  return notes;
}

function withDocs(text: string | undefined): Array<{ description: string }> | undefined {
  // Leading newline puts the text on its own line under `/**`; no trailing newline, or ts-morph
  // emits a dangling ` *` before the closing delimiter.
  return text === undefined ? undefined : [{ description: `\n${text}` }];
}

/**
 * Module specifier from one emitted file to another, with the `.js` extension NodeNext requires.
 */
function relativeModule(from: string, to: string): string {
  const fromParts = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  const target = toParts[toParts.length - 1]!.replace(/\.ts$/, '.js');
  const toDir = toParts.slice(0, -1);

  let common = 0;
  while (common < fromParts.length && common < toDir.length && fromParts[common] === toDir[common]) {
    common += 1;
  }
  const up = fromParts.length - common;
  const segments = [
    ...(up === 0 ? ['.'] : Array.from({ length: up }, () => '..')),
    ...toDir.slice(common),
    target,
  ];
  return segments.join('/').replace(/^\.\//, './');
}

/**
 * The generated client class name.
 *
 * Prefers `service.displayName` — the author's own casing — when removing separators leaves a
 * valid identifier, so `OpenAI` and `IBM Cloud` survive as `OpenAI` and `IBMCloud` rather than
 * being flattened to `OpenAi` and `IbmCloud` by re-casing lowercase tokens.
 *
 * No `Client` suffix, deliberately. Fern defaults to `${Namespace}Client`, but the SDKs people
 * actually enjoy using do not: `new OpenAI()`, `new Anthropic()`, `new Stripe()`. `new X()`
 * already says "construct a client", so the suffix is redundant.
 */
export function resolveClientName(ir: IR): string {
  const display = ir.service.displayName?.replace(/[^A-Za-z0-9]+/g, '') ?? '';
  // Requires an uppercase initial: a title like `my-cool-api` collapses to `mycoolapi`, which is
  // a valid identifier but not a class name. Those fall through to token casing.
  if (/^[A-Z][A-Za-z0-9]*$/.test(display)) return display;
  return pascal(ir.service.name) || 'Client';
}

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function screaming(name: string): string {
  return kebab(name).replace(/-/g, '_').toUpperCase();
}
