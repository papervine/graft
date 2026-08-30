/**
 * Stage 5: ir — build the semantic IR from the resolved spec plus the config overlay.
 *
 * This is where spec shapes stop existing. Everything downstream sees SDK concepts only
 * (SPEC.md §3.2), which is what lets five targets share one set of decisions.
 */

import { BRAND, extensionKey,
  IR_VERSION,
  type AuthScheme,
  type Docs,
  type ErrorTaxonomy,
  type Field,
  type IR,
  type WebhookEvent,
  type Webhooks,
  type Method,
  type Name,
  type NamedType,
  type PaginationScheme,
  type Param,
  type PrimitiveFormat,
  type PrimitiveKind,
  type Resource,
  type Response,
  type Server,
  type ServerVariable,
  type TypeRef,
  type Diagnostic,
  DIAGNOSTIC_CODES,
} from '@graft/protocol';
import {
  entriesOf,
  getArray,
  getObject,
  getString,
  isArray,
  isObject,
  structuralKey,
  type Json,
  type JsonObject,
} from './json.js';
import { DEFAULT_COMPOUND_WORDS, singularize, tokenize, tokenizeName } from './names.js';
import { attachExamples } from './examples.js';
import { componentSchemaName } from './resolve.js';
import { expandShorthand, parseValueSource, type Config, type ModelConfig } from './config.js';
import {
  findConstantHeaders,
  findPaginationCandidates,
  findReadWriteConflation,
  isPhpEmptyMapUnion,
  isScalarUnion,
} from './analyze.js';
import { hasTypeInformation, resourceGroupOf, type OperationView } from './operations.js';
import { readPropertyExtensions, readSchemaExtensions } from './extensions.js';
import type { Inspection } from './inspect.js';

const SCALAR_KINDS: Record<string, PrimitiveKind> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
};

const KNOWN_FORMATS = new Set<string>([
  'date-time', 'date', 'time', 'duration', 'uri', 'uuid', 'email', 'hostname', 'ipv4', 'ipv6',
  'byte', 'int32', 'int64', 'float', 'double', 'password',
]);

/**
 * Leaf tokens too generic to name a type by themselves.
 *
 * `Links`, `Meta`, `Value` are meaningless as exported SDK types, and whichever schema happened
 * to be traversed first would claim the bare name — making output depend on traversal order.
 * These always take a parent qualifier: `PreviewLinks`, not `Links`.
 */
const GENERIC_LEAF_TOKENS = new Set([
  'links', 'link', 'meta', 'metadata', 'data', 'value', 'values', 'item', 'items', 'info',
  'config', 'configuration', 'options', 'option', 'params', 'parameters', 'details', 'detail',
  'source', 'sources', 'target', 'targets', 'request', 'requests', 'response', 'responses',
  'permissions', 'permission', 'tags', 'tag', 'usage', 'settings', 'setting', 'result',
  'results', 'entry', 'entries', 'content', 'body', 'attributes', 'properties', 'extra',
  'context', 'state', 'status', 'type', 'types', 'kind', 'name', 'names', 'id', 'ids', 'ref',
  'refs', 'url', 'urls', 'uri', 'file', 'files', 'user', 'users', 'group', 'groups', 'cdn',
]);

/**
 * Names a synthesized type must never take, because they shadow a JavaScript or DOM global.
 *
 * A model called `Error` or `Response` exported from an SDK is a genuine hazard: importing it
 * shadows the built-in for that module, and the failure is confusing rather than loud. This
 * applies only to names *graft chooses*. A component the spec itself names `Event` keeps that
 * name — renaming what the API author declared would be more surprising than the shadowing.
 */
const RESERVED_TYPE_NAMES = new Set([
  'Error', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Function', 'Date', 'RegExp',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
  'JSON', 'Math', 'Infinity', 'NaN', 'Response', 'Request', 'Headers', 'Blob', 'File',
  'FormData', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'ReadableStream',
  'WritableStream', 'TextEncoder', 'TextDecoder', 'Iterator', 'AsyncIterator', 'Generator',
]);

/** Default retryability by status. 429 and 5xx are safe to retry; 4xx generally is not. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function docsFrom(node: JsonObject | undefined): Docs {
  if (node === undefined) return {};
  const docs: Docs = {};
  const summary = getString(node, 'summary');
  const description = getString(node, 'description');
  if (summary !== undefined) docs.summary = summary;
  if (description !== undefined) docs.description = description;
  if ('example' in node) docs.example = node['example'] as Json;
  return docs;
}

export interface BuildResult {
  readonly ir: IR;
  readonly diagnostics: Diagnostic[];
}

interface TypeRegistryEntry {
  readonly id: string;
  readonly type: NamedType;
}

/**
 * Builds the IR. Stateful because type registration is inherently accumulative: converting a
 * schema can synthesize new named types, which can themselves synthesize more.
 */
/**
 * Drop tokens that repeat later in a name hint, keeping the last occurrence of each.
 *
 * A deeply nested schema path repeats its own context. Twilio produces the hint
 * `api v2010 account incoming phone number incoming phone number assigned add on incoming phone
 * number assigned add on extension`, and Stripe produces one with `resource` three times. Neither
 * repetition carries information — the reader learned "incoming phone number" the first time — and
 * the names they build are 105 and 110 characters, long enough to overflow a line limit on their own
 * and to be unusable regardless.
 *
 * The **last** occurrence is kept rather than the first, because the final token is the type's own
 * name: for `[foo, bar, foo]`, keeping the first would silently rename the type to `BarFoo`'s
 * neighbour `FooBar`. Collisions are not a risk — the caller escalates through longer candidates and
 * falls back to a numeric discriminator.
 */
export function collapseRepeatedTokens(tokens: readonly string[]): string[] {
  const lastIndex = new Map<string, number>();
  tokens.forEach((token, index) => lastIndex.set(token, index));
  return tokens.filter((token, index) => lastIndex.get(token) === index);
}

class IRBuilder {
  private readonly types = new Map<string, NamedType>();
  private readonly diagnostics: Diagnostic[] = [];
  /** Structural key → existing type id, backing `structuralDedupe`. */
  private readonly structural = new Map<string, string>();
  private readonly cyclic: ReadonlySet<string>;
  private readonly models: Record<string, ModelConfig>;
  private readonly hoistedHeaders: Set<string>;
  /** Words used to split all-lowercase compounds like `assettypes`. */
  private readonly vocabulary: ReadonlySet<string>;
  /** Collected so one diagnostic covers every rename, rather than one line each. */
  private readonly methodRenames: string[] = [];

  constructor(
    private readonly inspection: Inspection,
    private readonly config: Config,
  ) {
    this.cyclic = inspection.resolved.cyclic;
    this.models = config.models ?? {};
    this.vocabulary = new Set([
      ...DEFAULT_COMPOUND_WORDS,
      ...(config.naming?.words ?? []).map((w) => w.toLowerCase()),
    ]);
    this.hoistedHeaders = new Set(
      config.normalize?.constHeaderHoist === false
        ? []
        : Object.keys(config.headers?.constant ?? {}).length > 0
          ? Object.keys(config.headers!.constant!)
          : findConstantHeaders(inspection.index).map((h) => h.name),
    );
  }

  build(): BuildResult {
    const service = this.buildService();
    const resources = this.buildResources();
    if (this.methodRenames.length > 0) {
      // One aggregated diagnostic: Stripe produced dozens of identical lines otherwise.
      this.diagnostics.push({
        severity: 'info',
        code: DIAGNOSTIC_CODES.NAME_SYNTHESIZED,
        message: `${this.methodRenames.length} method${
          this.methodRenames.length === 1 ? ' was' : 's were'
        } renamed from their operationId to avoid a collision.`,
        detail: this.methodRenames.slice(0, 8),
        count: this.methodRenames.length,
      });
    }
    const errors = this.buildErrors();
    const pagination = this.buildPagination();

    // Runs last, because it needs every union resolved before it can act on their discriminators.
    this.narrowDiscriminators();

    const webhooks = this.buildWebhooks();

    // Examples are attached last, because synthesizing a value needs the finished type graph — a
    // discriminator narrowed after the fact would leave an example carrying the pre-narrowing value, and
    // the paginated response fixture needs `pagination` resolved.
    const ir = attachExamples({
      irVersion: IR_VERSION,
      service,
      types: this.orderedTypes(),
      resources,
      errors,
      pagination,
      ...(webhooks !== undefined ? { webhooks } : {}),
    });

    return { ir, diagnostics: this.diagnostics };
  }

  // -------------------------------------------------------------------------
  // Service
  // -------------------------------------------------------------------------

