/**
 * Generated documentation: README, API reference, and runnable examples.
 *
 * The governing rule for **examples**: they are emitted into the typecheck gate, so a renamed
 * method or a changed signature makes generation fail rather than shipping a snippet that lies.
 * Documentation that is not verified is worse than none — a plausible-but-wrong example teaches
 * the wrong thing confidently, which is precisely the failure mode this project keeps hitting
 * (SPEC.md §7).
 *
 * The second rule: **never invent data that looks real.** Values come from the spec's own
 * `example:` fields where present; everywhere else the placeholder is obviously a placeholder.
 * A fabricated-looking id in a code sample gets copied into production.
 *
 * Markdown is assembled as text rather than through a builder: prose is the artifact here, and
 * the "ASTs, never templates" rule in AGENTS.md governs generated *code*, where import management
 * and type deduplication are what templates cannot do.
 */

import { BRAND } from '@graft/protocol';
import type { Brand, IR, Method, NamedType, Resource, TypeRef } from '@graft/protocol';
import { camel, pascal, serviceLabel } from './naming.js';
import type { TypeMapper } from './types.js';

export interface DocsContext {
  readonly ir: IR;
  readonly types: TypeMapper;
  readonly clientName: string;
  readonly packageName: string;
  readonly envVar: string;
  /** This project's name and derived strings, from `TargetInput.brand`. */
  readonly brand: Brand;
}

/** Depth-first resource list, parents before children. */
function flatten(resources: readonly Resource[], prefix: string[] = []): Array<{
  resource: Resource;
  accessor: string;
}> {
  const out: Array<{ resource: Resource; accessor: string }> = [];
  for (const resource of resources) {
    const accessor = [...prefix, camel(resource.name)].join('.');
    out.push({ resource, accessor });
    out.push(...flatten(resource.subresources, [...prefix, camel(resource.name)]));
  }
  return out;
}

