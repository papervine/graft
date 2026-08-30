/**
 * `graft.yaml` — the config overlay.
 *
 * This is a primary user-facing surface, not a patch kit (SPEC.md "Enrichment, not just
 * translation"). Most of what makes output good on a real spec is expressed here, so the
 * format is optimized for being *hand-written and reviewed in a PR*:
 *
 *   - Shorthand where it reads better (`{ error: string }` over a nested schema object).
 *   - Every key optional, so a partial config is valid and users can adopt it incrementally.
 *   - Unknown keys are an error, not ignored — a typo'd key that silently does nothing is
 *     worse than a failed run, because the user believes they fixed something.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * A field type in shorthand. `string`, `integer`, `boolean`, `number`, `unknown`, and any of
 * those with a trailing `?` to mean "not required".
 */
const ShorthandType = z
  .string()
  .regex(
    /^(string|integer|number|boolean|unknown)\??$/,
    'expected one of string, integer, number, boolean, unknown (optionally suffixed with ?)',
  );

/** `{ error: string, code: integer? }` — an object declared inline. */
const ShorthandObject = z.record(z.string().min(1), ShorthandType);
export type ShorthandObject = z.infer<typeof ShorthandObject>;

const ErrorShapeSchema = z.object({
  schema: ShorthandObject.optional(),
});

const ErrorStatusSchema = z.object({
  /** Error class name to generate. Defaults to a name derived from the status code. */
  name: z.string().optional(),
  schema: ShorthandObject.optional(),
  retryable: z.boolean().optional(),
});

const ErrorsConfigSchema = z
  .object({
    /** Shape used for any status without its own entry. */
    default: ErrorShapeSchema.optional(),
    statuses: z.record(z.string().regex(/^\d{3}$/), ErrorStatusSchema).optional(),
  })
  .strict();

/**
 * `header:X-Content-Range`, `body:meta.total`, or `root`. A string rather than a nested object
 * because it appears inline constantly and the nested form is noisier to read.
 */
const ValueSourceSpec = z
  .string()
  .regex(
    /^(root|header:[A-Za-z0-9-]+|body:[A-Za-z0-9_.-]+)$/,
    'expected `root`, `header:<Name>`, or `body:<dotted.path>`',
  );

const PaginationSpecSchema = z
  .object({
    style: z.enum(['offset', 'cursor', 'page']),
    limit: z.string().optional(),
    offset: z.string().optional(),
    page: z.string().optional(),
    cursor: z.string().optional(),
    cursorFrom: ValueSourceSpec.optional(),
    total: ValueSourceSpec.optional(),
    items: ValueSourceSpec.optional(),
  })
  .strict();
export type PaginationSpec = z.infer<typeof PaginationSpecSchema>;

const PaginationConfigSchema = z
  .object({
    default: PaginationSpecSchema.optional(),
    /**
     * Per-operation override keyed by `operationId`. `none` disables pagination for an
     * operation that merely accepts paging parameters — the `reindex`-style false positives
     * in SPEC.md §7.
     */
    operations: z.record(z.string().min(1), z.union([z.literal('none'), z.literal('default'), PaginationSpecSchema])).optional(),
  })
  .strict();

const ModelSplitSchema = z
  .object({
    read: z.string().optional(),
    create: z.string().optional(),
    update: z.string().optional(),
  })
  .strict();

const ModelConfigSchema = z
  .object({
    /** Rename the type. `AssetsResponse` → `Asset`. */
    rename: z.string().optional(),
    /** Split a request/response-conflated schema into distinct models (SPEC.md §3.1.1). */
    split: ModelSplitSchema.optional(),
    /** Fields the server assigns; omitted from write models. */
    serverOwned: z.array(z.string()).optional(),
    /** Fields to treat as always present, overriding an absent `required` in the spec. */
    required: z.array(z.string()).optional(),
    /** Fields to drop from generated output entirely. */
    exclude: z.array(z.string()).optional(),
  })
  .strict();
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

const NormalizeConfigSchema = z
  .object({
    /** Collapse `oneOf: [object, array maxItems:0]` to a map. SPEC.md §3.1.2. */
    phpEmptyMap: z.boolean().optional(),
    /** How to handle `oneOf` of bare scalars. */
    scalarUnion: z.enum(['widen', 'coerce', 'keep']).optional(),
    /** Hoist constant header params into runtime defaults. */
    constHeaderHoist: z.boolean().optional(),
  })
  .strict();

