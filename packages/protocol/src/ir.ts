/**
 * The graft semantic IR.
 *
 * This file is the public contract between the core and every target. See SPEC.md §3.2
 * (Semantic IR) and §3.5 (target protocol).
 *
 * Two invariants matter more than anything else here:
 *
 * 1. **This models SDK concepts, not HTTP.** There is no `Operation` type, no `Schema` type,
 *    no `$ref`. If a shape in this file could only be understood by someone holding the
 *    OpenAPI spec, it is wrong.
 *
 * 2. **Names are token sequences, never pre-formatted strings.** `["user", "id"]`, not
 *    `"userId"` or `"user_id"`. Casing is a target concern; a target that receives
 *    pre-cased names cannot be idiomatic. See {@link Name}.
 */

import { z } from 'zod';

/**
 * IR contract version. Targets declare the range they support at handshake time and a
 * mismatch is a hard error (SPEC.md §3.5) — so this must be bumped deliberately.
 *
 * Minor bump: additive, optional fields. Major bump: anything a target could crash on.
 */
export const IR_VERSION = '1.8.0';

// ---------------------------------------------------------------------------
// Names and documentation
// ---------------------------------------------------------------------------

/**
 * An identifier as an ordered sequence of lowercase word tokens.
 *
 * The whole point is that the target applies its own convention: `["user","id"]` becomes
 * `userId` in TypeScript, `user_id` in Python, `UserID` in Go. Storing a cased string here
 * would push a naming decision into the wrong layer.
 */
export const NameSchema = z.object({
  tokens: z.array(z.string().min(1)).min(1),
});
export type Name = z.infer<typeof NameSchema>;

export const DocsSchema = z.object({
  summary: z.string().optional(),
  description: z.string().optional(),
  /** Deprecation reason, when known. Presence does not imply deprecation; check the flag. */
  deprecationReason: z.string().optional(),
  externalUrl: z.string().optional(),
  /** Verbatim example from the spec, useful for docstrings. Untrusted shape. */
  example: z.unknown().optional(),
});
export type Docs = z.infer<typeof DocsSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const PrimitiveKindSchema = z.enum(['string', 'number', 'integer', 'boolean']);
export type PrimitiveKind = z.infer<typeof PrimitiveKindSchema>;

/**
 * Semantic refinement of a primitive. Targets map these to native types where one exists
 * (`date-time` → `Date`, `int64` → `bigint`/`int64`) and ignore the rest.
 */
export const PrimitiveFormatSchema = z.enum([
  'date-time',
  'date',
  'time',
  'duration',
  'uri',
  'uuid',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'byte',
  'int32',
  'int64',
  'float',
  'double',
  'password',
]);
export type PrimitiveFormat = z.infer<typeof PrimitiveFormatSchema>;

/**
 * A reference to a type. Recursive.
 *
 * Note what is *not* here: there is no `optional` variant. Presence and nullability are
 * distinct concerns and conflating them is the single most common source of bad generated
 * types (SPEC.md §3.1). Presence lives on {@link Field.required}; nullability lives here as
 * {@link NullableType}.
 */
export type TypeRef =
  | { kind: 'primitive'; type: PrimitiveKind; format?: PrimitiveFormat }
  /** `schema: {}` and friends. Targets must emit their `unknown`, never their `any`. */
  | { kind: 'unknown' }
  | { kind: 'null' }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'array'; items: TypeRef }
  | {
      kind: 'map';
      values: TypeRef;
      /**
       * Set when the wire protocol represents the *empty* map as something other than `{}`.
       * `'array'` means an empty map arrives as `[]` — the PHP serialization artifact
       * documented in SPEC.md §3.1.2 (`phpEmptyMap`).
       *
       * This is deliberately not a union. The runtime coerces; the user never branches.
       */
      emptyWireValue?: 'array';
    }
  /** Reference to a {@link NamedType} by its `id`. */
  | { kind: 'named'; id: string }
  /** The value may be `null`. Distinct from a field being absent. */
  | { kind: 'nullable'; inner: TypeRef }
  | { kind: 'binary' }
  | {
      kind: 'union';
      variants: TypeRef[];
      /**
       * Which keyword produced this union.
       *
       * `oneOf` means exactly one branch matches; `anyOf` means at least one. Recorded distinctly
       * because the spec said something, and a generator that discards what the spec said cannot
       * explain itself later — but validation treats them identically, because rejecting a value that
       * matches two branches would break clients of APIs whose schemas legitimately overlap
       * (SPEC.md §3.1.7).
       */
      combinator?: 'oneOf' | 'anyOf';
      /** Present when the spec supplied a usable `discriminator`. */
      discriminator?: { wireName: string; mapping: Record<string, string> };
      /**
       * `'scalar'` marks a union that exists only because the server is loose about
       * scalar encoding (`oneOf: [string, integer]`). The target decides whether to widen
       * or coerce; it is not a meaningful domain union. SPEC.md §3.1.2 (`scalarUnion`).
       */
      coercion?: 'scalar';
    };

