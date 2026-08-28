# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Aider, etc.) working in this
repository. `CLAUDE.md` is a symlink to this file — there is one set of instructions, not two.

## What this project is

`besdk` is an open-source OpenAPI → SDK generator, targeting output quality on par with
Stainless, Speakeasy, and Fern. The goal is generated SDKs that are indistinguishable from
hand-written, idiomatic client libraries in each target language — and a project that cannot
strand its users, because it is open source and the spec is the source of truth.

## The one rule that matters most

**Everything we discuss goes in `SPEC.md`.**

Every design decision, architectural choice, tradeoff, rejected alternative, naming
convention, and open question that comes up in conversation must be written into `SPEC.md`
as part of the same turn it is decided. Conversations are ephemeral; `SPEC.md` is the
durable memory of this project.

Specifically:

- **Decisions** — write them down with the *reasoning*, not just the outcome. Future agents
  need to know *why* so they don't relitigate or accidentally reverse it.
- **Rejected alternatives** — record what we considered and discarded, and why. This is the
  most commonly lost and most valuable information.
- **Open questions** — anything unresolved goes in the Open Questions section with enough
  context that it can be picked up cold.
- **Corrections** — when a decision is reversed, update the decision in place and note the
  reversal. Don't leave `SPEC.md` self-contradictory.
- **Scope boundaries** — explicit non-goals belong in `SPEC.md` too.

If a discussion produces a decision and you do not update `SPEC.md`, the task is not done.
Update `SPEC.md` *before* or *alongside* implementing, never as a cleanup pass afterward.

`SPEC.md` is a design document, not a changelog and not a status report. Describe the system
as designed, in present tense. Don't narrate the history of the conversation.

## The second rule: user-facing changes go in `./docs`

`SPEC.md` and `./docs` have different audiences and neither substitutes for the other:

|  | `SPEC.md` | `./docs` |
|---|---|---|
| Audience | us — maintainers, future agents | users of the tool |
| Answers | *why* it works this way | *how* to use it |
| Contains | decisions, reasoning, rejected alternatives, internal architecture | tasks, references, examples |
| Format | one long design document | Mintlify MDX, one page per topic |

**Any change that alters something a user can see or type must land in `./docs` in the same turn
it lands in `SPEC.md`.** That is:

- a CLI command, flag, or exit code
- a `besdk.yaml` key
- an `x-besdk-*` extension
- a diagnostic code
- the shape of generated output — client construction, method signatures, error classes, pagination

Internal-only decisions stay in `SPEC.md` alone. Package boundaries, IR node shapes, and rejected
alternatives are not user documentation, and padding `./docs` with them makes it worse, not more
complete. The test is simply: *could a user act on this?*

Drift is guarded mechanically, not by discipline — `packages/cli/src/docs.test.ts` fails the build
if a CLI command, `besdk.yaml` key, extension key, or diagnostic code exists in code but appears
nowhere in `./docs`. Adding a flag without documenting it breaks CI.

Docs are Mintlify MDX: YAML frontmatter with `title` and `description`, `docs.json` for
navigation, and their components (`Steps`, `Tabs`, `CodeGroup`, `Card`, `Accordion`, `Note`,
`Warning`) where they earn their place. Prose first — a `<Card>` around one sentence is noise.

## Working agreements

- **Read `SPEC.md` first.** Before any non-trivial change, read `SPEC.md`. It is the
  authoritative description of intended design. If the code contradicts it, that's either a
  bug in the code or a stale spec — figure out which and say so.
- **Don't invent architecture silently.** If a task requires a design decision that
  `SPEC.md` doesn't cover, either ask, or make the call and record it in `SPEC.md` with
  reasoning. Never leave an undocumented architectural decision embedded only in code.
- **No speculative scope.** Build what was asked. Non-goals in `SPEC.md` are binding.
- **Report honestly.** If tests fail, show the output. If something is partially done, say
  which part. Don't claim verification you didn't perform.
- **Install the tools you need — `devbox` is available.** A gate you cannot run is a gate that
  is not enforced, so when a language needs a formatter, a typechecker, or a build tool that is
  not present, add it:

  ```sh
  devbox add maven jdk@17 google-java-format
  devbox run -- mvn -q verify
  ```

  Commit the resulting `devbox.json` and `devbox.lock`, so CI and the next agent get the same
  toolchain rather than rediscovering it. Never design around a missing tool — see the note in
  `SPEC.md` §3.4 about why that is the most expensive kind of shortcut.

## Quality bar

The entire value of this project is output quality. Machine-looking output is a bug.

- Generated code must pass the target language's own strict typechecker and linter as a
  build gate (`mypy --strict`, `tsc --noEmit`, `go vet`, etc.). Non-negotiable.
- Generated code must be formatted by the language's canonical formatter (ruff/black,
  prettier, gofmt) so it matches community style byte-for-byte.
- Prefer hand-written runtime libraries over generated machinery. Generate the thin API
  surface; hand-write the transport, retries, auth, and pagination internals. Hand-written
  code is where quality lives.
- Emit code via ASTs or a structured code builder, not string templates. Templates can't
  manage imports, deduplicate types, or restructure — that's why templated output reads as
  dead.

## Testing expectations

Two kinds of tests, both required for any generator change:

1. **Snapshot tests** against a corpus of gnarly real-world specs (Stripe, GitHub, and
   other pathological public specs). Output diffs are reviewed, not blindly accepted.
2. **Conformance tests** where every generated SDK runs the same scenario suite against a
   mock server, proving all languages behave identically at the wire level even though the
   code looks native to each.

A generator change without snapshot coverage is incomplete.

## Repository conventions

- `SPEC.md` — the design document. Source of truth for intent.
- `AGENTS.md` — this file. `CLAUDE.md` symlinks to it.
- `packages/protocol/src/branding.ts` — the project name and everything derived from it.

## The project name is a working title

`besdk` may change. Every user-facing occurrence is derived from `BRAND_NAME` in
`packages/protocol/src/branding.ts`, and a test fails the build if the name is hardcoded in a
string literal anywhere else. **Never write the project name into a string** — import `BRAND`.

Renaming is therefore:

1. Edit `BRAND_NAME` and `BRAND_TITLE` in `branding.ts`. This covers the CLI name, config
   filename, state directory, extension prefix, target-executable prefix, handshake flag, help
   text, diagnostics, and generated attribution.
2. Rename the workspace packages (`@besdk/*` → `@newname/*`) and their import specifiers. These
   are literals that no constant can abstract; `pnpm test` in `packages/protocol` lists them.
3. If the old name ever shipped, add its extension prefix to `LEGACY_EXTENSION_PREFIXES` so specs
   already annotated with `x-oldname-*` keep working.

What must **never** carry the project name is generated output that consumers depend on. The
runtime's base error is `SDKError` — named for its role — and generated code aliases it to
`<ClientName>Error`. A generator-branded class would make renaming this project a breaking change
for every SDK it ever produced.