  private buildService() {
    const document = this.inspection.spec.document;
    const info = getObject(document, 'info');
    // Precedence: config > `x-graft-client-name` on the document > `info.title`.
    const declared =
      this.config.name ??
      getString(this.inspection.spec.document, extensionKey('client-name')) ??
      getString(info, 'title') ??
      'API';
    const title = stripDocumentNoise(declared);

    const servers: Server[] = (getArray(document, 'servers') ?? [])
      .filter(isObject)
      .map((entry, index) => {
        const template = getString(entry, 'url') ?? '';
        const description = getString(entry, 'description');
        const named = getString(entry, 'x-fern-server-name');
        const variables = this.serverVariables(entry, template);
        // Defaults substituted here, so `url` always resolves. See `ServerSchema.url`.
        const url = variables.reduce(
          (acc, variable) => acc.split(`{${variable.wireName}}`).join(variable.default),
          template,
        );
        return {
          id: named ?? description ?? `server${index}`,
          url,
          ...(variables.length > 0 ? { urlTemplate: template, variables } : {}),
          ...(description !== undefined ? { description } : {}),
          // Last server wins as default: specs conventionally list staging first, production
          // last, and defaulting a generated SDK to staging would be a footgun.
          default: index === (getArray(document, 'servers') ?? []).length - 1,
        };
      });

    const constantHeaders: Record<string, string> = { ...(this.config.headers?.constant ?? {}) };
    if (Object.keys(constantHeaders).length === 0) {
      for (const header of findConstantHeaders(this.inspection.index)) {
        constantHeaders[header.name] = header.value;
      }
    }

    return {
      name: { tokens: tokenizeName(title, [], this.vocabulary) },
      displayName: title,
      version: getString(info, 'version') ?? '0.0.0',
      docs: docsFrom(info),
      servers,
      auth: this.buildAuth(envPrefix(title, this.config.envPrefix, this.vocabulary)),
      constantHeaders,
    };
  }

  /**
   * Narrow each discriminated union's member types on their discriminator field.
   *
   * The spec already said this: a `discriminator.mapping` entry asserts that a schema carries a
   * particular value in a particular field. graft was recording the mapping and then typing the field
   * as `string`, which left a union nobody could use — TypeScript cannot narrow on a non-literal, and
   * pydantic has nothing to dispatch on.
   *
   * Narrowing the *member* rather than the union is what makes it work for a schema used both inside
   * the union and standalone: there is one definition, and the literal is correct in both places.
   *
   * Two cases are deliberately left alone:
   *
   * - A member mapped to **different values in two unions**, which is contradictory. The wider type
   *   survives and a diagnostic explains why, because silently picking one would make the other union
   *   narrow to a branch that can never match.
   * - A member whose discriminator field the spec never declared. Inventing the field would change the
   *   shape the server promised.
   */
  private narrowDiscriminators(): void {
    /** typeId → the literal it has already been narrowed to, for conflict detection. */
    const assigned = new Map<string, { value: string; wireName: string }>();
    const conflicted = new Set<string>();

    const unions: Array<{ wireName: string; mapping: Record<string, string> }> = [];
    const collect = (ref: TypeRef | undefined): void => {
      if (ref === undefined) return;
      switch (ref.kind) {
        case 'union':
          if (ref.discriminator !== undefined) unions.push(ref.discriminator);
          for (const variant of ref.variants) collect(variant);
          return;
        case 'array':
          return collect(ref.items);
        case 'map':
          return collect(ref.values);
        case 'nullable':
          return collect(ref.inner);
        default:
          return;
      }
    };
    for (const type of this.types.values()) {
      if (type.kind === 'alias') collect(type.target);
      else if (type.kind === 'object') {
        for (const field of type.fields) collect(field.type);
        collect(type.additional);
      }
    }

    for (const { wireName, mapping } of unions) {
      for (const [value, typeId] of Object.entries(mapping)) {
        const existing = assigned.get(typeId);
        if (existing !== undefined && (existing.value !== value || existing.wireName !== wireName)) {
          conflicted.add(typeId);
          continue;
        }
        assigned.set(typeId, { value, wireName });
      }
    }

    for (const [typeId, { value, wireName }] of assigned) {
      if (conflicted.has(typeId)) {
        this.diagnostics.push({
          code: DIAGNOSTIC_CODES.DISCRIMINATOR_CONFLICT,
          severity: 'warn',
          message:
            `\`${typeId}\` is mapped to more than one discriminator value, so its \`${wireName}\` ` +
            `field stays widely typed and callers cannot narrow on it. A schema can only carry one ` +
            `discriminator value.`,
        });
        continue;
      }
      const target = this.types.get(typeId);
      if (target === undefined || target.kind !== 'object') continue;
      const field = target.fields.find((candidate) => candidate.wireName === wireName);
      if (field === undefined) continue;
      // Only a plain string field is narrowed. Anything else already carries more structure than the
      // mapping does, and overwriting it would lose information rather than add it.
      if (field.type.kind !== 'primitive' || field.type.type !== 'string') continue;

      this.types.set(typeId, {
        ...target,
        fields: target.fields.map((candidate) =>
          candidate.wireName === wireName
            ? { ...candidate, type: { kind: 'literal', value }, required: true }
            : candidate,
        ),
      });
    }
  }

  private buildAuth(prefix: string): AuthScheme[] {
    const components = getObject(this.inspection.spec.document, 'components');
    const schemes: AuthScheme[] = [];
    for (const [id, raw] of entriesOf(components, 'securitySchemes')) {
      if (!isObject(raw)) continue;
      const type = getString(raw, 'type');
      const docs = docsFrom(raw);
      if (type === 'http') {
        const scheme = (getString(raw, 'scheme') ?? '').toLowerCase();
        if (scheme === 'bearer') {
          const format = getString(raw, 'bearerFormat');
          // `bearerFormat` is documentation, e.g. "pat_<64 hex>". Extract a literal prefix if
          // one is obvious, but never enforce it — servers change token formats.
          const tokenPrefix = /^([A-Za-z][A-Za-z0-9]*_)/.exec(format ?? '')?.[1];
          schemes.push({
            kind: 'bearer',
            id,
            ...(tokenPrefix !== undefined ? { tokenPrefix } : {}),
            envVar: `${prefix}_TOKEN`,
            docs,
          });
        } else if (scheme === 'basic') {
          schemes.push({
            kind: 'basic',
            id,
            usernameEnvVar: `${prefix}_USERNAME`,
            passwordEnvVar: `${prefix}_PASSWORD`,
            docs,
          });
        }
      } else if (type === 'apiKey') {
        const location = getString(raw, 'in');
        const wireName = getString(raw, 'name');
        if (wireName !== undefined && (location === 'header' || location === 'query' || location === 'cookie')) {
          schemes.push({ kind: 'apiKey', id, location, wireName, envVar: `${prefix}_API_KEY`, docs });
        }
      } else if (type === 'oauth2' || type === 'openIdConnect') {
        const scheme = this.oauth2Scheme(id, raw, docs, prefix);
        if (scheme !== undefined) schemes.push(scheme);
      }
    }
    return schemes;
  }