export const TypeRefSchema: z.ZodType<TypeRef> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('primitive'),
      type: PrimitiveKindSchema,
      format: PrimitiveFormatSchema.optional(),
    }),
    z.object({ kind: z.literal('unknown') }),
    z.object({ kind: z.literal('null') }),
    z.object({
      kind: z.literal('literal'),
      value: z.union([z.string(), z.number(), z.boolean()]),
    }),
    z.object({ kind: z.literal('array'), items: TypeRefSchema }),
    z.object({
      kind: z.literal('map'),
      values: TypeRefSchema,
      emptyWireValue: z.literal('array').optional(),
    }),
    z.object({ kind: z.literal('named'), id: z.string().min(1) }),
    z.object({ kind: z.literal('nullable'), inner: TypeRefSchema }),
    z.object({ kind: z.literal('binary') }),
    z.object({
      kind: z.literal('union'),
      variants: z.array(TypeRefSchema).min(2),
      combinator: z.enum(['oneOf', 'anyOf']).optional(),
      discriminator: z
        .object({ wireName: z.string(), mapping: z.record(z.string(), z.string()) })
        .optional(),
      coercion: z.literal('scalar').optional(),
    }),
  ]),
);

// ---------------------------------------------------------------------------
// Named types
// ---------------------------------------------------------------------------

export const FieldSchema = z.object({
  name: NameSchema,
  /** Exact key on the wire. Never derive this from `name` — `_id` does not round-trip. */
  wireName: z.string(),
  type: TypeRefSchema,
  /** Whether the key is guaranteed present. Orthogonal to nullability; see {@link TypeRef}. */
  required: z.boolean(),
  /**
   * Assigned by the server, so it must not appear in write models. Drives `readWriteSplit`
   * (SPEC.md §3.1.1) and is the difference between `assets.create({...})` being usable or
   * nonsense.
   */
  serverOwned: z.boolean(),
  readOnly: z.boolean(),
  writeOnly: z.boolean(),
  deprecated: z.boolean(),
  docs: DocsSchema,
});
export type Field = z.infer<typeof FieldSchema>;

/**
 * Which side of a read/write split a model represents. `shared` means the normalizer found
 * no reason to split it. SPEC.md §3.1.1.
 */
export const ModelRoleSchema = z.enum(['shared', 'read', 'create', 'update']);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

const NamedTypeBase = {
  /** Stable key targeted by `{ kind: 'named', id }`. */
  id: z.string().min(1),
  name: NameSchema,
  docs: DocsSchema,
  /** JSON pointer into the source spec. For diagnostics and traceability only. */
  sourcePointer: z.string().optional(),
};

export const ObjectTypeSchema = z.object({
  ...NamedTypeBase,
  kind: z.literal('object'),
  fields: z.array(FieldSchema),
  /** Open map of additional keys, when the spec declares `additionalProperties`. */
  additional: TypeRefSchema.optional(),
  role: ModelRoleSchema,
  /**
   * True when this type participates in a reference cycle. Targets that must break cycles
   * (forward declarations, boxed pointers) need to know without recomputing the graph.
   */
  cyclic: z.boolean(),
});