const TargetConfigSchema = z
  .object({
    out: z.string().min(1),
    packageName: z.string().optional(),
    /**
     * How to run the target, when it is not `graft-target-<name>` on `PATH`.
     *
     * An argv array, so no shell is involved and a path containing a space needs no quoting. It is
     * the escape hatch for a target that lives in a virtualenv, a monorepo checkout, or behind a
     * launcher (`["uv", "run", "graft-target-python"]`). Resolution order is this key, then an
     * installed `@graft/target-<name>` package, then `PATH`.
     */
    command: z.array(z.string().min(1)).min(1).optional(),
    /**
     * How strictly generated SDKs enforce that responses match the declared shape.
     *
     * `strict` (the default) throws naming the offending field; `warn` logs and continues; `off`
     * skips the check. Strict is the default because a missing required field crashes the caller
     * either way — the only question is whether they learn it at the SDK boundary with the API's own
     * violation named, or three frames later in their own code (SPEC.md §3.4.1.1).
     *
     * A per-call override is always available on the generated client, so this only sets the default.
     */
    validation: z.enum(['strict', 'warn', 'off']).optional(),
    /**
     * Header the API expects an idempotency key in. Defaults to `Idempotency-Key`.
     *
     * Configurable because it is not standardised — `Idempotency-Key`, `X-Idempotency-Key`, and
     * `Idempotency-Token` are all in real use. Supplying a key is what makes a `POST` or `PATCH`
     * retryable at all (SPEC.md §3.4.0.1).
     */
    idempotencyHeader: z.string().min(1).optional(),
  })
  .passthrough(); // target-specific keys are opaque to the core (SPEC.md §3.7)

/**
 * How a provider signs webhook requests, as a descriptor rather than generated code (SPEC.md §3.4.1.3).
 *
 * Same argument as response validation: the varying part is data, and one hand-written interpreter of that
 * data is more trustworthy than N generated verifiers of security-critical crypto. The variation across
 * every real provider fits in these fields — Stripe, GitHub, Slack, and Shopify differ only here.
 */
const WebhookSignatureSchema = z
  .object({
    /** HMAC algorithm. `sha256` covers every provider surveyed. */
    algorithm: z.enum(['sha256', 'sha1', 'sha512']).default('sha256'),
    /** Header carrying the signature, e.g. `Stripe-Signature`. */
    header: z.string().min(1),
    /**
     * How to read the signature out of the header value.
     *
     * `bare` is the whole value (Shopify). `prefixed` strips a fixed prefix (`sha256=`, GitHub).
     * `structured` parses `k=v` pairs and reads the key named by `signatureKey` (Stripe's `t=…,v1=…`).
     */
    format: z.enum(['bare', 'prefixed', 'structured']).default('bare'),
    /** The prefix to strip, for `prefixed`. */
    prefix: z.string().optional(),
    /** The pair to read the signature from, for `structured`. Defaults to `v1`. */
    signatureKey: z.string().optional(),
    /** The pair carrying the timestamp, for `structured`. Defaults to `t`. */
    timestampKey: z.string().optional(),
    /** A separate header carrying the timestamp, as Slack uses. */
    timestampHeader: z.string().optional(),
    /** Hex or base64, as the provider encodes the digest. */
    encoding: z.enum(['hex', 'base64']).default('hex'),
    /**
     * What is signed, with `{body}` and `{timestamp}` substituted.
     *
     * Defaults to `{body}`. Stripe signs `{timestamp}.{body}`, Slack `v0:{timestamp}:{body}`.
     */
    signedTemplate: z.string().default('{body}'),
    /**
     * How old a request may be, in seconds. Zero disables the check.
     *
     * Not optional-by-omission: without a tolerance a captured request stays valid forever, which makes
     * the signature a bearer token rather than a proof of freshness. Five minutes is what Stripe and
     * Slack both use.
     */
    toleranceSeconds: z.number().int().nonnegative().default(300),
  })
  .strict();