function firstLine(text: string | undefined): string {
  if (text === undefined) return '';
  return text.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Example values
// ---------------------------------------------------------------------------

/**
 * A literal for a type, using the spec's own example when it has one.
 *
 * Placeholders are deliberately unmistakable. `'...'` cannot be confused for a real id the way
 * `'507f1f77bcf86cd799439011'` can, and a reader who copies it gets an obvious failure rather
 * than a subtle one.
 */
function exampleValue(
  ctx: DocsContext,
  ref: TypeRef,
  specExample: unknown,
  depth = 0,
): string {
  if (specExample !== undefined && (typeof specExample === 'string' || typeof specExample === 'number' || typeof specExample === 'boolean')) {
    return JSON.stringify(specExample);
  }
  if (depth > 3) return 'undefined';

  switch (ref.kind) {
    case 'primitive':
      if (ref.type === 'boolean') return 'true';
      if (ref.type === 'string') {
        if (ref.format === 'date-time') return "'2024-01-01T00:00:00Z'";
        if (ref.format === 'email') return "'you@example.com'";
        if (ref.format === 'uri') return "'https://example.com'";
        return "'...'";
      }
      return '0';
    case 'literal':
      return typeof ref.value === 'string' ? JSON.stringify(ref.value) : String(ref.value);
    case 'array':
      return '[]';
    case 'map':
      return '{}';
    case 'binary':
      return "new Blob(['...'])";
    case 'nullable':
      return exampleValue(ctx, ref.inner, undefined, depth);
    case 'union':
      // The first variant, so the snippet is concrete rather than a comment about choices.
      return ref.variants[0] === undefined ? 'undefined' : exampleValue(ctx, ref.variants[0], undefined, depth);
    case 'named': {
      const type = ctx.ir.types.find((t) => t.id === ref.id);
      if (type === undefined) return 'undefined';
      return namedExampleValue(ctx, type, depth);
    }
    default:
      return 'undefined';
  }
}

function namedExampleValue(ctx: DocsContext, type: NamedType, depth: number): string {
  if (type.kind === 'enum') {
    const first = type.members[0];
    return first === undefined
      ? "'...'"
      : typeof first.wireValue === 'string'
        ? JSON.stringify(first.wireValue)
        : String(first.wireValue);
  }
  if (type.kind === 'alias') return exampleValue(ctx, type.target, undefined, depth + 1);

  // Prefer required fields: a minimal valid call is what a reader wants to see, and listing every
  // optional field buries the shape. But when nothing is required — common, since specs often
  // declare no `required` at all — `{}` compiles and teaches nothing, so show a few real field
  // names instead. The names come from the IR; only the values are placeholders.
  const required = type.fields.filter((field) => field.required);
  const shown =
    required.length > 0
      ? required
      : type.fields.filter((field) => field.type.kind === 'primitive').slice(0, 3);
  if (shown.length === 0) return '{}';
  const entries = shown
    .slice(0, 6)
    .map(
      (field) =>
        `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field.wireName) ? field.wireName : JSON.stringify(field.wireName)}: ${exampleValue(ctx, field.type, field.docs.example, depth + 1)}`,
    );
  return `{ ${entries.join(', ')} }`;
}

/**
 * Positional arguments for a method call, as source text.
 *
 * `extraParams` merges into the trailing params object. Callers must not append it themselves:
 * a paginated method with a path parameter takes `(orgId, params?)`, and passing `{ limit }`
 * positionally lands it in `orgId`. The examples typecheck gate caught exactly that.
 */
function callArguments(
  ctx: DocsContext,
  method: Method,
  extraParams: Record<string, string> = {},
): string {
  const args: string[] = [];
  for (const param of method.http.params.filter((p) => p.location === 'path')) {
    args.push(exampleValue(ctx, param.type, param.docs.example));
  }
  if (method.body !== undefined) {
    args.push(exampleValue(ctx, method.body.type, undefined));
  }

  const entries = new Map<string, string>();
  for (const param of method.http.params.filter((p) => p.location !== 'path' && p.required)) {
    entries.set(camel(param.name), exampleValue(ctx, param.type, param.docs.example));
  }
  // Only offer an extra param the method actually declares, so the snippet stays valid.
  const declared = new Set(method.http.params.map((p) => camel(p.name)));
  for (const [key, value] of Object.entries(extraParams)) {
    if (declared.has(key)) entries.set(key, value);
  }

  if (entries.size > 0) {
    args.push(`{ ${[...entries].map(([k, v]) => `${k}: ${v}`).join(', ')} }`);
  }
  return args.join(', ');
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

export function renderReadme(ctx: DocsContext): string {
  const { ir, clientName, packageName, envVar } = ctx;
  const resources = flatten(ir.resources);
  const hasBearer = ir.service.auth.some((a) => a.kind === 'bearer');
  const hasBasic = ir.service.auth.some((a) => a.kind === 'basic');
  const apiKey = ir.service.auth.find((a) => a.kind === 'apiKey');

  const paginated = resources
    .flatMap(({ resource, accessor }) =>
      resource.methods.filter((m) => m.paginationId !== undefined).map((m) => ({ accessor, method: m })),
    )
    .slice(0, 1)[0];
  const streaming = resources
    .flatMap(({ resource, accessor }) =>
      resource.methods.filter((m) => m.response.kind === 'stream').map((m) => ({ accessor, method: m })),
    )
    .slice(0, 1)[0];
  const simpleGet = resources
    .flatMap(({ resource, accessor }) =>
      resource.methods
        .filter(
          (m) =>
            m.paginationId === undefined &&
            m.http.verb === 'get' &&
            m.http.params.some((p) => p.location === 'path'),
        )
        .map((m) => ({ accessor, method: m })),
    )
    .slice(0, 1)[0];

  const out: string[] = [];
  const push = (line = ''): void => void out.push(line);

  push(`# ${packageName}`);
  push();
  const description = firstLine(ir.service.docs.description ?? ir.service.docs.summary);
  push(
    description === ''
      ? `TypeScript SDK for ${serviceLabel(ir)} v${ir.service.version}.`
      : description,
  );
  push();
  push('## Install');
  push();
  push('```sh');
  push(`npm install ${packageName}`);
  push('```');
  push();
  push('Requires Node 18+, or any runtime with a global `fetch`.');
  push();

  // --- quick start ---
  push('## Quick start');
  push();
  push('```ts');
  push(`import { ${clientName} } from '${packageName}';`);
  push();
  push(`const client = new ${clientName}({`);
  if (hasBearer) push(`  token: process.env.${envVar}_TOKEN,`);
  else if (apiKey !== undefined) push(`  apiKey: process.env.${envVar}_API_KEY,`);
  push('});');
  if (simpleGet !== undefined) {
    push();
    push(
      `const result = await client.${simpleGet.accessor}.${camel(simpleGet.method.name)}(${callArguments(ctx, simpleGet.method)});`,
    );
    push('console.log(result);');
  }
  push('```');
  push();

  // --- auth ---
  push('## Authentication');
  push();
  if (hasBearer && hasBasic) {
    push('This API accepts either a bearer token or HTTP Basic credentials. Supply one:');
    push();
    push('```ts');
    push(`// Bearer token`);
    push(`new ${clientName}({ token: process.env.${envVar}_TOKEN });`);
    push();
    push('// HTTP Basic');
    push(`new ${clientName}({ username: 'you@example.com', password: '...' });`);
    push('```');
    push();
    push('A token takes precedence when both are given.');
  } else if (hasBearer) {
    const bearer = ir.service.auth.find((a) => a.kind === 'bearer');
    const prefix = bearer !== undefined && 'tokenPrefix' in bearer ? bearer.tokenPrefix : undefined;
    push(
      prefix === undefined
        ? 'Pass a bearer token:'
        : `Pass a bearer token (they begin with \`${prefix}\`):`,
    );
    push();
    push('```ts');
    push(`new ${clientName}({ token: process.env.${envVar}_TOKEN });`);
    push('```');
  } else if (apiKey !== undefined && apiKey.kind === 'apiKey') {
    push(`Pass an API key, sent as the \`${apiKey.wireName}\` ${apiKey.location}:`);
    push();
    push('```ts');
    push(`new ${clientName}({ apiKey: process.env.${envVar}_API_KEY });`);
    push('```');
  } else {
    push('This API declares no authentication scheme.');
  }
  push();

  // --- pagination ---
  if (paginated !== undefined) {
    push('## Pagination');
    push();
    push('List methods return a paginator. Iterate it to walk every item across pages:');
    push();
    push('```ts');
    push(
      `for await (const item of client.${paginated.accessor}.${camel(paginated.method.name)}(${callArguments(ctx, paginated.method)})) {`,
    );
    push('  console.log(item);');
    push('}');
    push('```');
    push();
    push('Or `await` it for a single page, when you want the page envelope:');
    push();
    push('```ts');
    push(
      `const page = await client.${paginated.accessor}.${camel(paginated.method.name)}(${callArguments(ctx, paginated.method, { limit: '50' })});`,
    );
    push('console.log(page.items, page.total, page.hasNextPage);');
    push();
    push('const next = await page.nextPage();');
    push('```');
    push();
    push('`.pages()` iterates page objects, and `.all()` collects everything — it is unbounded, so');
    push('prefer iteration for large collections.');
    push();
  }

  // --- errors ---
  push('## Errors');
  push();
  push('Every non-2xx response throws a subclass of `APIError`, so you can narrow with `instanceof`:');
  push();
  push('```ts');
  push(`import { NotFoundError, RateLimitError, APIError } from '${packageName}';`);
  push();
  push('try {');
  if (simpleGet !== undefined) {
    push(
      `  await client.${simpleGet.accessor}.${camel(simpleGet.method.name)}(${callArguments(ctx, simpleGet.method)});`,
    );
  } else {
    push('  await client.someResource.someMethod();');
  }
  push('} catch (error) {');
  push('  if (error instanceof NotFoundError) {');
  push('    // error.status is 404');
  push('  } else if (error instanceof RateLimitError) {');
  push('    console.log(error.retryAfterSeconds);');
  push('  } else if (error instanceof APIError) {');
  push('    console.log(error.status, error.requestId, error.body);');
  push('  }');
  push('}');
  push('```');
  push();
  const statuses = ir.errors.byStatus.map((e) => `\`${pascal(e.name)}\` (${e.statusCode})`);
  if (statuses.length > 0) {
    push(`Declared by this API: ${statuses.join(', ')}.`);
    push();
  }

  // --- retries and timeouts ---
  push('## Retries and timeouts');
  push();
  push('Connection failures, timeouts, `408`, `429`, and `5xx` are retried twice by default with');
  push('jittered exponential backoff, honouring `retry-after` when the server sends it.');
  push();
  push('```ts');
  push(`const client = new ${clientName}({`);
  if (hasBearer) push(`  token: process.env.${envVar}_TOKEN,`);
  push('  maxRetries: 5,');
  push('  timeout: 30_000, // ms');
  push('});');
  push();
  push('// Or per request:');
  if (simpleGet !== undefined) {
    push(
      `await client.${simpleGet.accessor}.${camel(simpleGet.method.name)}(${
        callArguments(ctx, simpleGet.method) === ''
          ? '{ maxRetries: 0 }'
          : `${callArguments(ctx, simpleGet.method)}, { maxRetries: 0, timeout: 5_000 }`
      });`,
    );
  }
  push('```');
  push();
  push('Pass an `AbortSignal` to cancel:');
  push();
  push('```ts');
  push('const controller = new AbortController();');
  if (simpleGet !== undefined) {
    push(
      `const promise = client.${simpleGet.accessor}.${camel(simpleGet.method.name)}(${
        callArguments(ctx, simpleGet.method) === ''
          ? '{ signal: controller.signal }'
          : `${callArguments(ctx, simpleGet.method)}, { signal: controller.signal }`
      });`,
    );
  }
  push('controller.abort();');
  push('```');
  push();

  if (streaming !== undefined) {
    push('## Streaming');
    push();
    push('```ts');
    push(`for await (const event of client.${streaming.accessor}.${camel(streaming.method.name)}(${callArguments(ctx, streaming.method)})) {`);
    push('  console.log(event);');
    push('}');
    push('```');
    push();
  }

  // --- resources ---
  const methodCount = resources.reduce((sum, r) => sum + r.resource.methods.length, 0);
  push('## Resources');
  push();
  push(`${methodCount} methods across ${resources.length} resources.`);
  push('See [`api.md`](./api.md) for the full reference.');
  push();
  for (const { resource, accessor } of resources) {
    if (resource.methods.length === 0) continue;
    const names = resource.methods.map((m) => `\`${camel(m.name)}\``).join(', ');
    push(`- **\`client.${accessor}\`** — ${names}`);
  }
  push();
  push('## Examples');
  push();
  push('Runnable scripts live in [`examples/`](./examples). They are compiled as part of this');
  push("package's typecheck, so they cannot drift out of date with the API.");
  push();
  push('---');
  push();
  push(ctx.brand.attribution);
  push();

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// API reference
// ---------------------------------------------------------------------------

/** Signature text for a method, matching what the emitter produced. */
function signature(ctx: DocsContext, method: Method, resourceScope: string): string {
  const parts: string[] = [];
  for (const param of method.http.params.filter((p) => p.location === 'path')) {
    parts.push(`${camel(param.name)}: ${ctx.types.render(param.type)}`);
  }
  if (method.body !== undefined) {
    parts.push(`body${method.body.required ? '' : '?'}: ${ctx.types.render(method.body.type)}`);
  }
  const others = method.http.params.filter((p) => p.location !== 'path');
  if (others.length > 0) {
    const required = others.some((p) => p.required);
    parts.push(`params${required ? '' : '?'}: ${resourceScope}${pascal(method.name)}Params`);
  }
  parts.push('options?: RequestOptions');

  const response = method.response;
  let returns: string;
  if (method.paginationId !== undefined) {
    const type = response.kind === 'json' && response.type.kind === 'array'
      ? ctx.types.render(response.type.items)
      : 'unknown';
    returns = `Paginator<${type}>`;
  } else {
    switch (response.kind) {
      case 'empty':
        returns = 'Promise<void>';
        break;
      case 'text':
        returns = 'Promise<string>';
        break;
      case 'binary':
        returns = 'Promise<Blob>';
        break;
      case 'stream':
        returns = `AsyncGenerator<${ctx.types.render(response.event)}>`;
        break;
      case 'json':
        returns = `Promise<${ctx.types.render(response.type)}>`;
        break;
    }
  }
  return `${camel(method.name)}(${parts.join(', ')}): ${returns}`;
}

export function renderApiReference(ctx: DocsContext): string {
  const { ir, packageName } = ctx;
  const out: string[] = [];
  const push = (line = ''): void => void out.push(line);

  push('# API reference');
  push();
  push(`Every resource and method exposed by \`${packageName}\`.`);
  push();

  for (const { resource, accessor } of flatten(ir.resources)) {
    if (resource.methods.length === 0) continue;
    push(`## \`client.${accessor}\``);
    push();
    const scope = accessor
      .split('.')
      .map((segment) => pascal(segment.split(/(?=[A-Z])/).map((s) => s.toLowerCase())))
      .join('');
    for (const method of resource.methods) {
      const summary = firstLine(method.docs.summary ?? method.docs.description);
      push(`### \`${camel(method.name)}\``);
      push();
      if (summary !== '') push(`${summary}`);
      if (method.deprecated) push('**Deprecated.**');
      push();
      push('```ts');
      push(signature(ctx, method, scope));
      push('```');
      push();
      push(`\`${method.http.verb.toUpperCase()} ${method.http.path}\``);
      push();
      const params = method.http.params;
      if (params.length > 0) {
        push('| Parameter | In | Type | Required |');
        push('|---|---|---|---|');
        for (const param of params) {
          const description = firstLine(param.docs.description);
          push(
            `| \`${param.wireName}\` | ${param.location} | \`${ctx.types.render(param.type)}\` | ${
              param.required ? 'yes' : 'no'
            } |${description === '' ? '' : ''}`,
          );
        }
        push();
      }
    }
  }

  push('---');
  push();
  push(`_Generated by ${BRAND.title}._`);
  push();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

export interface GeneratedExample {
  readonly path: string;
  readonly contents: string;
}

/**
 * A handful of example *shapes*, not one per operation.
 *
 * 121 example files would be noise. What a reader needs is one instance of each distinct usage
 * pattern the API actually has.
 */
export function renderExamples(ctx: DocsContext): GeneratedExample[] {
  const { ir, clientName, envVar } = ctx;
  const resources = flatten(ir.resources);
  const examples: GeneratedExample[] = [];
  const hasBearer = ir.service.auth.some((a) => a.kind === 'bearer');
  const apiKey = ir.service.auth.find((a) => a.kind === 'apiKey');

  const construct = [
    `const client = new ${clientName}({`,
    ...(hasBearer
      ? [`  token: process.env.${envVar}_TOKEN,`]
      : apiKey !== undefined
        ? [`  apiKey: process.env.${envVar}_API_KEY,`]
        : []),
    '});',
  ];

  // Examples read a token from the environment, which is the practice worth showing. Declaring
  // the global here rather than depending on `@types/node` keeps them portable: the SDK itself is
  // runtime-agnostic, and the gate must not depend on what happens to be installed.
  examples.push({
    path: 'examples/env.d.ts',
    contents: [
      '/**',
      ' * Minimal ambient declaration so examples can read environment variables without',
      ' * depending on `@types/node`. The SDK itself needs no Node types — it runs anywhere',
      ' * `fetch` exists.',
      ' */',
      'declare const process: { env: Record<string, string | undefined> };',
      '',
    ].join('\n'),
  });

  const header = (title: string, note?: string): string[] => [
    '/**',
    ` * ${title}`,
    ...(note === undefined ? [] : [' *', ` * ${note}`]),
    ' *',
    ' * Compiled as part of this package, so it cannot drift out of date with the API.',
    ' */',
    '',
    `import { ${clientName} } from '../src/index.js';`,
    '',
  ];

  const find = <T>(pick: (m: Method, accessor: string) => T | undefined): T | undefined => {
    for (const { resource, accessor } of resources) {
      for (const method of resource.methods) {
        const hit = pick(method, accessor);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };

  // --- pagination ---
  const paged = find((m, accessor) => (m.paginationId !== undefined ? { m, accessor } : undefined));
  if (paged !== undefined) {
    examples.push({
      path: 'examples/pagination.ts',
      contents: [
        ...header(
          'Iterating a paginated collection.',
          'The paginator is async-iterable, so `for await` walks every page transparently.',
        ),
        ...construct,
        '',
        'let count = 0;',
        `for await (const item of client.${paged.accessor}.${camel(paged.m.name)}(${callArguments(ctx, paged.m, { limit: '50' })})) {`,
        '  count += 1;',
        '  if (count >= 200) break; // stop early; the iterator is lazy',
        '}',
        'console.log(`saw ${count} items`);',
        '',
        '// A single page, when you want the envelope.',
        `const page = await client.${paged.accessor}.${camel(paged.m.name)}(${callArguments(ctx, paged.m, { limit: '10' })});`,
        'console.log(page.items.length, page.total, page.hasNextPage);',
        '',
      ].join('\n'),
    });
  }

  // --- read one ---
  const single = find((m, accessor) =>
    m.paginationId === undefined &&
    m.http.verb === 'get' &&
    m.http.params.some((p) => p.location === 'path')
      ? { m, accessor }
      : undefined,
  );
  if (single !== undefined) {
    examples.push({
      path: 'examples/fetch-one.ts',
      contents: [
        ...header('Fetching a single record.'),
        ...construct,
        '',
        `const record = await client.${single.accessor}.${camel(single.m.name)}(${callArguments(ctx, single.m)});`,
        'console.log(record);',
        '',
      ].join('\n'),
    });
  }

  // --- create ---
  const create = find((m, accessor) =>
    m.http.verb === 'post' && m.body !== undefined ? { m, accessor } : undefined,
  );
  if (create !== undefined) {
    examples.push({
      path: 'examples/create.ts',
      contents: [
        ...header(
          'Creating a record.',
          'The request type omits server-owned fields, so ids and timestamps cannot be passed.',
        ),
        ...construct,
        '',
        `const created = await client.${create.accessor}.${camel(create.m.name)}(${callArguments(ctx, create.m)});`,
        'console.log(created);',
        '',
      ].join('\n'),
    });
  }

  // --- errors ---
  const errorNames = ir.errors.byStatus.slice(0, 3).map((e) => pascal(e.name));
  const target = single ?? create ?? paged;
  if (target !== undefined && errorNames.length > 0) {
    examples.push({
      path: 'examples/error-handling.ts',
      contents: [
        '/**',
        ' * Handling errors.',
        ' *',
        ' * Every non-2xx response throws a subclass of `APIError`, so `instanceof` narrows without',
        ' * a cast and `error.status` is literal-typed on each subclass.',
        ' *',
        ' * Compiled as part of this package, so it cannot drift out of date with the API.',
        ' */',
        '',
        `import { ${clientName}, APIError, ${errorNames.join(', ')} } from '../src/index.js';`,
        '',
        ...construct,
        '',
        'try {',
        `  await client.${target.accessor}.${camel(target.m.name)}(${callArguments(ctx, target.m)});`,
        '} catch (error) {',
        ...errorNames.map(
          (name, index) =>
            `  ${index === 0 ? 'if' : '} else if'} (error instanceof ${name}) {\n    console.error('${name}:', error.status, error.requestId);`,
        ),
        '  } else if (error instanceof APIError) {',
        '    console.error(error.status, error.body);',
        '  } else {',
        '    throw error; // not from this SDK',
        '  }',
        '}',
        '',
      ].join('\n'),
    });
  }

  // --- streaming ---
  const stream = find((m, accessor) =>
    m.response.kind === 'stream' ? { m, accessor } : undefined,
  );
  if (stream !== undefined) {
    examples.push({
      path: 'examples/streaming.ts',
      contents: [
        ...header('Consuming a stream of events.'),
        ...construct,
        '',
        `for await (const event of client.${stream.accessor}.${camel(stream.m.name)}(${callArguments(ctx, stream.m)})) {`,
        '  console.log(event);',
        '}',
        '',
      ].join('\n'),
    });
  }

  return examples;
}

// ---------------------------------------------------------------------------
// Per-operation examples and generated tests (SPEC.md §3.11)
// ---------------------------------------------------------------------------

/**
 * Render a JSON value from the IR as TypeScript source.
 *
 * The values themselves are synthesized in the core, so this is only syntax — which is the whole
 * division §3.11 sets up. A target that decided *what* the values were would be the sixth copy of one
 * judgment.
 */
function renderJson(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent + 1);
  const closePad = '  '.repeat(indent);
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((entry) => `${pad}${renderJson(entry, indent + 1)}`).join(',\n')}\n${closePad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const body = entries
      .map(([key, entry]) => {
        const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
        return `${pad}${safeKey}: ${renderJson(entry, indent + 1)}`;
      })
      .join(',\n');
    return `{\n${body}\n${closePad}}`;
  }
  return JSON.stringify(value);
}

/**
 * Render an example value *with its type in hand*, so language-specific representations come out right.
 *
 * The values are language-neutral JSON, which is the point — but a few of them have no JSON form and must
 * be rendered as the language's own construct. `binary` is the one that bites: the core emits `"..."` for
 * it, and TypeScript needs `new Blob(['...'])`. The examples typecheck gate caught it on the first run,
 * which is precisely why generated examples belong inside the gate rather than beside it.
 *
 * Descends the `TypeRef` and the value together, falling back to plain JSON wherever the type runs out
 * (`unknown`, a map's values) — there, JSON is the correct rendering anyway.
 */
function renderTyped(ctx: DocsContext, ref: TypeRef, value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent + 1);
  const closePad = '  '.repeat(indent);

  switch (ref.kind) {
    case 'binary':
      return `new Blob([${JSON.stringify(String(value))}])`;
    case 'nullable':
      return value === null ? 'null' : renderTyped(ctx, ref.inner, value, indent);
    case 'array': {
      if (!Array.isArray(value) || value.length === 0) return '[]';
      const entries = value.map((entry) => `${pad}${renderTyped(ctx, ref.items, entry, indent + 1)}`);
      return `[\n${entries.join(',\n')}\n${closePad}]`;
    }
    case 'union': {
      // The first variant, matching what the core synthesized from. Rendering against a different variant
      // than the value was built for is how a union example stops typechecking.
      const first = ref.variants[0];
      return first === undefined ? renderJson(value, indent) : renderTyped(ctx, first, value, indent);
    }
    case 'named': {
      const type = ctx.ir.types.find((candidate) => candidate.id === ref.id);
      if (type === undefined) return renderJson(value, indent);
      if (type.kind === 'alias') return renderTyped(ctx, type.target, value, indent);
      if (type.kind === 'enum') return renderJson(value, indent);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return renderJson(value, indent);
      }
      const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        const field = type.fields.find((candidate) => candidate.wireName === key);
        const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
        const rendered =
          field === undefined
            ? renderJson(entry, indent + 1)
            : renderTyped(ctx, field.type, entry, indent + 1);
        return `${pad}${safeKey}: ${rendered}`;
      });
      return entries.length === 0 ? '{}' : `{\n${entries.join(',\n')}\n${closePad}}`;
    }
    default:
      return renderJson(value, indent);
  }
}