export const EnumTypeSchema = z.object({
  ...NamedTypeBase,
  kind: z.literal('enum'),
  members: z.array(
    z.object({
      name: NameSchema,
      wireValue: z.union([z.string(), z.number()]),
      docs: DocsSchema,
    }),
  ),
  /**
   * True when the server may send values outside `members`. Targets should keep the type
   * open (union with `string`) rather than risk a decode failure on a new server value.
   */
  open: z.boolean(),
});

export const AliasTypeSchema = z.object({
  ...NamedTypeBase,
  kind: z.literal('alias'),
  target: TypeRefSchema,
});

export const NamedTypeSchema = z.discriminatedUnion('kind', [
  ObjectTypeSchema,
  EnumTypeSchema,
  AliasTypeSchema,
]);
export type ObjectType = z.infer<typeof ObjectTypeSchema>;
export type EnumType = z.infer<typeof EnumTypeSchema>;
export type AliasType = z.infer<typeof AliasTypeSchema>;
export type NamedType = z.infer<typeof NamedTypeSchema>;

// ---------------------------------------------------------------------------
// Values sourced from the wire
// ---------------------------------------------------------------------------

/**
 * Where a piece of protocol metadata lives on the wire. Used for pagination plumbing —
 * a total count in a response header, a cursor nested in the body, items at the root.
 */
export const ValueSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('header'), name: z.string() }),
  z.object({ kind: z.literal('body'), path: z.array(z.string()) }),
  /** The response body itself, e.g. a bare JSON array of items. */
  z.object({ kind: z.literal('root') }),
]);
export type ValueSource = z.infer<typeof ValueSourceSchema>;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const PaginationSchemeSchema = z.object({
  id: z.string().min(1),
  style: z.enum(['offset', 'cursor', 'page']),
  limitParam: z.string().optional(),
  offsetParam: z.string().optional(),
  pageParam: z.string().optional(),
  cursorParam: z.string().optional(),
  /** Where the *next* cursor is read from the response. */
  cursorSource: ValueSourceSchema.optional(),
  /** Where the total record count is read from, when the API provides one. */
  totalSource: ValueSourceSchema.optional(),
  /** Where the page's items live. */
  itemsSource: ValueSourceSchema,
});
export type PaginationScheme = z.infer<typeof PaginationSchemeSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The error taxonomy.
 *
 * Frequently this cannot be derived from the spec at all — in the first corpus entry, 186
 * of 193 error responses declare no schema (SPEC.md §7). So this is largely populated from
 * the config overlay, and a target must behave sanely when `type` is absent everywhere.
 */
export const ErrorTaxonomySchema = z.object({
  /** Shape used for any status without a specific entry. */
  defaultType: TypeRefSchema.optional(),
  byStatus: z.array(
    z.object({
      statusCode: z.number().int(),
      /** Class/exception name to generate, e.g. `["not","found","error"]`. */
      name: NameSchema,
      type: TypeRefSchema.optional(),
      /** Whether the runtime should retry this status by default. */
      retryable: z.boolean(),
      docs: DocsSchema,
    }),
  ),
});
export type ErrorTaxonomy = z.infer<typeof ErrorTaxonomySchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * A supported authentication scheme. `Service.auth` is a list of *alternatives* — the first
 * corpus entry accepts Bearer or Basic — so the generated client must let the caller pick.
 *
 * Every `*EnvVar` field names the environment variable a target reads when the caller supplies no
 * explicit credential. They are populated by the core rather than derived per target, because six
 * targets deriving the same name independently is six chances to disagree — and a client that reads
 * `ACME_TOKEN` in TypeScript and `ACMEPLATFORM_TOKEN` in Python is a support ticket. Always present
 * in practice; optional in the schema so an IR hand-written for a test need not supply them.
 */