const WebhooksConfigSchema = z
  .object({
    signature: WebhookSignatureSchema.optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    /** Path to the OpenAPI spec, relative to the config file. */
    spec: z.string().min(1).optional(),
    /** Service name override. Defaults to `info.title`. */
    name: z.string().optional(),
    /**
     * Prefix for the environment variables generated clients read credentials from — `ACME` gives
     * `ACME_TOKEN`, `ACME_API_KEY`. Defaults to the client name in SCREAMING_SNAKE_CASE.
     *
     * Separate from `name` because an organisation's existing variables rarely match the SDK's class
     * name, and renaming the class to match the variables would be the wrong end of the problem.
     */
    envPrefix: z
      .string()
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        'must be usable as an environment variable name: letters, digits, and underscores, not starting with a digit',
      )
      .optional(),
    targets: z.record(z.string().min(1), TargetConfigSchema).optional(),
    /** Webhook handling. See SPEC.md §3.4.1.3. */
    webhooks: WebhooksConfigSchema.optional(),
    errors: ErrorsConfigSchema.optional(),
    pagination: PaginationConfigSchema.optional(),
    models: z.record(z.string().min(1), ModelConfigSchema).optional(),
    normalize: NormalizeConfigSchema.optional(),
    headers: z
      .object({ constant: z.record(z.string().min(1), z.string()).optional() })
      .strict()
      .optional(),
    /** Rename resource groups. Key is the group name from the spec. */
    resources: z.record(z.string().min(1), z.string()).optional(),
    preserve: z
      .object({
        /**
         * Files graft must never write. Gitignore-style globs, relative to the output directory.
         * `.graftignore` in the output directory is read as well.
         */
        files: z.array(z.string().min(1)).optional(),
        /**
         * Carry `#region` marked blocks inside generated files across regeneration, so a custom
         * method can live on the generated class instead of a subclass.
         *
         * **Defaults to true.** Set `false` only to opt out. Every target emits these markers whether
         * or not this is set, so a default of off meant the generated file invited a custom method and
         * the next run silently deleted it (SPEC.md §3.9).
         */
        regions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    naming: z
      .object({
        /**
         * Extra words used to split all-lowercase compounds, e.g. adding `clerk` turns
         * `syncclerk` into `syncClerk`. Merged with graft's built-in vocabulary.
         */
        words: z.array(z.string().min(2)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const EMPTY_CONFIG: Config = {};

/** Parse config from text. Strict: an unknown key is an error, never silently ignored. */
export function parseConfig(contents: string, source: string): Config {
  let raw: unknown;
  try {
    raw = parseYaml(contents, { merge: true });
  } catch (cause) {
    throw new ConfigError(
      `${source}: could not be parsed as YAML\n  ${
        cause instanceof Error ? cause.message.split('\n')[0] : String(cause)
      }`,
      source,
    );
  }
  if (raw === null || raw === undefined) return EMPTY_CONFIG;

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  ${path}: ${issue.message}`;
    });
    throw new ConfigError(`${source}: invalid config\n${lines.join('\n')}`, source);
  }
  return result.data;
}

export async function loadConfig(path: string): Promise<Config> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(
      `${path}: could not be read\n  ${cause instanceof Error ? cause.message : String(cause)}`,
      path,
    );
  }
  return parseConfig(contents, path);
}

// ---------------------------------------------------------------------------
// Shorthand expansion
// ---------------------------------------------------------------------------

export interface ShorthandField {
  readonly name: string;
  readonly type: 'string' | 'integer' | 'number' | 'boolean' | 'unknown';
  readonly required: boolean;
}

/** Expand `{ error: string, code: 'integer?' }` into field descriptors. */
export function expandShorthand(shape: ShorthandObject): ShorthandField[] {
  return Object.entries(shape).map(([name, spec]) => {
    const optional = spec.endsWith('?');
    const type = (optional ? spec.slice(0, -1) : spec) as ShorthandField['type'];
    return { name, type, required: !optional };
  });
}

export interface ParsedValueSource {
  readonly kind: 'root' | 'header' | 'body';
  readonly name?: string;
  readonly path?: string[];
}

/** Parse `header:X-Total`, `body:meta.total`, or `root`. */
export function parseValueSource(spec: string): ParsedValueSource {
  if (spec === 'root') return { kind: 'root' };
  if (spec.startsWith('header:')) return { kind: 'header', name: spec.slice('header:'.length) };
  return { kind: 'body', path: spec.slice('body:'.length).split('.') };
}