/**
 * The arguments for one call, built from the IR's example rather than from the type graph.
 *
 * Path parameters are positional and in declaration order; everything else lands in the trailing params
 * object. Getting that order wrong puts a `limit` where an `orgId` belongs, which is a bug the examples
 * typecheck gate has already caught once.
 */
function exampleArgs(ctx: DocsContext, method: Method): string {
  const example = method.example;
  if (example === undefined) return '';
  const args: string[] = [];

  for (const param of method.http.params.filter((p) => p.location === 'path')) {
    args.push(renderTyped(ctx, param.type, example.params[param.wireName]));
  }
  if (example.body !== undefined && method.body !== undefined) {
    args.push(renderTyped(ctx, method.body.type, example.body));
  }

  const rest = method.http.params.filter(
    (p) => p.location !== 'path' && p.location !== 'cookie' && p.wireName in example.params,
  );
  if (rest.length > 0) {
    const entries = rest
      .map(
        (param) =>
          `${camel(param.name)}: ${renderTyped(ctx, param.type, example.params[param.wireName])}`,
      )
      .join(', ');
    args.push(`{ ${entries} }`);
  }
  return args.join(', ');
}

/** How a call's result is consumed, which differs by what the operation returns. */
function consumeResult(method: Method, call: string): string[] {
  if (method.paginationId !== undefined) {
    return [`for await (const item of ${call}) {`, '  console.log(item);', '}'];
  }
  if (method.response.kind === 'stream') {
    return [`for await (const event of ${call}) {`, '  console.log(event);', '}'];
  }
  if (method.response.kind === 'empty') return [`await ${call};`];
  return [`const result = await ${call};`, 'console.log(result);'];
}