export const AuthSchemeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bearer'),
    id: z.string(),
    /** Documented token prefix, e.g. `pat_`. Useful in docs; never enforced. */
    tokenPrefix: z.string().optional(),
    envVar: z.string().optional(),
    docs: DocsSchema,
  }),
  z.object({
    kind: z.literal('basic'),
    id: z.string(),
    usernameEnvVar: z.string().optional(),
    passwordEnvVar: z.string().optional(),
    docs: DocsSchema,
  }),
  z.object({
    kind: z.literal('apiKey'),
    id: z.string(),
    location: z.enum(['header', 'query', 'cookie']),
    wireName: z.string(),
    envVar: z.string().optional(),
    docs: DocsSchema,
  }),
  /**
   * OAuth2, restricted to the flows an SDK can honestly own (SPEC.md §3.1.6).
   *
   * `clientCredentials` is machine-to-machine and entirely the SDK's job. `refreshToken` means the
   * caller obtained a token elsewhere — through an authorization-code redirect the SDK cannot
   * perform — and wants the SDK to keep it fresh. Neither the redirect itself nor the deprecated
   * implicit and password flows are modelled: a spec declaring them yields a bearer option instead,
   * because that is the only interface an SDK can offer without lying about what it does.
   */
  z.object({
    kind: z.literal('oauth2'),
    id: z.string(),
    flow: z.enum(['clientCredentials', 'refreshToken']),
    /** Absolute or spec-relative URL the token is requested from. */
    tokenUrl: z.string(),
    /** Where a refresh is sent, when it differs from `tokenUrl`. */
    refreshUrl: z.string().optional(),
    scopes: z.array(z.object({ name: z.string(), description: z.string().optional() })),
    /** Read for the `clientCredentials` flow. */
    clientIdEnvVar: z.string().optional(),
    /** Read for the `clientCredentials` flow. */
    clientSecretEnvVar: z.string().optional(),
    /** Read for the `refreshToken` flow. Added in IR 1.6.0. */
    refreshTokenEnvVar: z.string().optional(),
    docs: DocsSchema,
  }),
]);
export type AuthScheme = z.infer<typeof AuthSchemeSchema>;

// ---------------------------------------------------------------------------
// Resources and methods
// ---------------------------------------------------------------------------

export const ParamSchema = z.object({
  name: NameSchema,
  wireName: z.string(),
  location: z.enum(['path', 'query', 'header', 'cookie']),
  type: TypeRefSchema,
  required: z.boolean(),
  deprecated: z.boolean(),
  docs: DocsSchema,
  /** Array serialization style, when it differs from the target's default. */
  explode: z.boolean().optional(),
});
export type Param = z.infer<typeof ParamSchema>;

