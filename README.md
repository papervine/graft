# besdk

An open-source OpenAPI → SDK generator whose output reads as hand-written.

```ts
import { Acme } from '@acme/sdk';

const client = new Acme({ token: process.env.ACME_TOKEN });

const widget = await client.widgets.create({ name: 'Sprocket' });

for await (const widget of client.widgets.list({ limit: 50 })) {
  console.log(widget.id);
}
```

No `id` on create, because the server assigns it. `list` is async-iterable, because that is what
TypeScript developers expect. `widgets.get(id)`, not `widgets.get_(id)`. And the response is checked
against the shape the spec promised, so a server that breaks its contract says so at the SDK boundary
rather than three frames into your code.

> [!NOTE]
> Early and incomplete. TypeScript, Python, and Go are implemented; `besdk` is a working title.

## Why

The good OpenAPI generators are almost all commercial. The open-source ones that produce output you
would actually ship tend to target exactly one language.

The realistic risk of depending on a commercial generator is not being stranded — generated SDKs keep
working if the vendor disappears, and your OpenAPI document is portable by design. The risk is a
**forced migration at an inconvenient time**, and it lands on *your* SDK's users as breaking changes
rather than on you alone.

besdk removes that risk without accepting the usual open-source quality penalty. Generated packages
have **no runtime dependency on besdk** — the transport, retries, auth, and pagination machinery are
hand-written and vendored into your output.

## Quickstart

```sh
pnpm install && pnpm build

pnpm --silent besdk check    openapi.yaml    # what your spec fails to say
pnpm --silent besdk init     openapi.yaml    # scaffold besdk.yaml
pnpm --silent besdk generate openapi.yaml --out sdks/typescript
pnpm --silent besdk generate openapi.yaml --target python --out sdks/python
pnpm --silent besdk generate openapi.yaml --target go     --out sdks/go
```

One spec and one config produce every language. The read/write split, the pagination scheme, and the
hoisted headers are decided once in the IR and apply to all of them.

Or against the corpus this repository ships:

```sh
pnpm demo                    # check the vendored Twilio spec
pnpm generate:all            # generate from every committed corpus entry
pnpm corpus:fetch            # download the large specs (Stripe, GitHub, Box)
```

Generation fails if the output does not pass the target language's own strict typechecker —
`tsc --noEmit`, `mypy --strict`, `go build`. That is deliberate, and the target decides which tools
those are.

Full documentation is in [`docs/`](./docs) — start with [`docs/quickstart.mdx`](./docs/quickstart.mdx).

## How it works

besdk does not generate from your OpenAPI document. It generates from an intermediate
representation.

```
OpenAPI ──► Normalizer ──► Semantic IR ──► Target ──► Gates
 + config   quirk           SDK concepts,   idiom      format,
            quarantine      language-       mapping    typecheck
                            neutral
```

The IR models **SDK concepts** — resources, methods, pagination, error taxonomy — not HTTP. The
decision "this API has a `widgets` resource with `list`, `get`, and `create`" is made once, so every
language stays consistent. Names are stored as token sequences (`["user","id"]`), because casing is a
target's decision.

A **target is a subprocess**: IR JSON on stdin, a file manifest on stdout. That boundary is what lets
the Python target be written in Python and the Go target in Go, each using its own formatter and
typechecker. The in-tree TypeScript target gets no shortcut around it; a plugin API nothing external
exercises rots.

Targets also declare their own **verification gates** in the handshake, so the core never learns that
"Python means ruff and mypy". That knowledge belongs to the target, and it means a third-party target
gets real gates rather than none.

## Commands

| | |
|---|---|
| `check` | Report what the spec fails to say. `--strict` gates CI |
| `init` | Scaffold `besdk.yaml`, with every inference written out explicitly |
| `generate` | Emit the SDK, then format and typecheck it |
| `diff` | What regenerating would do to your SDK's consumers. `--strict` gates CI |
| `ir` | Dump the intermediate representation |
| `targets` | Which targets are installed, and will they run |

## Repository

```
packages/
├── protocol/            the IR and target protocol. Depends on nothing but zod
├── core/                load → resolve → normalize → overlay → ir
├── cli/                 the besdk binary
├── target-typescript/   IR JSON → file manifest, via ts-morph
├── runtime-typescript/  hand-written: transport, retries, auth, pagination
├── target-python/       IR JSON → file manifest. Written *in* Python, using ruff and mypy
├── runtime-python/      hand-written: httpx transport, sync + async, pydantic models
├── target-go/           IR JSON → file manifest. Written *in* Go, using go/format and go build
└── runtime-go/          hand-written: net/http transport, typed errors, iterators
corpus/
├── kitchen-sink/        hand-authored fixture covering every construct
├── twilio/              a real third-party spec, vendored and pinned (MIT)
├── vendor/              large specs fetched on demand — gitignored
└── private/             your own specs — gitignored, never redistributed
docs/                    user documentation (Mintlify)
tests/                   conformance and snapshot suites
```

`core` never imports a target; a target never imports `core`. Enforced in CI — that boundary *is*
the architecture.

## Developing

```sh
pnpm verify   # build, typecheck, boundaries, tests, generate, diff, conformance, snapshots
```

The Python and Go suites are part of `verify`, and **skip loudly** when their toolchains are absent —
a contributor working on the TypeScript target should need neither. To set them up:

```sh
cd packages/runtime-python
uv venv .venv && uv pip install --python .venv/bin/python -e . ruff mypy pytest pytest-asyncio
# Go needs only a Go 1.22+ install; the target binary is built by `pnpm test:go`.
```

Read [`AGENTS.md`](./AGENTS.md) first. Two rules govern this repository:

- **Every decision goes in [`SPEC.md`](./SPEC.md)** — with the reasoning and the rejected
  alternatives, in the same turn it is made. Conversations are ephemeral; `SPEC.md` is the durable
  memory.
- **Every user-visible change goes in [`docs/`](./docs)** — a CLI flag, a config key, an extension, a
  diagnostic code. Enforced by a test, not by discipline.

The quality bar is non-negotiable: generated code passes the target language's own strict
typechecker as a build gate, is formatted by its canonical formatter, and is emitted via ASTs rather
than string templates.

> A typecheck gate proves output is *well-formed*, not that it is *useful*. An empty
> `interface Member {}` typechecks perfectly. That is why there are also conformance tests that run
> generated SDKs against a real HTTP server.

The conformance suite is **cross-language**: one scenario file, one server, and a driver per language
that calls its own generated SDK idiomatically. It asserts both that each language matched the
expected wire trace and that *every language observed the same thing* — neither check subsumes the
other, since a wrong expectation passes the first and a shared bug passes the second.

## Licence

[Apache-2.0](./LICENSE) — permissive, with a patent grant, so companies can depend on it for their
public SDKs.