/** A stable file stem for an operation, e.g. `orgs-invoices-download-pdf`. */
function operationSlug(accessor: string, method: Method): string {
  return `${accessor.replace(/\./g, '-')}-${method.name.tokens.join('-')}`.toLowerCase();
}

/**
 * One runnable example per operation, each compiled by the package's own typecheck gate.
 *
 * A file rather than only a docstring, because a docstring example is not compiled and therefore rots —
 * which is the reason the thematic examples already live here. Both exist: the docstring for
 * discoverability in an editor, the file for the gate.
 */
export function renderOperationExamples(ctx: DocsContext): GeneratedExample[] {
  const { ir, clientName } = ctx;
  const out: GeneratedExample[] = [];

  for (const { resource, accessor } of flatten(ir.resources)) {
    for (const method of resource.methods) {
      if (method.example === undefined) continue;
      const call = `client.${accessor}.${camel(method.name)}(${exampleArgs(ctx, method)})`;
      const summary = method.docs.summary ?? `${accessor}.${camel(method.name)}`;
      const lines = [
        '/**',
        ` * ${summary.replace(/\*\//g, '* /')}`,
        ' *',
        ` * \`${method.http.verb.toUpperCase()} ${method.http.path}\``,
        ' *',
        ' * Values are synthesized from the spec, so ids and placeholders are not real. Compiled as part',
        ' * of this package, so this cannot drift out of date with the API.',
        ' */',
        '',
        `import { ${clientName} } from '../../src/index.js';`,
        '',
        `const client = new ${clientName}();`,
        '',
        ...consumeResult(method, call),
        '',
      ];
      out.push({
        path: `examples/operations/${operationSlug(accessor, method)}.ts`,
        contents: lines.join('\n'),
      });
    }
  }
  return out;
}

