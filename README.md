<div align="center">

<img src="https://raw.githubusercontent.com/papervine/graft/main/docs/favicon.svg" width="110" height="110" alt="Graft" />

# Graft

***The open-source OpenAPI → SDK generator whose output reads as hand-written.***

One spec in. Six idiomatic client libraries out, each gated by its own language's strict typechecker.

[![license](https://img.shields.io/badge/license-MIT-0F766E)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-0F766E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![targets](https://img.shields.io/badge/SDK%20targets-6-0F766E)](#language-support)
[![conformance](https://img.shields.io/badge/conformance-12%20scenarios%20%C3%97%206%20languages-0F766E)](#the-tests-that-actually-matter)
[![diagnostics](https://img.shields.io/badge/diagnostics-22%20codes-0F766E)](./docs/reference/diagnostics.mdx)
[![docs](https://img.shields.io/badge/docs-.%2Fdocs-0F766E)](./docs)

[Quickstart](#quickstart) · [Six languages](#one-spec-six-languages) · [Commands](#commands) · [`check`](#graft-check) · [`diff`](#graft-diff) · [Config](#configuration) · [How it works](#how-it-works) · [Support](#language-support) · [Docs](./docs)

<img src="https://raw.githubusercontent.com/papervine/graft/main/docs/images/check.svg" width="740" alt="Terminal output of graft check against a real OpenAPI spec: three warnings and one informational finding, each with a stable diagnostic code and the graft.yaml fragment that resolves it" />

</div>

> [!NOTE]
> **Early, and honest about it.** All six targets generate, format, typecheck and pass a shared
> cross-language conformance suite — but nothing is published to a registry yet, `graft` is a
> working title, and [the support matrix](#language-support) has real gaps in it. Read that table
> before you commit to a language.

### Why this exists

The good OpenAPI generators are almost all commercial. The open-source ones that produce output you
would actually ship tend to target exactly one language.

The realistic risk of depending on a commercial generator is not being stranded — generated SDKs keep
working if the vendor disappears, and your OpenAPI document is portable by design. The risk is a
**forced migration at an inconvenient time**, and it lands on *your* SDK's users as breaking changes
rather than on you alone.

Graft removes that risk without accepting the usual open-source quality penalty. Generated packages
have **no runtime dependency on Graft**: the transport, retries, auth, pagination and validation
machinery is hand-written per language and vendored into your output. Delete Graft from your
toolchain and the SDK you already shipped keeps building.

### Quickstart

Not on a registry yet — run it from a checkout. Requires Node 20 or higher and pnpm.

```sh
git clone https://github.com/papervine/graft && cd graft
pnpm install && pnpm build
```

Then point it at a spec:

```sh
pnpm --silent graft check    openapi.yaml                          # what your spec fails to say
pnpm --silent graft init     openapi.yaml                          # scaffold graft.yaml
pnpm --silent graft generate openapi.yaml --out sdks/typescript
pnpm --silent graft generate openapi.yaml --target python --out sdks/python
pnpm --silent graft generate openapi.yaml --target go     --out sdks/go
```

Or against the corpus this repository ships, no spec of your own required:

```sh
pnpm demo                    # check the vendored Twilio spec
pnpm generate:all            # generate every committed corpus entry, in every language
pnpm corpus:fetch            # download the large specs (Stripe, GitHub, Box)
```

> [!IMPORTANT]
> **Generation fails if the output does not pass the target language's own strict typechecker** —
> `tsc --noEmit`, `mypy --strict`, `go build`, PHPStan, `javac`, `dotnet build`. That is deliberate,
> and the *target* decides which tools those are, not the core.

Full documentation is in [`docs/`](./docs) — start with [`docs/quickstart.mdx`](./docs/quickstart.mdx).

### One spec, six languages

Every snippet below is **real generated output**, copied from the `examples/` directory Graft emits
alongside each SDK — the same operation, `GET /orgs/{orgId}/members`, in every target. The examples
are compiled and typechecked as part of the package they ship in, so they cannot drift out of date
with the API.

**TypeScript** — async-iterable, because that is what a JS developer expects a paginator to be

```ts
const client = new KitchenSink();

for await (const item of client.orgs.listMembers('...')) {
  console.log(item);
}
```

**Python** — a plain iterator; the async client is a separate class, not a colour-coded twin

```python
client = KitchenSink()

for item in client.orgs.list_members("..."):
    print(item)
```

**Go** — the cursor/`Err()` iterator idiom, not a channel and not a slice of everything

```go
client := New()

it := client.Orgs.ListMembers(ctx, "...", nil, nil)
for it.Next(ctx) {
    fmt.Println(it.Current())
}
if err := it.Err(); err != nil {
    log.Fatal(err)
}
```

**PHP** — `foreach` over a `Traversable`, so it composes with the language's own iterator tools

```php
$client = new KitchenSink();

foreach ($client->orgs->listMembers('...') as $item) {
    var_dump($item);
}
```

**Java** — the paginator is `Iterable<Member>`, so the enhanced `for` loop just works

```java
for (var item : client.orgs().listMembers("...", null, null, null)) {
  System.out.println(item);
}
```

**C#** — `IAsyncEnumerable`, so `await foreach` and LINQ-over-async both apply

```csharp
await foreach (var item in client.Orgs.ListMembers("..."))
{
    Console.WriteLine(item);
}
```

Nothing here is a template with the language swapped. The pagination *scheme* — cursor, in the
response envelope, under `data`, with the next cursor at `next_cursor` — is decided once in the IR;
how a paginator should feel is decided six times, by six targets.

<sub>Java is the weakest of the six on this axis: it has neither named nor default arguments, so
optional query parameters are threaded positionally and you get <code>null, null, null</code>. Write
<em>bodies</em> use builders for exactly this reason; the parameter list has not had the same
treatment yet.</sub>

**Idiom goes deeper than iteration.** The request type is a distinct
[read/write split](./docs/guides/read-write-models.mdx), not the response type with its fields made
optional — so there is no `id` on create, because the server assigns it:

```ts
const created = await client.events.publish({
  type: 'member.invited',
  member: { id: '...', email: 'you@example.com', role: 'owner' },
});
```

`widgets.get(id)`, not `widgets.get_(id)`. And the response is checked against the shape the spec
promised, so a server that breaks its contract says so at the SDK boundary rather than three frames
into your code. Errors are a subclass per status, so narrowing needs no cast:

```ts
try {
  await client.orgs.invoices.downloadPdf('...', '...');
} catch (error) {
  if (error instanceof UnprocessableEntityError) {
    console.error('UnprocessableEntityError:', error.status, error.requestId);
  } else if (error instanceof APIError) {
    console.error(error.status, error.body);
  } else {
    throw error; // not from this SDK
  }
}
```

### Commands

| Command | What it does |
| --- | --- |
| [`graft check <spec>`](#graft-check) | Report what the spec fails to say |
| [`graft init <spec>`](#graft-init) | Scaffold `graft.yaml`, with every inference written out explicitly |
| [`graft generate <spec>`](#graft-generate) | Emit the SDK, then format and typecheck it |
| [`graft diff <spec>`](#graft-diff) | What regenerating would do to your SDK's consumers |
| [`graft release <spec>`](#graft-release) | Next version and changelog, computed from the contract diff |
| [`graft ir <spec>`](#graft-ir) | Dump the semantic IR as JSON |
| [`graft targets`](#graft-targets) | Which targets are installed, and whether they will run |

`--config` is global; `check`, `diff` and `targets` take `--strict` and `--json`. Full flag reference:
[`docs/reference/cli.mdx`](./docs/reference/cli.mdx).

Exit codes are three-valued on purpose, because "your spec is vague" and "your spec is broken" want
different responses in a pipeline:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Ran, and found something you asked it to gate on (`--strict`) |
| `2` | Could not run — spec unreadable, config invalid, target missing |
| `70` | An internal Graft bug. Please report it |

#### `graft check`

Most specs are under-specified, and a generator that quietly guesses produces an SDK that is subtly
wrong in ways nobody can trace back. `check` reports every judgment it would have to make, ranked by
how much damage the wrong answer does, and prints **the config that fixes it**.

```sh
graft check <spec> [--config graft.yaml] [--strict] [--json] [--no-color]
```

| Flag | Effect |
| --- | --- |
| `--config` | Config to apply. Defaults to `graft.yaml` when present |
| `--strict` | Exit `1` if any warning is reported. Use in CI |
| `--json` | Machine-readable output |
| `--no-color` | Disable ANSI colour |

The terminal at the top of this page is that output against the vendored Twilio spec, trimmed only
to fit the frame — run it in full with `pnpm demo`. Twenty-two
[diagnostic codes](./docs/reference/diagnostics.mdx), each with a stable identifier so you can
suppress one deliberately rather than ignoring the whole report.

Config is applied, so a finding you have already answered stops being reported — which is what makes
`--strict` usable in CI at all. The intended loop:

```sh
graft init openapi.yaml            # writes the fixes it can infer
# edit graft.yaml — the REVIEW lines need your knowledge
graft check openapi.yaml --strict  # exits 0 once everything is answered
```

#### `graft init`

Scaffolds a `graft.yaml` from the spec, with every inference written out explicitly rather than left
implicit in the generator.

```sh
graft init <spec> [--out PATH] [--target NAME] [--stdout] [--force]
```

> [!WARNING]
> Without `--force`, `init` refuses to overwrite an existing config. That file accumulates judgments
> about your API that Graft cannot re-derive — it is the most expensive artifact in your repository.

#### `graft generate`

The main verb. Spawns the target, writes the output, runs the gates.

```sh
graft generate <spec> [--target NAME] [--out DIR] [--config PATH]
                      [--clean] [--skip-gates] [--baseline PATH] [--no-baseline]
```

| Flag | Effect |
| --- | --- |
| `--target NAME` | Target to run. Default: first in `targets`, else `typescript` |
| `--out DIR` | Output directory. Overrides `targets.<name>.out`, then `sdks/<target>` |
| `--clean` | Remove the output directory first |
| `--skip-gates` | Skip the formatter and typechecker. Not recommended |
| `--force-overwrite` | Discard preserved code that has nowhere to go. Never the default |

Running without a config proceeds with defaults and **says so**, because the
[read/write split](./docs/guides/read-write-models.mdx) and
[pagination](./docs/sdk/pagination.mdx) are both opt-in — without one, `widgets.create()` accepts the
server-owned `id` it should refuse and no list operation paginates. The output compiles either way,
which is exactly why it is worth a warning.

#### `graft diff`

Compares your spec against a committed IR baseline and answers one question: **what would
regenerating do to the people who depend on your SDK?**

```sh
graft diff <spec> [--baseline PATH] [--config PATH] [--strict] [--json] [--accept]
```

```
✗ Widget.thumbnail: field removed
✗ service.name: renamed from `Acme` to `AcmeCloud`
    the exported client class is renamed, so every `import { … }` breaks

2 breaking, 0 additive, 0 other — implies a major version bump.
```

It is direction-sensitive, which is the part a naive schema diff gets wrong. Adding a field to a
*response* is additive; adding a required field to a *request* is breaking. The same edit to the same
schema is safe in one direction and not the other, and the read/write split is what lets Graft tell
them apart. `--strict` gates CI; `--accept` records the new baseline once you have decided the change
is intended.

#### `graft release`

Builds on the same comparison: the version bump comes from the contract diff and the changelog from
the same set of changes, so the semver is *derived* rather than asserted.

```
1.4.2 → 2.0.0  (major: 3 breaking changes)
  ✗ Widget.name — became optional
  ✗ widgets.archive — method removed
  + widgets.restore — method added

Wrote .graft/openapi.sdk-version and CHANGELOG.md
```

`--workflow` emits the publishing steps as a GitHub Actions workflow rather than running them, because
publishing needs registry credentials and those belong in CI, not in a generator. One version per spec
across every language: three SDKs from one contract at three different numbers is a support burden
with no upside.

#### `graft ir`

Dumps the semantic intermediate representation as JSON — byte-for-byte what a target receives on
stdin. `--summary` prints the readable version:

```sh
$ graft ir openapi.yaml --config graft.yaml --summary
service:    acme v2.8
servers:    Staging, Production
auth:       bearer | basic
resources:  23
methods:    121 (19 paginated)
types:      206 (154 shared, 19 read, 19 create, 19 update)
```

Useful when a generated name surprises you: the IR shows what the target was told.

#### `graft targets`

Which targets are installed, and whether they will actually run.

```sh
$ graft targets
graft emits IR 1.2.0

  ✗ ruby — not installed
      expected `graft-target-ruby` on PATH
  ✓ typescript v0.0.0 (in-tree)
      IR 1.x
      pagination, read-write-split

1 of 2 unusable: ruby.
```

Worth its own command because three failure modes are indistinguishable from `generate`: a target
that is not installed, one that crashes on handshake, and one that does not accept the IR version
Graft emits.

### Configuration

One spec, one config, any number of targets:

```yaml
spec: openapi.yaml
name: Acme                  # client class name — `new Acme()`, no `Client` suffix
targets:
  typescript: { out: sdks/typescript, packageName: "@acme/sdk" }
  python:     { out: sdks/python,     packageName: acme }
  go:         { out: sdks/go,         packageName: acme, modulePath: github.com/acme/acme-go }
  php:        { out: sdks/php,        packageName: acme/sdk }
  java:       { out: sdks/java,       packageName: "com.acme:sdk" }
  dotnet:     { out: sdks/dotnet,     packageName: "Acme.Sdk" }
```

`graft.yaml` is not a patch kit for edge cases — on a real spec, most of what makes the output good
is expressed here, because most specs are under-specified and enriching them is part of the job. The
read/write split, the pagination scheme and the hoisted headers are decided once and apply to every
language.

> [!WARNING]
> **Unknown keys are an error, not ignored.** A typo that silently does nothing is worse than a
> failed run, because you believe you fixed something. The same goes for values: a field name in
> `serverOwned` that does not exist on the schema is reported rather than skipped.

Every key: [`docs/reference/configuration.mdx`](./docs/reference/configuration.mdx).

### How it works

Graft does not generate from your OpenAPI document. It generates from an intermediate representation.

```
OpenAPI ──► Normalizer ──► Semantic IR ──► Target ──► Gates
 + config    quirk          SDK concepts,   idiom     format,
             quarantine     language-       mapping   typecheck
                            neutral
```

The IR models **SDK concepts** — resources, methods, pagination, error taxonomy — not HTTP. The
decision "this API has a `widgets` resource with `list`, `get`, and `create`" is made once, so every
language stays consistent. Names are stored as token sequences (`["user","id"]`), never as strings,
because casing is a target's decision and `userId`/`user_id`/`UserId` are the same name.

A **target is a subprocess**: IR JSON on stdin, a file manifest on stdout. That boundary is what lets
the Python target be written in Python and the Go target in Go, each using its own formatter and
typechecker natively. The in-tree TypeScript target gets no shortcut around it — a plugin API that
nothing external exercises rots.

Targets also declare their own **verification gates** in the handshake, so the core never learns that
"Python means ruff and mypy". That knowledge belongs to the target, which means a third-party target
gets real gates rather than none.

More: [`docs/concepts/how-it-works.mdx`](./docs/concepts/how-it-works.mdx) ·
[writing a target](./docs/targets/writing-a-target.mdx).

### Language support

Support is genuinely uneven, and this table is the honest version. Check it before committing to a
language rather than discovering a gap after you have published.

| | TypeScript | Python | Go | PHP | Java | .NET |
|---|---|---|---|---|---|---|
| Resources and methods | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Read/write model split | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Pagination | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Typed error hierarchy | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Retries and idempotency | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Response validation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Auth, incl. env vars | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| OAuth2 client credentials | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| File uploads | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Binary responses | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Custom code preservation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Per-operation examples and tests | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Streaming | ✅ typed | ⚠️ raw lines | ⚠️ raw reader | — | — | — |
| Async clients | native | ✅ separate | native | — | — | native |
| Discriminated unions | ✅ | ✅ | `any` | `mixed` | `Object` | `object` |
| Webhooks | ✅ | — | — | — | — | — |

✅ supported · ⚠️ partial · — not generated, **and generation warns**

That last point is the one to hold Graft to. An operation a target cannot handle is skipped with a
warning, never emitted as something that does not work:

```
warn: The Java target does not support streaming responses, so `events.stream` was not generated.
```

Everything else in your spec still generates. Every gap in that table was found as a *shipped method
that silently did the wrong thing* — a JSON body posted to a multipart endpoint, a JSON decoder
pointed at an SSE stream. Both compiled. Both passed the language's strictest typechecker. Only the
server ever objected. A method you can see is missing costs you an afternoon; a method that looks
correct and is not costs you a production incident.

Roadmap: **Ruby next**, then Swift and Rust, to match Fern's set. Kotlin is a deliberate decline —
Kotlin consumers can use the Java SDK, which is what JVM interoperability is for.

Per-language detail and the full "not built at all" list:
[`docs/sdk/capabilities.mdx`](./docs/sdk/capabilities.mdx).

### What your users get

Hand-written runtimes, vendored into your output — not generated machinery, and not a dependency on
this project.

| | |
|---|---|
| [Authentication](./docs/sdk/authentication.mdx) | Bearer, API key, basic, OAuth2 client credentials with single-flight refresh and retry-once-on-401 |
| [Pagination](./docs/sdk/pagination.mdx) | Cursor, page and offset schemes, behind one iterator idiom per language |
| [Errors](./docs/sdk/errors.mdx) | A subclass per status, so `instanceof` narrows without a cast and `status` is literal-typed |
| [Retries](./docs/sdk/retries.mdx) | Exponential backoff with jitter, `Retry-After`, and idempotency keys so replay is actually safe |
| [Validation](./docs/sdk/validation.mdx) | The response is checked against the spec's shape; a broken contract fails at the SDK boundary |
| [Streaming](./docs/sdk/streaming.mdx) | Typed SSE events where the target supports it |
| [File uploads](./docs/sdk/file-uploads.mdx) | Multipart, with the language's native file type |
| [Webhooks](./docs/sdk/webhooks.mdx) | Signature verification and typed handlers |
| [Examples and tests](./docs/sdk/examples-and-tests.mdx) | One runnable example and one request-assertion test per operation, compiled with the package |
| [Custom code](./docs/guides/custom-code.mdx) | `#region` markers and `.graftignore`; ambiguous markers refuse to write rather than merge destructively |

### Repository

```
packages/
├── protocol/            the IR and target protocol. Depends on nothing but zod
├── core/                load → resolve → normalize → overlay → ir
├── cli/                 the graft binary
├── target-typescript/   IR JSON → file manifest, via ts-morph
├── target-python/       written *in* Python, gated by ruff and mypy --strict
├── target-go/           written *in* Go, gated by go/format and go build
├── target-php/          written *in* PHP, gated by php-cs-fixer and PHPStan
├── target-java/         written *in* Java, gated by google-java-format and javac
├── target-dotnet/       written *in* C#, gated by dotnet format and dotnet build
└── runtime-*/           hand-written transport, auth, retries, pagination, validation
corpus/
├── kitchen-sink/        hand-authored fixture covering every construct
├── twilio/              a real third-party spec, vendored and pinned (MIT)
├── vendor/              large specs fetched on demand — gitignored
└── private/             your own specs — gitignored, never redistributed
docs/                    user documentation (Mintlify)
tests/                   conformance and snapshot suites
```

`core` never imports a target; a target never imports `core`. Enforced in CI by
[dependency-cruiser](./.dependency-cruiser.cjs) — that boundary *is* the architecture.

### The tests that actually matter

```sh
pnpm verify   # build, typecheck, boundaries, tests, generate, diff, conformance, snapshots
```

> A typecheck gate proves output is *well-formed*, not that it is *useful*. An empty
> `interface Member {}` typechecks perfectly.

Which is why the real gate is the **cross-language conformance suite**: one scenario file, one mock
server, and a driver per language that calls its own generated SDK idiomatically. Twelve scenarios —
pagination, query serialization, path escaping, retry-then-success, no-retry-on-400, validation
catching a broken contract, no-retry-without-an-idempotency-key — asserted in six languages.

It checks two things, and neither subsumes the other: that each language matched the **expected wire
trace**, and that **every language observed the same thing**. A wrong expectation passes the first; a
shared bug passes the second. It found three real defects on its first run.

Snapshot tests cover the generated surface, and the diffs are reviewed rather than blindly accepted.

<sub>The Python, Go, PHP, Java and .NET suites are part of <code>verify</code> and <strong>skip
loudly</strong> when their toolchains are absent — someone working on the TypeScript target should
need none of them. Toolchains are pinned in <a href="./devbox.json"><code>devbox.json</code></a>, so
CI and the next contributor get the same versions rather than rediscovering them.</sub>

### Contributing

Read [`AGENTS.md`](./AGENTS.md) first. Two rules govern this repository, and both are enforced by
tests rather than by discipline:

- **Every decision goes in [`SPEC.md`](./SPEC.md)** — with the reasoning *and* the rejected
  alternatives, in the same turn it is made. Conversations are ephemeral; `SPEC.md` is the durable
  memory. It is a design document, not a changelog.
- **Every user-visible change goes in [`docs/`](./docs)** — a CLI flag, a config key, an
  `x-graft-*` extension, a diagnostic code. `packages/cli/src/docs.test.ts` fails the build if one
  exists in code and appears nowhere in the docs.

The quality bar is non-negotiable, because output quality is the entire value of the project:
generated code passes the target language's own strict typechecker as a build gate, is formatted by
that language's canonical formatter so it matches community style byte-for-byte, and is emitted via
ASTs or a structured code builder rather than string templates. Templates cannot manage imports,
deduplicate types, or restructure — which is why templated output reads as dead.

### The name is a working title

`graft` may change, so no user-facing string contains it: every occurrence is derived from
`BRAND_NAME` in [`packages/protocol/src/branding.ts`](./packages/protocol/src/branding.ts), and a
test fails the build if the name is hardcoded in a string literal anywhere else.

Generated output deliberately carries **no** generator branding. The runtime's base error is
`SDKError` — named for its role — which generated code aliases to `<ClientName>Error`. A
generator-branded class would make renaming this project a breaking change for every SDK it ever
produced.

### Get started

Docs in [`./docs`](./docs) — start with [`quickstart`](./docs/quickstart.mdx) · design notes and
rejected alternatives in [`SPEC.md`](./SPEC.md) · source and issues at
[github.com/papervine/graft](https://github.com/papervine/graft).

[MIT](./LICENSE) licensed — the least you have to think about before depending on it for your public
SDKs.