export const HttpVerbSchema = z.enum(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
export type HttpVerb = z.infer<typeof HttpVerbSchema>;

export const ResponseSchema = z.discriminatedUnion('kind', [
  /** 204 and friends — no body to model. */
  z.object({ kind: z.literal('empty'), statusCode: z.number().int() }),
  z.object({
    kind: z.literal('json'),
    statusCode: z.number().int(),
    type: TypeRefSchema,
  }),
  /**
   * A textual body that is not JSON — `text/csv`, `text/plain`. Distinct from `binary` because
   * the idiomatic result is a string, and distinct from `json` because there is nothing to
   * decode. Added in IR 1.1.0 after `text/csv` was being typed as a `Blob`.
   */
  z.object({
    kind: z.literal('text'),
    statusCode: z.number().int(),
    contentType: z.string(),
  }),
  z.object({
    kind: z.literal('binary'),
    statusCode: z.number().int(),
    contentType: z.string().optional(),
  }),
  z.object({
    kind: z.literal('stream'),
    statusCode: z.number().int(),
    encoding: z.enum(['sse', 'jsonl']),
    event: TypeRefSchema,
  }),
]);
export type Response = z.infer<typeof ResponseSchema>;

export const RequestBodySchema = z.object({
  type: TypeRefSchema,
  contentType: z.string(),
  required: z.boolean(),
});
export type RequestBody = z.infer<typeof RequestBodySchema>;

/**
 * Plausible values for one operation, so every target's example and test shows the same data.
 *
 * Language-neutral by design (SPEC.md §3.11): the *choice* of value — the spec's own `example`, the first
 * enum member, required fields in preference to optional ones — is a judgment shared by every language,
 * while rendering it is not. Synthesizing it per target would put one decision in six places and make
 * divergence invisible: a Python example using a different enum member than the TypeScript one is not a
 * test failure, it is two documents quietly disagreeing about the same API.
 *
 * Keys in `params` are wire names, not tokens, because that is what identifies a parameter unambiguously;
 * a target cases them for its own signature. `body` and `response` are JSON as it would appear on the
 * wire, so a generated test can assert against them without re-encoding.
 */
export const MethodExampleSchema = z.object({
  /** Keyed by wire name, covering path parameters and required query and header parameters. */
  params: z.record(z.string(), z.unknown()),
  /** Absent when the operation takes no body. */
  body: z.unknown().optional(),
  /**
   * A response body matching `Method.response`, or absent when there is nothing to decode — an empty,
   * binary, or streamed response. For a paginated method this is one page, envelope included, because a
   * test that fed the bare item array would exercise a shape the API never returns.
   */
  response: z.unknown().optional(),
});
export type MethodExample = z.infer<typeof MethodExampleSchema>;

export const MethodSchema = z.object({
  name: NameSchema,
  /** Original `operationId`. Kept for traceability and snapshot stability, not for naming. */
  operationId: z.string(),
  docs: DocsSchema,
  deprecated: z.boolean(),
  http: z.object({
    verb: HttpVerbSchema,
    /** Template form, e.g. `/assets/{id}`. Params are in `params`, not parsed from here. */
    path: z.string(),
    params: z.array(ParamSchema),
  }),
  body: RequestBodySchema.optional(),
  response: ResponseSchema,
  /** Reference into `IR.pagination` when this method is pageable. */
  paginationId: z.string().optional(),
  /**
   * Synthesized example data for this operation. Added in IR 1.7.0.
   *
   * Optional so an IR hand-written for a test need not supply it, and so a target may ignore it — but the
   * core always populates it, because a target that has to decide whether values exist ends up
   * synthesizing its own.
   */
  example: MethodExampleSchema.optional(),
});
export type Method = z.infer<typeof MethodSchema>;

export type Resource = {
  id: string;
  name: Name;
  docs: Docs;
  methods: Method[];
  subresources: Resource[];
};

export const ResourceSchema: z.ZodType<Resource> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    name: NameSchema,
    docs: DocsSchema,
    methods: z.array(MethodSchema),
    subresources: z.array(ResourceSchema),
  }),
);

// ---------------------------------------------------------------------------
// Service and the IR root
// ---------------------------------------------------------------------------

/**
 * A variable in a templated server URL. Added in IR 1.5.0.
 *
 * ```yaml
 * servers:
 *   - url: https://{region}.api.example.com/{version}
 *     variables:
 *       region: { default: us-east-1, enum: [us-east-1, eu-west-1] }
 * ```
 *
 * `default` is required by OpenAPI, which is what makes `Server.url` safe to resolve — a target that
 * ignores variables entirely still gets a URL that resolves, rather than one containing braces.
 */