/**
 * One test per operation, run against an injected transport.
 *
 * Deliberately shallow and deliberately complete: it asserts the four things generated code is actually
 * responsible for — the interpolated path, the query string, the encoded body, and that a declared
 * response decodes. That is the seam nothing else covers. The runtime has its own unit tests and the
 * cross-language conformance suite exercises twelve hand-authored scenarios; neither touches operation 87
 * of 121, which is where a path built wrong for one parameter shape actually hides.
 *
 * Never a network call. A generated test hitting the real API would fail in CI for reasons unrelated to
 * the SDK, and the first thing anyone would do is delete it.
 */
export function renderOperationTests(ctx: DocsContext): GeneratedExample[] {
  const { ir, clientName } = ctx;
  const out: GeneratedExample[] = [];

  for (const { resource, accessor } of flatten(ir.resources)) {
    for (const method of resource.methods) {
      const example = method.example;
      if (example === undefined) continue;

      const responseKind = method.response.kind;
      // Only a JSON or text body can be asserted to decode. The rest still get a test, because the
      // *request* half is the part most likely to be wrong.
      // `null`, not `''`, when there is nothing to send back. A 204 may not carry a body at all, and the
      // `Response` constructor throws on one — so an empty string here made every `delete` operation's test
      // fail with "Invalid response status code 204", which is the test being wrong rather than the SDK.
      const bodyLiteral =
        example.response === undefined
          ? 'null'
          : responseKind === 'text'
            ? JSON.stringify(String(example.response))
            : `JSON.stringify(${renderJson(example.response, 3)})`;
      const contentType = responseKind === 'text' ? 'text/plain' : 'application/json';

      const call = `client.${accessor}.${camel(method.name)}(${exampleArgs(ctx, method)})`;
      const drain =
        method.paginationId !== undefined || responseKind === 'stream'
          ? [`      for await (const _ of ${call}) break;`]
          : [`      await ${call};`];

      // The request body, which is the assertion that earns this suite its keep. Without it the suite
      // asserts a path and a verb — and the bug this project actually shipped was a *correct* path with a
      // JSON body posted to a `multipart/form-data` endpoint. That is invisible to every other check here.
      const bodyChecks: string[] = [];
      if (method.body !== undefined && example.body !== undefined) {
        const declared = method.body.contentType.toLowerCase();
        bodyChecks.push(
          '',
          `    // Declared as \`${method.body.contentType}\` in the spec.`,
          "    const contentType = seen!.headers.get('content-type') ?? '';",
        );
        if (declared.startsWith('multipart/')) {
          bodyChecks.push(
            "    expect(contentType).toMatch(/^multipart\\/form-data/);",
            '    // A boundary is what makes a multipart body parseable at all.',
            "    expect(contentType).toMatch(/boundary=/);",
          );
        } else if (declared.includes('x-www-form-urlencoded')) {
          // Parsed as a form, not as JSON. The first version called `.json()` on every body and failed on
          // all 62 of Twilio's operations — a test wrong in the same way the code was, which is what
          // happens when an assertion assumes one encoding.
          bodyChecks.push(
            `    expect(contentType).toContain('application/x-www-form-urlencoded');`,
            '    const sent = new URLSearchParams(await seen!.clone().text());',
            ...formFieldChecks(example.body),
          );
        } else {
          bodyChecks.push(
            `    expect(contentType).toContain(${JSON.stringify(method.body.contentType)});`,
            '    expect(await seen!.clone().json()).toEqual(',
            `      ${renderJson(example.body, 3)},`,
            '    );',
          );
        }
      }

      const queryChecks =
        method.http.params.filter((p) => p.location === 'query' && !p.required).length > 0
          ? [
              '',
              '    // An omitted optional query parameter must not reach the wire at all. A generator that',
              "    // serialized `undefined` would send `?since=undefined`, which a server reads as a value.",
              '    for (const [key, value] of new URL(seen!.url).searchParams) {',
              "      expect(value).not.toBe('undefined');",
              "      expect(value).not.toBe('null');",
              '      expect(key).not.toBe(\'\');',
              '    }',
            ]
          : [];

      const lines = [
        '/**',
        ` * ${accessor}.${camel(method.name)} — \`${method.http.verb.toUpperCase()} ${method.http.path}\``,
        ' *',
        ' * Generated from the spec. Asserts the request this SDK builds and that the declared response',
        ' * decodes; it does not assert anything about your API being up, because it never calls it.',
        ' *',
        ' * Regenerated on every run and not preserved — edit the spec, not this file.',
        ' */',
        '',
        "import { describe, expect, it } from 'vitest';",
        `import { ${clientName} } from '../../src/index.js';`,
        '',
        `describe('${accessor}.${camel(method.name)}', () => {`,
        "  it('builds the documented request and decodes the response', async () => {",
        '    let seen: Request | undefined;',
        `    const client = new ${clientName}({`,
        "      baseURL: 'https://api.test',",
        '      fetch: async (input, init) => {',
        '        seen = new Request(input as RequestInfo, init);',
        `        return new Response(${bodyLiteral}, {`,
        `          status: ${method.response.statusCode},`,
        `          headers: { 'content-type': '${contentType}' },`,
        '        });',
        '      },',
        '    });',
        '',
        ...drain,
        '',
        '    expect(seen).toBeDefined();',
        `    expect(seen!.method).toBe('${method.http.verb.toUpperCase()}');`,
        `    expect(new URL(seen!.url).pathname).toBe('${examplePath(method)}');`,
        ...bodyChecks,
        ...queryChecks,
        '  });',
        '});',
        '',
      ];
      out.push({
        path: `tests/operations/${operationSlug(accessor, method)}.test.ts`,
        contents: lines.join('\n'),
      });
    }
  }
  return out;
}