  /**
   * Read the variables of a templated server URL (SPEC.md §3.4.0.2).
   *
   * Only variables that actually appear in the URL are kept, and only variables the URL references are
   * required to exist. Both halves of that are worth stating:
   *
   * - A declared variable the URL never uses is dead weight; emitting a client option for it would
   *   invite a caller to set something with no effect.
   * - A brace in the URL with no matching declaration has no default, so it cannot be substituted.
   *   That is the case that silently produced a base URL containing `{region}` — a host that does not
   *   resolve — so it is a warning rather than a shrug, and the placeholder is left in place where it
   *   is at least visible.
   */
  private serverVariables(entry: JsonObject, template: string): ServerVariable[] {
    const declared = getObject(entry, 'variables');
    const referenced = [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
    const unique = [...new Set(referenced)];

    const missing = unique.filter((name) => !isObject(declared?.[name]));
    if (missing.length > 0) {
      this.diagnostics.push({
        code: DIAGNOSTIC_CODES.SERVER_VARIABLE_UNDECLARED,
        severity: 'warn',
        message:
          `Server URL \`${template}\` references ${missing.length === 1 ? 'a variable' : 'variables'} ` +
          `it does not declare, so ${missing.length === 1 ? 'it' : 'they'} cannot be substituted. ` +
          `The base URL will contain a literal placeholder, which will not resolve.`,
        detail: missing.map((name) => `{${name}}`),
        count: missing.length,
      });
    }

    return unique.flatMap((wireName) => {
      const raw = declared?.[wireName];
      if (!isObject(raw)) return [];
      const values = (getArray(raw, 'enum') ?? []).filter(
        (value): value is string => typeof value === 'string',
      );
      // OpenAPI requires `default`, but specs omit it. Falling back to the first enum member is
      // better than an empty substitution, which would produce `https://.api.example.com`.
      const fallback = values[0] ?? '';
      const description = getString(raw, 'description');
      const tokens = tokenizeName(wireName, [], this.vocabulary);
      return [
        {
          wireName,
          name: { tokens: tokens.length > 0 ? tokens : ['variable'] },
          default: getString(raw, 'default') ?? fallback,
          ...(values.length > 0 ? { enum: values } : {}),
          ...(description !== undefined ? { description } : {}),
        },
      ];
    });
  }

  /**
   * Read an OAuth2 scheme, keeping only the flows an SDK can honestly own (SPEC.md §3.1.6).
   *
   * `clientCredentials` is machine-to-machine and entirely the SDK's job. `authorizationCode`
   * contributes only its refresh half — the redirect needs a browser and a human, so an SDK claiming
   * to perform it would be lying — and yields a `bearer` scheme so the caller can pass the token they
   * obtained. `implicit` and `password` are deprecated by OAuth 2.1 and are deliberately ignored.
   */
  private oauth2Scheme(
    id: string,
    raw: JsonObject,
    docs: Docs,
    prefix: string,
  ): AuthScheme | undefined {
    const flows = getObject(raw, 'flows');
    if (flows === undefined) {
      // `openIdConnect` declares a discovery URL rather than flows. Resolving it would mean a network
      // fetch at generate time, which makes generation non-hermetic — so it becomes a bearer scheme
      // and `check` says why.
      this.diagnostics.push({
        code: DIAGNOSTIC_CODES.OAUTH2_NO_USABLE_FLOW,
        severity: 'warn',
        message:
          `Security scheme \`${id}\` declares no usable OAuth2 flow, so the client accepts a token ` +
          `directly. Obtain one however your provider requires and pass it as \`token\`.`,
      });
      return { kind: 'bearer', id, envVar: `${prefix}_TOKEN`, docs };
    }

    const clientCredentials = getObject(flows, 'clientCredentials');
    if (clientCredentials !== undefined) {
      const tokenUrl = getString(clientCredentials, 'tokenUrl');
      if (tokenUrl !== undefined) {
        return {
          kind: 'oauth2',
          id,
          flow: 'clientCredentials',
          tokenUrl,
          ...(getString(clientCredentials, 'refreshUrl') !== undefined
            ? { refreshUrl: getString(clientCredentials, 'refreshUrl')! }
            : {}),
          scopes: scopesOf(clientCredentials),
          clientIdEnvVar: `${prefix}_CLIENT_ID`,
          clientSecretEnvVar: `${prefix}_CLIENT_SECRET`,
          docs,
        };
      }
    }

    const authorizationCode = getObject(flows, 'authorizationCode');
    if (authorizationCode !== undefined) {
      const refreshUrl = getString(authorizationCode, 'refreshUrl');
      const tokenUrl = getString(authorizationCode, 'tokenUrl');
      // Only the refresh half. A caller who has a refresh token gets it kept fresh; a caller who has
      // only an access token passes it as a bearer token.
      this.diagnostics.push({
        code: DIAGNOSTIC_CODES.OAUTH2_AUTHORIZATION_CODE,
        severity: 'info',
        message:
          `Security scheme \`${id}\` uses the authorization-code flow. The redirect needs a browser, ` +
          `so it stays your application's job — pass the resulting token as \`token\`, or a refresh ` +
          `token to have the SDK keep it current.`,
      });
      if (refreshUrl !== undefined || tokenUrl !== undefined) {
        return {
          kind: 'oauth2',
          id,
          flow: 'refreshToken',
          tokenUrl: refreshUrl ?? tokenUrl!,
          scopes: scopesOf(authorizationCode),
          refreshTokenEnvVar: `${prefix}_REFRESH_TOKEN`,
          docs,
        };
      }
      return { kind: 'bearer', id, envVar: `${prefix}_TOKEN`, docs };
    }

    // `implicit` or `password` only. Both are deprecated; the client accepts a token instead.
    this.diagnostics.push({
      code: DIAGNOSTIC_CODES.OAUTH2_DEPRECATED_FLOW,
      severity: 'warn',
      message:
        `Security scheme \`${id}\` declares only the implicit or password flow, both deprecated by ` +
        `OAuth 2.1. The client accepts a token directly rather than implementing them.`,
    });
    return { kind: 'bearer', id, envVar: `${prefix}_TOKEN`, docs };
  }

  // -------------------------------------------------------------------------
  // Types
  // -------------------------------------------------------------------------

  private register(type: NamedType): string {
    let id = type.id;
    let suffix = 2;
    while (this.types.has(id) && structuralKey(this.types.get(id) as unknown as Json) !== structuralKey(type as unknown as Json)) {
      id = `${type.id}${suffix++}`;
    }
    if (!this.types.has(id)) this.types.set(id, { ...type, id });
    return id;
  }


  /**
   * Pick the shortest readable name for a synthesized type.
   *
   * Concatenating the whole JSON path produces names like
   * `NotificationEventWorkRequestMaterialsItemChangeRequestsItemRepliesItem`, which is
   * technically unique and unusable. Humans name the type after the thing it *is* and only add
   * parent context when that would be ambiguous, so escalate: try the last token, then the last
   * two, and so on, taking the first that is not already claimed.
   */
  private synthesizedName(rawHint: readonly string[]): { id: string; tokens: string[] } {
    const nameHint = collapseRepeatedTokens(rawHint);
    const pascalOf = (tokens: readonly string[]): string =>
      tokens.map((t) => t[0]!.toUpperCase() + t.slice(1)).join('');

    /**
     * Qualifiers read better singular: `PermissionSources`, not `PermissionsSources`. A
     * qualifier names the thing that *contains* the type, and English uses the singular
     * attributively — "permission sources", not "permissions sources". The final token keeps its
     * number, because that is the type's own name.
     */
    const singularizeQualifiers = (tokens: readonly string[]): string[] =>
      tokens.map((token, index) =>
        index === tokens.length - 1 ? token : singularize(token, this.vocabulary),
      );

    // A leaf token that says nothing on its own needs its parent for context. Exporting a type
    // called `Links`, `Meta`, or `Option1` from an SDK tells a reader nothing, and which schema
    // wins the bare name would depend on traversal order — so require at least one qualifier.
    const leaf = nameHint[nameHint.length - 1];
    const genericLeaf =
      leaf !== undefined && (GENERIC_LEAF_TOKENS.has(leaf) || /^option\d+$/.test(leaf));
    const start = genericLeaf && nameHint.length > 1 ? 2 : 1;

    for (let take = start; take <= nameHint.length; take++) {
      const tokens = singularizeQualifiers(nameHint.slice(nameHint.length - take));
      const candidate = pascalOf(tokens);
      if (candidate === '' || /^\d/.test(candidate)) continue;
      if (RESERVED_TYPE_NAMES.has(candidate)) continue;
      if (!this.types.has(candidate)) return { id: candidate, tokens };
    }
    // Every suffix is taken; fall back to the full path plus a numeric discriminator.
    const full = pascalOf(nameHint) || 'Model';
    const id = this.uniqueId(full);
    return { id, tokens: id === full ? [...nameHint] : [...nameHint, id.slice(full.length)] };
  }

  /** Register an anonymous object under a synthesized name, deduplicating by structure. */
  private registerSynthesized(schema: JsonObject, nameHint: readonly string[]): string {
    const key = structuralKey(schema);
    const existing = this.structural.get(key);
    if (existing !== undefined) return existing;

    // `tokens` must be the tokens that produced `id`, not the full path. Targets render
    // `name.tokens`, so storing the whole hint would emit the long name the escalation above
    // exists to avoid — the short id would be invisible.
    const { id, tokens } = this.synthesizedName(nameHint);
    // Reserve the id before converting fields, so a self-referential schema terminates.
    this.types.set(id, {
      kind: 'object',
      id,
      name: { tokens },
      docs: {},
      fields: [],
      role: 'shared',
      cyclic: false,
    });
    this.structural.set(key, id);
    const fields = this.fieldsOf(schema, nameHint, new Set());
    const additional = this.additionalOf(schema, nameHint);
    this.types.set(id, {
      kind: 'object',
      id,
      name: { tokens },
      docs: docsFrom(schema),
      fields,
      ...(additional !== undefined ? { additional } : {}),
      role: 'shared',
      cyclic: false,
    });
    return id;
  }

  private uniqueId(base: string): string {
    if (!this.types.has(base)) return base;
    let suffix = 2;
    while (this.types.has(`${base}${suffix}`)) suffix++;
    return `${base}${suffix}`;
  }

  private additionalOf(schema: JsonObject, nameHint: readonly string[]): TypeRef | undefined {
    const additional = schema['additionalProperties'];
    if (additional === undefined || additional === false) return undefined;
    if (additional === true) return { kind: 'unknown' };
    if (!isObject(additional)) return undefined;
    return this.toTypeRef(additional, [...nameHint, 'value']);
  }

  private fieldsOf(
    schema: JsonObject,
    nameHint: readonly string[],
    extraRequired: ReadonlySet<string>,
  ): Field[] {
    const properties = getObject(schema, 'properties');
    if (properties === undefined) return [];
    const declaredRequired = new Set(
      (getArray(schema, 'required') ?? []).filter((r): r is string => typeof r === 'string'),
    );

    return Object.entries(properties)
      // A property the spec marks `x-graft-ignore` never becomes a field at all, so it cannot
      // leak into a read model either.
      .filter(([, raw]) => !(isObject(raw) && readPropertyExtensions(raw).ignore?.value === true))
      .map(([wireName, raw]) => {
      const node = isObject(raw) ? raw : {};
      const tokens = tokenizeName(wireName, [], this.vocabulary);
      return {
        name: { tokens: tokens.length > 0 ? tokens : ['field'] },
        wireName,
        type: this.toTypeRef(node, [...nameHint, ...tokens]),
        required: declaredRequired.has(wireName) || extraRequired.has(wireName),
        // `x-graft-server-owned` on the property beats listing names in config: it lives next to
        // the field and cannot drift out of sync with a rename.
        serverOwned: readPropertyExtensions(node).serverOwned?.value === true,
        readOnly: node['readOnly'] === true,
        writeOnly: node['writeOnly'] === true,
        deprecated: node['deprecated'] === true,
        docs: docsFrom(node),
      };
    });
  }

  /**
   * Flatten an `allOf` composition into a single object schema.
   *
   * Composition is a spec-authoring convenience, not an SDK concept: a generated type with three
   * base interfaces reads worse than one flat type, and TypeScript consumers gain nothing from
   * the hierarchy. Members are merged left to right so later members win, which matches how
   * specs use `allOf` to specialize a base.
   *
   * Returns `undefined` when there is no `allOf` to flatten, so callers can fall through.
   */
  private mergeAllOf(schema: JsonObject, depth = 0): JsonObject | undefined {
    const allOf = getArray(schema, 'allOf');
    if (allOf === undefined || allOf.length === 0) return undefined;
    // Composition can nest; bound the recursion rather than trusting the spec not to cycle.
    if (depth > 8) return undefined;

    const properties: JsonObject = {};
    const required: string[] = [];
    let additional: Json | undefined;

    const absorb = (node: JsonObject): void => {
      const nested = this.mergeAllOf(node, depth + 1);
      const source = nested ?? node;
      for (const [key, value] of Object.entries(getObject(source, 'properties') ?? {})) {
        properties[key] = value;
      }
      for (const key of getArray(source, 'required') ?? []) {
        if (typeof key === 'string' && !required.includes(key)) required.push(key);
      }
      if (source['additionalProperties'] !== undefined) additional = source['additionalProperties'];
    };

    for (const member of allOf) {
      const node = isObject(member) ? member : {};
      const ref = getString(node, '$ref');
      const resolved = ref !== undefined ? this.inspection.resolved.resolve(ref) : node;
      if (isObject(resolved)) absorb(resolved);
    }

    // Properties declared alongside `allOf` on the same node are part of the composition too.
    absorb({ ...schema, allOf: [] });

    if (Object.keys(properties).length === 0) return undefined;
    return {
      type: 'object',
      properties,
      required,
      ...(additional !== undefined ? { additionalProperties: additional } : {}),
      ...(getString(schema, 'description') !== undefined
        ? { description: getString(schema, 'description')! }
        : {}),
    };
  }

  /**
   * Convert a schema to a type reference *without* registering it under a name.
   *
   * Used when a named component turns out not to be an object — a `oneOf` union, an enum, or a
   * bare scalar — so the component becomes a type alias to the converted shape rather than an
   * empty interface.
   */
  private toTypeRefUnnamed(schema: JsonObject, nameHint: readonly string[]): TypeRef {
    return this.toTypeRef(schema, nameHint);
  }

  /**
   * Convert a spec schema node into an IR type reference.
   *
   * Every normalizer rule from SPEC.md §3.1.2 that concerns *types* fires here.
   */
  private toTypeRef(schema: JsonObject, nameHint: readonly string[]): TypeRef {
    // `$ref` → a named type, possibly renamed or split by config.
    const ref = getString(schema, '$ref');
    if (ref !== undefined) {
      const name = componentSchemaName(ref);
      if (name === undefined) return { kind: 'unknown' };
      return { kind: 'named', id: this.readModelId(name) };
    }

    // `schema: {}` — says nothing. `unknown`, never `any`.
    if (!hasTypeInformation(schema)) return { kind: 'unknown' };

    // phpEmptyMap: a union that is really a map whose empty form serializes as `[]`.
    if (this.config.normalize?.phpEmptyMap !== false && isPhpEmptyMapUnion(schema)) {
      const branches = getArray(schema, 'oneOf') ?? getArray(schema, 'anyOf') ?? [];
      const objectBranch = branches.find(
        (b): b is JsonObject => isObject(b) && getString(b, 'type') === 'object',
      );
      const values =
        objectBranch !== undefined
          ? (this.additionalOf(objectBranch, nameHint) ?? { kind: 'unknown' as const })
          : { kind: 'unknown' as const };
      return { kind: 'map', values, emptyWireValue: 'array' };
    }

    // Which keyword this came from, kept rather than collapsed. They mean different things, and the
    // single `??` that used to read them made the distinction unrecoverable downstream.
    const oneOfBranches = getArray(schema, 'oneOf');
    const combinator: 'oneOf' | 'anyOf' = oneOfBranches !== undefined ? 'oneOf' : 'anyOf';
    const branches = oneOfBranches ?? getArray(schema, 'anyOf');
    if (branches !== undefined && branches.length > 0) {
      const isScalar = isScalarUnion(schema);
      if (isScalar && this.config.normalize?.scalarUnion === 'coerce') {
        // Pick the widest scalar and let the runtime coerce into it.
        return { kind: 'primitive', type: 'string' };
      }
      // When exactly one variant carries structure, that variant *is* the thing the property
      // names — `coordinator: string | Coordinator`, not `string | CoordinatorOption2`. An
      // ordinal only earns its place when several variants would otherwise collide.
      const objectBranches = branches.filter(
        (branch) =>
          isObject(branch) &&
          (getString(branch, 'type') === 'object' ||
            'properties' in branch ||
            getString(branch, '$ref') !== undefined),
      );
      const soleStructured = objectBranches.length === 1 ? objectBranches[0] : undefined;

      const variants = branches
        .filter(isObject)
        .map((branch, index) =>
          this.toTypeRef(
            branch,
            branch === soleStructured ? [...nameHint] : [...nameHint, `option${index + 1}`],
          ),
        );
      if (variants.length === 1) return variants[0]!;
      if (variants.length === 0) return { kind: 'unknown' };
      const discriminator = getObject(schema, 'discriminator');
      const mapping = getObject(discriminator, 'mapping');
      const propertyName = getString(discriminator, 'propertyName');
      return {
        kind: 'union',
        variants,
        combinator,
        ...(propertyName !== undefined
          ? {
              discriminator: {
                wireName: propertyName,
                mapping: Object.fromEntries(
                  Object.entries(mapping ?? {}).map(([k, v]) => [
                    k,
                    componentSchemaName(String(v)) ?? String(v),
                  ]),
                ),
              },
            }
          : {}),
        ...(isScalar ? { coercion: 'scalar' as const } : {}),
      };
    }

    const merged = this.mergeAllOf(schema);
    if (merged !== undefined) {
      return { kind: 'named', id: this.registerSynthesized(merged, nameHint) };
    }

    const enumValues = getArray(schema, 'enum');
    if (enumValues !== undefined && enumValues.length > 0) {
      const { id, tokens } = this.synthesizedName(nameHint.length > 0 ? nameHint : ['enum']);
      this.register({
        kind: 'enum',
        id,
        name: { tokens },
        docs: docsFrom(schema),
        members: enumValues
          .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
          .map((value) => ({
            name: { tokens: tokenizeName(String(value), [], this.vocabulary).length > 0 ? tokenizeName(String(value), [], this.vocabulary) : ['value'] },
            wireValue: value,
            docs: {},
          })),
        // Servers add enum values without warning; an exhaustive type would break decoding.
        open: true,
      });
      return { kind: 'named', id };
    }

    const declaredType = schema['type'];
    // OpenAPI 3.1 expresses nullability as a type array: `type: [string, 'null']`.
    if (isArray(declaredType)) {
      const nonNull = declaredType.filter((t) => t !== 'null');
      const nullable = declaredType.length !== nonNull.length;
      const inner =
        nonNull.length === 1
          ? this.toTypeRef({ ...schema, type: nonNull[0] as Json }, nameHint)
          : { kind: 'unknown' as const };
      return nullable ? { kind: 'nullable', inner } : inner;
    }

    const typeName = typeof declaredType === 'string' ? declaredType : undefined;

    // OpenAPI 3.0 expresses nullability as a sibling flag.
    const isNullable = schema['nullable'] === true;
    const wrap = (inner: TypeRef): TypeRef => (isNullable ? { kind: 'nullable', inner } : inner);

    if (typeName === 'array') {
      const items = getObject(schema, 'items');
      // The elements of a `replies` array are each a `Reply`. Appending `Item` instead would
      // produce `RepliesItem`, which is the kind of name that marks output as generated.
      return wrap({
        kind: 'array',
        items: items
          ? this.toTypeRef(items, singularizeHint(nameHint, this.vocabulary))
          : { kind: 'unknown' },
      });
    }

    if (typeName === 'object' || 'properties' in schema || 'additionalProperties' in schema) {
      const properties = getObject(schema, 'properties');
      // An object with no declared properties but open additionalProperties is a map, not a
      // type worth naming.
      if (properties === undefined || Object.keys(properties).length === 0) {
        const values = this.additionalOf(schema, nameHint);
        return wrap({ kind: 'map', values: values ?? { kind: 'unknown' } });
      }
      return wrap({ kind: 'named', id: this.registerSynthesized(schema, nameHint) });
    }

    if (typeName !== undefined && typeName in SCALAR_KINDS) {
      const format = getString(schema, 'format');
      if (typeName === 'string' && format === 'binary') return wrap({ kind: 'binary' });
      return wrap({
        kind: 'primitive',
        type: SCALAR_KINDS[typeName]!,
        ...(format !== undefined && KNOWN_FORMATS.has(format)
          ? { format: format as PrimitiveFormat }
          : {}),
      });
    }

    return wrap({ kind: 'unknown' });
  }

  // -------------------------------------------------------------------------
  // Read/write split (SPEC.md §3.1.1)
  // -------------------------------------------------------------------------

  private readonly builtModels = new Set<string>();

  private modelConfig(schemaName: string): ModelConfig | undefined {
    return this.models[schemaName];
  }

  /** `x-graft-name` on the schema, used when config does not rename it. */
  private schemaExtensionName(schemaName: string): string | undefined {
    const schema = this.inspection.resolved.schemas.get(schemaName);
    return schema === undefined ? undefined : readSchemaExtensions(schema).name?.value;
  }

  private modelName(schemaName: string, role: 'read' | 'create' | 'update'): string {
    const config = this.modelConfig(schemaName);
    const split = config?.split;
    if (split !== undefined) {
      const named = role === 'read' ? split.read : role === 'create' ? split.create : split.update;
      if (named !== undefined) return named;
    }
    return config?.rename ?? this.schemaExtensionName(schemaName) ?? schemaName;
  }

  /** Ensure a component schema is materialized in its read form, returning its id. */
  private readModelId(schemaName: string): string {
    this.ensureModel(schemaName);
    return this.modelName(schemaName, 'read');
  }

  private writeModelId(schemaName: string, role: 'create' | 'update'): string {
    this.ensureModel(schemaName);
    const config = this.modelConfig(schemaName);
    if (config?.split === undefined) return this.modelName(schemaName, 'read');
    const id = this.modelName(schemaName, role);
    return this.types.has(id) ? id : this.modelName(schemaName, 'read');
  }

  private ensureModel(schemaName: string): void {
    if (this.builtModels.has(schemaName)) return;
    this.builtModels.add(schemaName);

    const raw = this.inspection.resolved.schemas.get(schemaName);
    if (raw === undefined) return;

    const config = this.modelConfig(schemaName);
    const readId = this.modelName(schemaName, 'read');
    const nameTokens = tokenizeName(readId, [], this.vocabulary);
    const docs = docsFrom(raw);
    const cyclic = this.cyclic.has(schemaName);
    const pointer = `#/components/schemas/${schemaName}`;

    // A named component schema is not necessarily an object. Reading only `properties` — as an
    // earlier version did — silently produced `export interface Member {}` for every schema
    // built from `allOf`, and dropped `oneOf` unions entirely. Both *typechecked*, because an
    // empty interface is legal TypeScript, so nothing caught it but reading the output.
    const composed = this.mergeAllOf(raw);
    const schema = composed ?? raw;

    const isUnion = getArray(raw, 'oneOf') !== undefined || getArray(raw, 'anyOf') !== undefined;
    const isEnum = (getArray(raw, 'enum') ?? []).length > 0;
    const hasProperties = Object.keys(getObject(schema, 'properties') ?? {}).length > 0;

    if (isUnion || isEnum || !hasProperties) {
      // Reserve the name first so a self-referential alias terminates, then convert. The
      // conversion registers any referenced variant types along the way.
      this.types.set(readId, {
        kind: 'alias',
        id: readId,
        name: { tokens: nameTokens },
        docs,
        target: { kind: 'unknown' },
        sourcePointer: pointer,
      });
      const target = this.toTypeRefUnnamed(schema, nameTokens);
      this.types.set(readId, {
        kind: 'alias',
        id: readId,
        name: { tokens: nameTokens },
        docs,
        target,
        sourcePointer: pointer,
      });
      return;
    }

    const extraRequired = new Set(config?.required ?? []);
    const serverOwned = new Set(config?.serverOwned ?? []);
    const excluded = new Set(config?.exclude ?? []);

    const declaredFields = this.fieldsOf(
      schema,
      tokenizeName(config?.rename ?? schemaName, ['response'], this.vocabulary),
      extraRequired,
    );

    // A config entry naming a field the schema does not have is almost always a typo, and it
    // fails in the worst way: silently. `serverOwned: [createdAt]` on a schema whose field is
    // `created` looks applied and does nothing, so the write model keeps a server-owned field.
    const present = new Set(declaredFields.map((field) => field.wireName));
    const unmatched: string[] = [];
    for (const [key, names] of [
      ['required', extraRequired],
      ['serverOwned', serverOwned],
      ['exclude', excluded],
    ] as const) {
      for (const name of names) {
        if (!present.has(name)) unmatched.push(`${key}: ${name}`);
      }
    }
    if (unmatched.length > 0) {
      this.diagnostics.push({
        severity: 'warn',
        code: DIAGNOSTIC_CODES.SPEC_VIOLATION_TOLERATED,
        message: `models.${schemaName} names ${unmatched.length} field${
          unmatched.length === 1 ? ' that does' : 's that do'
        } not exist on the schema.`,
        detail: [
          ...unmatched.map((entry) => `  ${entry}`),
          `Fields on ${schemaName}: ${[...present].slice(0, 10).join(', ')}${
            present.size > 10 ? ', …' : ''
          }`,
        ],
        sourcePointer: pointer,
      });
    }

    const allFields = declaredFields
      .filter((field) => !excluded.has(field.wireName))
      // Config union'd with the property-level extension, since either may declare it.
      .map((field) => ({
        ...field,
        serverOwned: field.serverOwned || serverOwned.has(field.wireName),
      }));

    const additional = this.additionalOf(schema, nameTokens);
    this.types.set(readId, {
      kind: 'object',
      id: readId,
      name: { tokens: nameTokens },
      docs,
      fields: allFields,
      ...(additional !== undefined ? { additional } : {}),
      role: config?.split !== undefined ? 'read' : 'shared',
      cyclic,
      sourcePointer: pointer,
    });

    if (config?.split === undefined) return;

    // Write models drop server-owned fields and anything read-only. This is the whole point of
    // the split: `assets.create({ _id })` must not typecheck.
    const writable = allFields.filter((field) => !field.serverOwned && !field.readOnly);
    for (const role of ['create', 'update'] as const) {
      const configured = role === 'create' ? config.split.create : config.split.update;
      if (configured === undefined) continue;
      this.types.set(configured, {
        kind: 'object',
        id: configured,
        name: { tokens: tokenizeName(configured, [], this.vocabulary) },
        docs,
        fields:
          // An update is a partial by convention: PATCH/PUT semantics let callers send a subset.
          role === 'update' ? writable.map((f) => ({ ...f, required: false })) : writable,
        ...(additional !== undefined ? { additional } : {}),
        role,
        cyclic,
        sourcePointer: pointer,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Resources and methods
  // -------------------------------------------------------------------------

  /**
   * Group operations into a resource tree.
   *
   * A dotted group name nests: `orgs.invoices` becomes `client.orgs.invoices`, which is how
   * every mainstream SDK models a sub-resource. Flattening it to `client.orgsInvoices` — as an
   * earlier version did — throws away structure the spec took the trouble to express.
   */
  private buildResources(): Resource[] {
    const groups = new Map<string, OperationView[]>();
    for (const op of this.inspection.index.operations) {
      // An extension asking for this to be left out is honoured before anything else is decided.
      if (op.ignored) continue;
      const raw = resourceGroupOf(op);
      const renamed = this.config.resources?.[raw] ?? raw;
      const list = groups.get(renamed) ?? [];
      list.push(op);
      groups.set(renamed, list);
    }

    // Build a tree keyed by path segment, creating intermediate nodes for a group like
    // `orgs.invoices` even when no operation belongs to `orgs` itself.
    interface Node {
      readonly segments: string[];
      operations: OperationView[];
      readonly children: Map<string, Node>;
    }
    const root: Node = { segments: [], operations: [], children: new Map() };

    const nodeAt = (segments: readonly string[]): Node => {
      let current = root;
      const walked: string[] = [];
      for (const segment of segments) {
        walked.push(segment);
        let next = current.children.get(segment);
        if (next === undefined) {
          next = { segments: [...walked], operations: [], children: new Map() };
          current.children.set(segment, next);
        }
        current = next;
      }
      return current;
    };

    for (const [name, operations] of groups) {
      nodeAt(name.split('.').filter((segment) => segment !== '')).operations = operations;
    }

    const toResource = (node: Node): Resource => {
      const id = node.segments.join('.');
      // The accessor name is the last segment only: `client.orgs.invoices`, not
      // `client.orgs.orgsInvoices`.
      const leaf = node.segments[node.segments.length - 1] ?? 'default';
      return {
        id,
        name: { tokens: tokenizeName(leaf, [], this.vocabulary) },
        docs: {},
        methods: this.disambiguateMethodNames(
          node.operations.map((op) => this.buildMethod(op, tokenizeName(leaf, [], this.vocabulary))),
        ),
        subresources: [...node.children.values()]
          .sort((a, b) => a.segments.join('.').localeCompare(b.segments.join('.')))
          .map(toResource),
      };
    };

    return [...root.children.values()]
      .sort((a, b) => a.segments.join('.').localeCompare(b.segments.join('.')))
      .map(toResource);
  }

  /**
   * Build a method.
   *
   * `resourceTokens` prefixes every synthesized name inside this method, so an inline request body
   * becomes `AccountUpdateRequest` rather than colliding with every other `UpdateRequest` in the
   * API. Twilio has ~50 update bodies; without the resource in the hint they numbered themselves
   * `UpdateRequest2` through `UpdateRequest9`.
   */
  private buildMethod(op: OperationView, resourceTokens: readonly string[] = []): Method {
    const methodTokens =
      op.methodName !== undefined ? tokenize(op.methodName, this.vocabulary) : this.deriveMethodName(op);
    // Hints for anything synthesized inside this method carry the resource for uniqueness; the
    // method's own name does not, since it is scoped to its class already.
    const hintTokens = [...resourceTokens, ...methodTokens];

    const params: Param[] = op.parameters
      // Hoisted constant headers must not appear in signatures (SPEC.md §3.1.2).
      .filter((p) => !(p.location === 'header' && this.hoistedHeaders.has(p.name)))
      .filter((p) => p.location === 'path' || p.location === 'query' || p.location === 'header' || p.location === 'cookie')
      .map((p) => ({
        name: { tokens: tokenizeName(p.name, [], this.vocabulary).length > 0 ? tokenizeName(p.name, [], this.vocabulary) : ['param'] },
        wireName: p.name,
        location: p.location as Param['location'],
        type: p.schema
          ? this.toTypeRef(p.schema, [...hintTokens, ...tokenizeName(p.name, [], this.vocabulary)])
          : { kind: 'unknown' },
        // A path parameter is always required regardless of what the spec says.
        required: p.location === 'path' ? true : p.required,
        deprecated: false,
        docs: p.description !== undefined ? { description: p.description } : {},
      }));

    const body = this.buildBody(op, hintTokens);
    const response = this.buildResponse(op, hintTokens);
    const paginationId = this.paginationIdFor(op);

    return {
      name: { tokens: methodTokens.length > 0 ? methodTokens : ['call'] },
      operationId: op.operationId ?? `${op.verb}${op.path}`,
      docs: {
        ...(op.summary !== undefined ? { summary: op.summary } : {}),
        ...(op.description !== undefined ? { description: op.description } : {}),
      },
      deprecated: op.deprecated,
      http: { verb: op.verb as Method['http']['verb'], path: op.path, params },
      ...(body !== undefined ? { body } : {}),
      response,
      ...(paginationId !== undefined ? { paginationId } : {}),
    };
  }

  /**
   * Fall back to a CRUD-ish name when no `x-*-method-name` is present.
   *
   * "Targets one instance" is decided by a path parameter in the **final segment**, not by the path
   * ending in one. Twilio's paths end in `.json` — `/Accounts/{Sid}.json` — so an end-anchored check
   * classified a fetch as a list, and `FetchAccount` then collided with `ListAccount`.
   */
  private deriveMethodName(op: OperationView): string[] {
    const segments = op.path.split('/').filter((segment) => segment !== '');
    const last = segments[segments.length - 1] ?? '';
    const targetsInstance = /\{[^}]+\}/.test(last);

    switch (op.verb) {
      case 'get':
        return targetsInstance ? ['get'] : ['list'];
      case 'post':
        // Many APIs — Twilio among them — use POST for updates. A POST at an instance path is an
        // update; at a collection path it creates.
        return targetsInstance ? ['update'] : ['create'];
      case 'put':
      case 'patch':
        return ['update'];
      case 'delete':
        return ['delete'];
      default:
        return tokenize(op.operationId ?? op.verb, this.vocabulary);
    }
  }

  /**
   * Give every method in a resource a distinct name.
   *
   * Even with good derivation two operations can land on one name, and a duplicate method is a
   * compile error rather than a cosmetic problem. Resolution is deterministic — sorted by
   * `operationId`, first keeps the short name — so output does not depend on traversal order.
   */
  private disambiguateMethodNames(methods: Method[]): Method[] {
    const byName = new Map<string, Method[]>();
    for (const method of methods) {
      const key = method.name.tokens.join('-');
      byName.set(key, [...(byName.get(key) ?? []), method]);
    }

    const renamed = new Map<string, Name>();
    for (const [, clashing] of byName) {
      if (clashing.length < 2) continue;
      const ordered = [...clashing].sort((a, b) => a.operationId.localeCompare(b.operationId));
      ordered.slice(1).forEach((method) => {
        // Fall back to the operationId, which the spec author made unique by definition.
        const tokens = tokenize(method.operationId, this.vocabulary);
        renamed.set(method.operationId, { tokens: tokens.length > 0 ? tokens : method.name.tokens });
        this.methodRenames.push(`${method.operationId} → ${tokens.join('-')}`);
      });
    }

    if (renamed.size === 0) return methods;
    return methods.map((method) => {
      const replacement = renamed.get(method.operationId);
      return replacement === undefined ? method : { ...method, name: replacement };
    });
  }

  private buildBody(op: OperationView, methodTokens: readonly string[]): Method['body'] {
    if (op.body === undefined || op.body.schema === undefined) return undefined;
    const schema = op.body.schema;

    // A body that refs a conflated schema uses the write model for this verb.
    const ref = getString(schema, '$ref');
    const refName = ref !== undefined ? componentSchemaName(ref) : undefined;
    if (refName !== undefined) {
      const role = op.verb === 'post' ? 'create' : 'update';
      return {
        type: { kind: 'named', id: this.writeModelId(refName, role) },
        contentType: op.body.contentType,
        required: op.body.required,
      };
    }

    return {
      type: this.toTypeRef(schema, [...methodTokens, 'request']),
      contentType: op.body.contentType,
      required: op.body.required,
    };
  }

  private buildResponse(op: OperationView, methodTokens: readonly string[]): Response {
    const success = op.responses.find(
      (r) => r.statusCode !== undefined && r.statusCode >= 200 && r.statusCode < 300,
    );
    if (success === undefined) return { kind: 'empty', statusCode: 200 };
    const statusCode = success.statusCode ?? 200;

    if (!success.hasContent) return { kind: 'empty', statusCode };
    const contentType = success.contentType ?? 'application/json';

    // Content type decides the shape of the result, and getting this wrong is very visible:
    // typing a CSV export as a `Blob` forces callers to unwrap something that was always text.
    if (/^text\/event-stream/i.test(contentType)) {
      return {
        kind: 'stream',
        statusCode,
        encoding: 'sse',
        event:
          success.schema !== undefined && success.hasTypedSchema
            ? this.toTypeRef(success.schema, [...methodTokens, 'event'])
            : { kind: 'unknown' },
      };
    }
    if (/^application\/(x-)?(ndjson|jsonl)/i.test(contentType)) {
      return {
        kind: 'stream',
        statusCode,
        encoding: 'jsonl',
        event:
          success.schema !== undefined && success.hasTypedSchema
            ? this.toTypeRef(success.schema, [...methodTokens, 'event'])
            : { kind: 'unknown' },
      };
    }

    if (success.schema === undefined || !success.hasTypedSchema) {
      return { kind: 'json', statusCode, type: { kind: 'unknown' } };
    }

    if (/\bjson\b/i.test(contentType)) {
      return {
        kind: 'json',
        statusCode,
        type: this.toTypeRef(success.schema, [...methodTokens, 'response']),
      };
    }
    // A textual body is a string; only genuinely opaque bytes become a Blob.
    if (/^text\//i.test(contentType)) return { kind: 'text', statusCode, contentType };
    return { kind: 'binary', statusCode, contentType };
  }

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  private paginationSchemes: PaginationScheme[] = [];

  /**
   * Webhooks the API sends, from whichever dialect the spec used.
   *
   * Three sources, in precedence order: OpenAPI 3.1's top-level `webhooks`, `x-webhooks` (what Fern,
   * Speakeasy, and Redocly all read), and `x-graft-webhooks`. Reading all three follows §3.1.5: another
   * tool's annotation still states the API owner's intent.
   *
   * 3.0's per-operation `callbacks` is deliberately *not* a source. It means something different — "this
   * operation may call you back at a URL you supplied" — where a webhook is "the API sends this to your
   * endpoint". Treating them as the same thing would put request-scoped callbacks on a client-level
   * `webhooks` accessor, which is a claim the spec did not make.
   *
   * Returns undefined when a spec declares none *and* configures no signature, so a target emits nothing
   * rather than an empty accessor.
   */
  private buildWebhooks(): Webhooks | undefined {
    const document = this.inspection.spec.document;
    const sources = [
      getObject(document, 'webhooks'),
      getObject(document, 'x-webhooks'),
      getObject(document, extensionKey('webhooks')),
    ].filter((entry): entry is JsonObject => entry !== undefined);

    const events: WebhookEvent[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      for (const [name, raw] of Object.entries(source)) {
        if (!isObject(raw) || seen.has(name)) continue;
        const event = this.webhookEvent(name, raw);
        if (event === undefined) continue;
        seen.add(name);
        events.push(event);
      }
    }
    const configured = this.config.webhooks?.signature;
    if (events.length === 0 && configured === undefined) return undefined;

    if (configured === undefined) {
      // Said out loud, because the failure mode of *not knowing* is accepting forged requests — and unlike
      // most gaps graft reports, nothing downstream will ever surface this one. `resolvedBy` names the key
      // that closes it, so `check --strict` can pass once it is set.
      this.diagnostics.push({
        code: DIAGNOSTIC_CODES.WEBHOOK_NO_SIGNATURE_SCHEME,
        severity: 'warn',
        message:
          `This API sends ${events.length} webhook${events.length === 1 ? '' : 's'}, but no signature ` +
          `scheme is configured — ` +
          `so the SDK cannot verify that a payload came from it. Typed events are still generated.`,
        resolvedBy: ['webhooks.signature'],
      });
    }

    events.sort((a, b) => a.name.localeCompare(b.name));
    return {
      events,
      ...(configured !== undefined ? { signature: configured } : {}),
    };
  }

  /** One webhook entry: the POST body's schema, named by the event. */
  private webhookEvent(name: string, entry: JsonObject): WebhookEvent | undefined {
    // The payload is on whichever method the provider uses; POST in practice, but reading whatever is
    // there costs nothing and a spec using PUT is not wrong.
    for (const verb of ['post', 'put', 'patch']) {
      const operation = getObject(entry, verb);
      if (operation === undefined) continue;
      const body = getObject(operation, 'requestBody');
      const content = body === undefined ? undefined : getObject(body, 'content');
      const json = content === undefined ? undefined : getObject(content, 'application/json');
      const schema = json === undefined ? undefined : getObject(json, 'schema');
      if (schema === undefined) continue;
      const tokens = tokenizeName(name, [], this.vocabulary);
      return {
        name,
        tokens: { tokens: tokens.length > 0 ? tokens : ['event'] },
        type: this.toTypeRef(schema, [...tokens, 'event']),
        docs: docsFrom(operation),
      };
    }
    return undefined;
  }

  private buildPagination(): PaginationScheme[] {
    return this.paginationSchemes;
  }

  private paginationIdFor(op: OperationView): string | undefined {
    const override = op.operationId !== undefined ? this.config.pagination?.operations?.[op.operationId] : undefined;
    if (override === 'none') return undefined;

    const spec = this.config.pagination?.default;
    if (spec === undefined) return undefined;

    // Config gives the shape; the spec must still corroborate that this is a collection.
    if (override !== 'default' && override === undefined) {
      const candidate = findPaginationCandidates(
        { ...this.inspection.index, operations: [op] },
        this.inspection.resolved.resolve,
      )[0];
      // An envelope counts as a collection: `{ data: [...], next_cursor }` is how most large
      // APIs page, and requiring a bare array would exclude all of them.
      if (candidate === undefined) return undefined;
      if (candidate.evidence !== 'array' && candidate.evidence !== 'envelope') return undefined;
    }

    const id = spec.style;
    if (!this.paginationSchemes.some((s) => s.id === id)) {
      // Only the parameters this style actually uses. An API may declare several paging
      // mechanisms — Twilio offers both `Page` and `PageToken` — and carrying an offset parameter
      // on a cursor scheme produces a config the runtime's own types reject.
      const offsetOnly = spec.style === 'offset';
      const pageOnly = spec.style === 'page';
      const cursorOnly = spec.style === 'cursor';

      this.paginationSchemes.push({
        id,
        style: spec.style,
        ...(spec.limit !== undefined ? { limitParam: spec.limit } : {}),
        ...(offsetOnly && spec.offset !== undefined ? { offsetParam: spec.offset } : {}),
        ...(pageOnly && spec.page !== undefined ? { pageParam: spec.page } : {}),
        ...(cursorOnly && spec.cursor !== undefined ? { cursorParam: spec.cursor } : {}),
        ...(cursorOnly && spec.cursorFrom !== undefined
          ? { cursorSource: this.valueSource(spec.cursorFrom) }
          : {}),
        ...(!cursorOnly && spec.total !== undefined
          ? { totalSource: this.valueSource(spec.total) }
          : {}),
        itemsSource: spec.items !== undefined ? this.valueSource(spec.items) : { kind: 'root' },
      });
    }
    return id;
  }

  private valueSource(spec: string) {
    const parsed = parseValueSource(spec);
    if (parsed.kind === 'header') return { kind: 'header' as const, name: parsed.name! };
    if (parsed.kind === 'body') return { kind: 'body' as const, path: parsed.path! };
    return { kind: 'root' as const };
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  private buildErrors(): ErrorTaxonomy {
    const config = this.config.errors;
    const statusesSeen = new Set<number>();
    for (const op of this.inspection.index.operations) {
      for (const response of op.responses) {
        if (response.statusCode !== undefined && response.statusCode >= 400) {
          statusesSeen.add(response.statusCode);
        }
      }
    }

    const defaultType =
      config?.default?.schema !== undefined
        ? this.shorthandType(config.default.schema, ['api', 'error', 'body'])
        : undefined;

    // A schema the spec actually declares for a status beats any configured default, and beats
    // nothing at all: an earlier version never converted error schemas, so a declared 422 shape
    // like `ValidationError` was silently dropped and the error stayed untyped.
    // Collect the raw schemas, converting only the ones actually used. Converting eagerly
    // registers a named type as a side effect, so an unused declared shape would still appear
    // in the emitted models — visible as a stray `Error401Body` beside the configured one.
    const declaredSchemas = new Map<number, JsonObject>();
    for (const op of this.inspection.index.operations) {
      for (const response of op.responses) {
        const status = response.statusCode;
        if (status === undefined || status < 400) continue;
        if (declaredSchemas.has(status)) continue;
        if (response.schema === undefined || !response.hasTypedSchema) continue;
        declaredSchemas.set(status, response.schema);
      }
    }
    const declaredType = (status: number): TypeRef | undefined => {
      const schema = declaredSchemas.get(status);
      return schema === undefined
        ? undefined
        : this.toTypeRef(schema, [`error${status}`, 'body']);
    };

    const byStatus = [...statusesSeen]
      .sort((a, b) => a - b)
      .map((statusCode) => {
        const override = config?.statuses?.[String(statusCode)];
        // Precedence is explicit config > spec inference (SPEC.md §3.1). Letting a declared
        // schema beat a configured default inverted that, and produced a second identical
        // error-body type alongside the configured one.
        const type =
          override?.schema !== undefined
            ? this.shorthandType(override.schema, [`error${statusCode}`, 'body'])
            : (defaultType ?? declaredType(statusCode));
        return {
          statusCode,
          name: { tokens: tokenizeName(override?.name ?? defaultErrorName(statusCode), [], this.vocabulary) },
          ...(type !== undefined ? { type } : {}),
          retryable: override?.retryable ?? isRetryableStatus(statusCode),
          docs: {},
        };
      });

    if (byStatus.length > 0 && defaultType === undefined && config?.default === undefined) {
      this.diagnostics.push({
        severity: 'warn',
        code: DIAGNOSTIC_CODES.ERROR_SCHEMA_MISSING,
        message: 'No error body shape is configured, so error bodies stay untyped.',
        fix: 'errors:\n  default: { schema: { error: string } }',
      });
    }

    return { ...(defaultType !== undefined ? { defaultType } : {}), byStatus };
  }

  private shorthandType(shape: Record<string, string>, nameHint: readonly string[]): TypeRef {
    const { id, tokens } = this.synthesizedName(nameHint);
    this.types.set(id, {
      kind: 'object',
      id,
      name: { tokens },
      docs: {},
      fields: expandShorthand(shape).map((field) => ({
        name: { tokens: tokenizeName(field.name, [], this.vocabulary) },
        wireName: field.name,
        type: field.type === 'unknown' ? { kind: 'unknown' } : { kind: 'primitive', type: field.type },
        required: field.required,
        serverOwned: false,
        readOnly: false,
        writeOnly: false,
        deprecated: false,
        docs: {},
      })),
      role: 'shared',
      cyclic: false,
    });
    return { kind: 'named', id };
  }

  // -------------------------------------------------------------------------

  /** Topologically order acyclic types so targets can emit without forward declarations. */
  private orderedTypes(): NamedType[] {
    const all = [...this.types.values()];
    const byId = new Map(all.map((t) => [t.id, t]));
    const visited = new Set<string>();
    const ordered: NamedType[] = [];

    const dependenciesOf = (type: NamedType): string[] => {
      const ids: string[] = [];
      const walk = (ref: TypeRef): void => {
        switch (ref.kind) {
          case 'named':
            ids.push(ref.id);
            return;
          case 'array':
            return walk(ref.items);
          case 'map':
            return walk(ref.values);
          case 'nullable':
            return walk(ref.inner);
          case 'union':
            ref.variants.forEach(walk);
            return;
          default:
            return;
        }
      };
      if (type.kind === 'object') {
        type.fields.forEach((f) => walk(f.type));
        if (type.additional) walk(type.additional);
      } else if (type.kind === 'alias') {
        walk(type.target);
      }
      return ids;
    };

    const visit = (id: string, stack: Set<string>): void => {
      if (visited.has(id) || stack.has(id)) return;
      const type = byId.get(id);
      if (type === undefined) return;
      stack.add(id);
      for (const dep of dependenciesOf(type)) visit(dep, stack);
      stack.delete(id);
      visited.add(id);
      ordered.push(type);
    };

    for (const type of all) visit(type.id, new Set());
    return ordered;
  }
}

/** Singularize the final token of a name hint, for array element types. */
function singularizeHint(hint: readonly string[], vocabulary?: ReadonlySet<string>): string[] {
  if (hint.length === 0) return ['item'];
  const last = hint[hint.length - 1]!;
  const singular = singularize(last, vocabulary);
  // Singularizing changed nothing, so the element name would collide with its container.
  if (singular === last) return [...hint, 'item'];

  // `ValidationError.errors` singularizes to `error`, duplicating its parent's leaf — which
  // yields either `Error` (shadowing the global) or `ErrorError`. `entry` names the element's
  // role instead, giving `ErrorEntry`, which is what a person would have written.
  const parent = hint[hint.length - 2];
  if (parent !== undefined && parent === singular) return [...hint.slice(0, -1), 'entry'];

  return [...hint.slice(0, -1), singular];
}

/**
 * Trailing words that describe the *document* rather than the product.
 *
 * `info.title: "Stripe API"` should yield `Stripe`, not `StripeAPI` — nobody writes
 * `new StripeAPI()`. Deliberately narrow: `Platform`, `Cloud`, and the like are plausibly part of
 * a brand, and renaming someone's product is worse than a slightly long class name they can
 * override in one line.
 */
const DOCUMENT_NOISE = /[\s_-]+(rest[\s_-]+)?(api|apis|openapi|specification|spec|service)$/i;

function stripDocumentNoise(title: string): string {
  const stripped = title.replace(DOCUMENT_NOISE, '').trim();
  return stripped === '' ? title.trim() : stripped;
}

/**
 * The environment-variable prefix every credential name is built on: `ACME_TOKEN`, `ACME_API_KEY`.
 *
 * Derived from the same title the client name is, so the two always agree — a client called `Acme`
 * reading `ACMEPLATFORM_TOKEN` would be a puzzle nobody should have to solve. Computed here rather
 * than in each target for the reason given on `AuthSchemeSchema`: six independent derivations are six
 * chances to disagree, and a mismatch only shows up when someone uses two of the SDKs.
 *
 * Non-alphanumerics collapse to a single underscore and a leading digit gains one, because an
 * environment variable name that a shell cannot express is worse than an ugly one. `override` wins
 * outright, for the case where the SDK's name and the company's existing variables differ.
 */
export function envPrefix(
  title: string,
  override: string | undefined,
  vocabulary: ReadonlySet<string>,
): string {
  if (override !== undefined && override !== '') return override;
  const tokens = tokenizeName(title, [], vocabulary);
  const joined = tokens.length > 0 ? tokens.join('_') : title;
  const sanitized = joined
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (sanitized === '') return 'SDK';
  return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

/**
 * Error class name for a status.
 *
 * The first block matches classes the hand-written runtime already provides. The second names the
 * rest of the standard statuses, because a spec that declares a 408 deserves a
 * `RequestTimeoutError` rather than `Status408Error` — targets generate a class for anything the
 * runtime does not supply.
 */
function defaultErrorName(status: number): string {
  const runtimeProvided: Record<number, string> = {
    400: 'BadRequestError',
    401: 'AuthenticationError',
    403: 'PermissionDeniedError',
    404: 'NotFoundError',
    409: 'ConflictError',
    422: 'UnprocessableEntityError',
    429: 'RateLimitError',
  };
  if (runtimeProvided[status] !== undefined) return runtimeProvided[status]!;

  const standard: Record<number, string> = {
    402: 'PaymentRequiredError',
    405: 'MethodNotAllowedError',
    406: 'NotAcceptableError',
    408: 'RequestTimeoutError',
    410: 'GoneError',
    412: 'PreconditionFailedError',
    413: 'PayloadTooLargeError',
    415: 'UnsupportedMediaTypeError',
    423: 'LockedError',
    428: 'PreconditionRequiredError',
    431: 'HeadersTooLargeError',
    451: 'UnavailableForLegalReasonsError',
    501: 'NotImplementedError',
    502: 'BadGatewayError',
    503: 'ServiceUnavailableError',
    504: 'GatewayTimeoutError',
  };
  if (standard[status] !== undefined) return standard[status]!;
  return status >= 500 ? 'InternalServerError' : `Status${status}Error`;
}

export function buildIR(inspection: Inspection, config: Config = {}): BuildResult {
  return new IRBuilder(inspection, config).build();
}

/**
 * Read a flow's declared scopes.
 *
 * Scopes are documentation for an SDK, not behaviour: the token request sends whatever the caller
 * asks for, and a server rejecting a scope is the server's answer to give. They are carried into the
 * IR so generated docs can list what is available.
 */
function scopesOf(flow: JsonObject): Array<{ name: string; description?: string }> {
  const declared = getObject(flow, 'scopes');
  if (declared === undefined) return [];
  return Object.entries(declared)
    .map(([name, description]) => ({
      name,
      ...(typeof description === 'string' && description !== '' ? { description } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