export const ServerVariableSchema = z.object({
  /** The name as it appears between braces in the URL. */
  wireName: z.string(),
  /** Tokenized, so casing stays each target's decision. */
  name: NameSchema,
  default: z.string(),
  /**
   * Permitted values, when the spec listed them.
   *
   * Kept because a target can render them as a union rather than a bare string: the author said what
   * the valid regions are, and discarding that would leave a caller guessing at a hostname.
   */
  enum: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type ServerVariable = z.infer<typeof ServerVariableSchema>;

export const ServerSchema = z.object({
  id: z.string(),
  /**
   * The base URL with every variable replaced by its default.
   *
   * Resolved here rather than left templated so that a target which knows nothing about variables
   * still produces a working SDK. graft previously passed the template through untouched, and every
   * request went to a host containing literal braces, which does not resolve.
   */
  url: z.string(),
  /**
   * The template as written, when it had variables. Absent when `url` needed no substitution.
   *
   * Kept alongside the resolved URL because a target that *does* expose variables needs the shape to
   * re-substitute into, and deriving it back from `url` is impossible once the defaults are in.
   */
  urlTemplate: z.string().optional(),
  variables: z.array(ServerVariableSchema).optional(),
  description: z.string().optional(),
  default: z.boolean(),
});
export type Server = z.infer<typeof ServerSchema>;

export const ServiceSchema = z.object({
  name: NameSchema,
  /**
   * The service name with the author's own casing preserved, e.g. `OpenAI`, `IBM Cloud`.
   *
   * `name.tokens` is lowercase by contract, so mechanically re-casing it yields `OpenAi` and
   * `IbmCloud` — losing an initialism the author spelled correctly. Targets should prefer this
   * when it already forms a valid identifier in their language, and fall back to casing the
   * tokens otherwise. Added in IR 1.2.0.
   */
  displayName: z.string().optional(),
  version: z.string(),
  docs: DocsSchema,
  servers: z.array(ServerSchema),
  /** Alternatives, not a conjunction. See {@link AuthSchemeSchema}. */
  auth: z.array(AuthSchemeSchema),
  /**
   * Headers the runtime must send on every request, hoisted out of method signatures by
   * `constHeaderHoist` (SPEC.md §3.1.2). The first corpus entry declares an `Accept` header
   * parameter on all 121 operations; without hoisting it pollutes all 121 signatures.
   */
  constantHeaders: z.record(z.string(), z.string()),
});
export type Service = z.infer<typeof ServiceSchema>;

/**
 * Webhooks the API sends, and how it signs them (SPEC.md §3.4.1.3).
 *
 * Two halves that are different in kind. `events` is ordinary generation — an event name plus a body
 * schema, which is a named type plus a key. `signature` is a *descriptor for a hand-written verifier*,
 * because a generated HMAC comparison is short, security-critical, and has three ways to be subtly wrong.
 *
 * `signature` is absent unless configured. OpenAPI has no field describing a signature scheme, so graft
 * cannot infer one — and a `verify()` returning true because it checked something meaningless is strictly
 * worse than its absence.
 */
export const WebhookEventSchema = z.object({
  /** The event name as the provider sends it, e.g. `invoice.paid`. */
  name: z.string().min(1),
  /** Method-safe token sequence for the name, so targets can case it. */
  tokens: NameSchema,
  /** The event payload's declared shape. */
  type: TypeRefSchema,
  docs: DocsSchema,
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

export const WebhookSignatureSchema = z.object({
  algorithm: z.enum(['sha256', 'sha1', 'sha512']),
  header: z.string().min(1),
  format: z.enum(['bare', 'prefixed', 'structured']),
  prefix: z.string().optional(),
  signatureKey: z.string().optional(),
  timestampKey: z.string().optional(),
  timestampHeader: z.string().optional(),
  encoding: z.enum(['hex', 'base64']),
  signedTemplate: z.string(),
  toleranceSeconds: z.number().int().nonnegative(),
});
export type WebhookSignature = z.infer<typeof WebhookSignatureSchema>;

export const WebhooksSchema = z.object({
  events: z.array(WebhookEventSchema),
  signature: WebhookSignatureSchema.optional(),
});
export type Webhooks = z.infer<typeof WebhooksSchema>;

export const IRSchema = z.object({
  irVersion: z.string(),
  service: ServiceSchema,
  /** Deduplicated and topologically ordered where acyclic; cycles flagged on the type. */
  types: z.array(NamedTypeSchema),
  resources: z.array(ResourceSchema),
  errors: ErrorTaxonomySchema,
  pagination: z.array(PaginationSchemeSchema),
  /**
   * Webhooks, when the spec declares any. Added in IR 1.8.0.
   *
   * Optional so an IR hand-written for a test need not supply it, and absent entirely for the many specs
   * that declare no webhooks — a target then emits nothing, which is correct.
   */
  webhooks: WebhooksSchema.optional(),
});
export type IR = z.infer<typeof IRSchema>;

/** Parse and validate an IR document, throwing on any deviation from the contract. */
export function parseIR(value: unknown): IR {
  return IRSchema.parse(value);
}