/**
 * Assertions for a form-encoded body, field by field.
 *
 * Field-by-field rather than comparing the whole serialized string, because form encoding has no canonical
 * key order — a whole-string comparison would assert the emitter's iteration order, which is not part of
 * the contract and would break on an unrelated change.
 *
 * Only scalars. An object or array field has no single agreed form encoding (`key[]=`, repeated `key=`,
 * `key=a,b` are all in use), so asserting one would assert this runtime's choice rather than the spec's
 * requirement.
 */
function formFieldChecks(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === null || typeof value === 'object') continue;
    out.push(`    expect(sent.get(${JSON.stringify(key)})).toBe(${JSON.stringify(String(value))});`);
  }
  return out;
}

/**
 * The path the SDK should produce, with the example's parameter values interpolated.
 *
 * Computed here rather than asserted loosely, because path interpolation is one of the four things a
 * generated test exists to check — and a test asserting only that the path *contains* the resource name
 * would pass while `/orgs/{orgId}/members` came out as `/orgs/undefined/members`.
 */
function examplePath(method: Method): string {
  let path = method.http.path;
  for (const param of method.http.params.filter((p) => p.location === 'path')) {
    const value = method.example?.params[param.wireName];
    // Encoded the way the runtime encodes it, so a value with a slash asserts the escaping rather than
    // asserting the bug.
    path = path.split(`{${param.wireName}}`).join(encodeURIComponent(String(value ?? '')));
  }
  return path;
}
