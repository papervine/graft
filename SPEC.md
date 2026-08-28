# besdk — Design Specification

An open-source OpenAPI → SDK generator whose output quality is competitive with the
commercial generators (Stainless, Speakeasy, Fern, Scalar).

This document is the durable memory of the project. Every design decision, tradeoff,
rejected alternative, and open question lives here. See `AGENTS.md`.

---

## 1. Motivation

The good OpenAPI→SDK generators are, almost without exception, commercial products. The good
open-source ones (openapi-generator, Kiota) produce output that reads as machine-generated;
the *genuinely* good open-source ones (`oapi-codegen`, `openapi-typescript`, `orval`,
`openapi-python-client`) achieve quality by targeting exactly one language.

### Why the commercial concentration exists

The software is hard in a boring, grinding way rather than an algorithmically clever way.
"Parse a spec, emit a typed client" sounds like a weekend project. What makes it brutal:

1. **The long tail of OpenAPI itself.** Real specs are full of `oneOf`/`anyOf` polymorphism,
   discriminators, circular `$ref`s, nullable-vs-optional ambiguity, unusual content types,
   streaming, ad-hoc pagination conventions, and outright spec violations that still have to
   be handled gracefully. Every new spec breaks the generator in a new way.
2. **N languages × M idioms.** Generating *working* Python is easy. Generating Python that
   feels hand-written — proper typing, async, retries, auth flows, pagination iterators, good
   docstrings — and then doing that equally well for TypeScript, Go, Java, Ruby, is an
   enormous ongoing maintenance surface. Each ecosystem also moves underneath you
   (Pydantic v1→v2, ESM vs CJS, and so on).
3. **The quality bar is "indistinguishable from artisanal."** That requires continuous human
   taste and per-language expertise. The work never ends and the marginal cost of the grind
   never reaches zero — which is precisely why it maps to a paid service rather than a
   community project.

### The trust problem this project addresses

The realistic risk of depending on a commercial generator is *not* "stranded with nothing" —
generated SDKs keep working forever if the vendor disappears, and the OpenAPI spec is
portable by design. The real risk is **forced migration at an inconvenient time**, and it
lands on your SDK's users as breaking changes rather than on you alone.

`besdk` exists to remove that risk without accepting the usual open-source quality penalty.

### Non-goals

- Not a spec *authoring* or spec *linting* tool. Input is OpenAPI; use existing linters.
- Not a server-stub generator. Client SDKs only.
- Not a hosted service. CLI and library, run in the user's own CI.
- **Not a 50-language checkbox project — in the sense that matters.** *Superseded twice; see
  §3.3.6 for the current language roadmap.* First written as "depth over breadth," meaning a
  small fixed set of in-tree targets. Then narrowed to: depth for blessed in-tree targets,
  breadth via a versioned public target protocol (§3.5). The surviving form is only the last
  sentence of that: the distinction that matters is not *how many languages exist* but
  *which ones we vouch for*. Nine blessed targets held to §"Quality bar" in `AGENTS.md` is
  not a checkbox project; one target plus a protocol nobody uses would be a different kind of
  failure. Third-party targets remain possible without forking and carry no quality promise
  from us.

### Enrichment, not just translation

A finding from the first corpus spec (§7), significant enough to state as a premise: **real
specs are under-specified, not merely irregular.** In `corpus/pixwel`, pagination, error
shapes, and field presence exist only in prose descriptions — machine-unreadable. Only 6 of
its 27 named schemas declare any `required` fields at all, and 182 of 186 error responses
declare no schema whatsoever.

So the generator's job is not only to *translate* a spec into an SDK; it is to *enrich* an
under-specified spec into a well-specified one. Two consequences:

1. The config overlay (§3.1) is a **primary user-facing surface**, not a patch kit for edge
   cases. Most of what makes output good on a real spec is expressed there.
2. Under-specification must be **surfaced, never silently papered over.** A generator that
   quietly emits an all-optional, error-untyped SDK has produced something that compiles and
   is useless. Hence `besdk check` (§3.6) is a first-class command, not a lint afterthought.

---

### 1.1 Two documents, two audiences

`SPEC.md` and `./docs` are not duplicates and neither substitutes for the other.

|  | `SPEC.md` | `./docs` |
|---|---|---|
| Audience | maintainers and future agents | users of the tool |
| Answers | *why* it works this way | *how* to use it |
| Contains | decisions, reasoning, rejected alternatives, internal architecture | tasks, references, examples |
| Format | one design document | Mintlify MDX, a page per topic |

**Any change to something a user can see or type lands in both, in the same turn**: a CLI command or
flag, a `besdk.yaml` key, an `x-besdk-*` extension, a diagnostic code, or the shape of generated
output.

Internal-only decisions stay here alone. Package boundaries, IR node shapes, and rejected
alternatives are not user documentation, and padding `./docs` with them makes it worse rather than
more complete. The test is whether a user could act on it.

**The rule is enforced, not merely stated.** `packages/cli/src/docs.test.ts` fails the build if a CLI
command, config key, extension key, or diagnostic code exists in code but appears nowhere in
`./docs`, and if `docs.json` navigation and the files on disk disagree. A documentation rule policed
only by discipline decays; this one cannot. It checks *presence*, not prose quality — a test cannot
judge whether writing is good, but it can catch the failure that actually happens, which is a flag
added and never written down.

**A guard that covers one nesting level of the thing it guards is worse than none, because it is
trusted.** The config-key check was scoped to `ConfigSchema`'s own body at one indentation depth,
which meant it saw 14 of the 31 keys a user can type — and not even all the top-level ones, since the
per-target schema is declared *above* `ConfigSchema` and fell outside the slice entirely.
`targets.<name>.idempotencyHeader` was added and shipped undocumented with the build green. The check
now matches any key followed by a zod expression, at any depth, anywhere in the file, and asserts a
floor on the count so a future narrowing fails rather than quietly reducing coverage.

**And a pattern that matches source has to tolerate however the formatter laid that source out.** The
widened check still required `z.` on one line, so `envPrefix: z\n  .string()\n  .regex(…)` — a chain long
enough for prettier to break — was invisible to it, and shipped undocumented with the build green. That is
the same failure as the paragraph above, one iteration later and from a different direction. The pattern
now allows whitespace between the identifier and the dot.

**`./docs` is organised by what a user is trying to do, not by how besdk is built.** Two groups do the
work: *What your users get* — authentication, pagination, errors, retries, validation, streaming, uploads,
and the support matrix — describes the SDK a consumer holds; *Shaping the SDK* — models, naming, server
URLs, custom code, enrichment — describes what the spec author configures. The distinction matters because
those are two different readers, and a page that serves both serves neither. Architecture lives under
Reference, after the CLI and config, because nobody needs the IR to use the tool.

The specific failure being corrected: the first version of these docs argued the design at the reader.
Pages opened with "## The problem" and explained what a naive generator would do wrong before saying what
to type. That is `SPEC.md`'s job. A user page states what happens, shows the call, and links the reasoning
if they want it.

**A support matrix is a required page, not a nicety** (`docs/sdk/capabilities.mdx`). Support across six
targets is genuinely uneven — file uploads in one, OAuth2 in three, streaming in three at three different
levels of usefulness — and a reader who commits to a language before learning that has been misled by
omission. The same page states what "not generated" means, because a skipped method with a warning is the
project's deliberate answer to a gap and reads as a defect unless explained.

*Rejected alternative:* generating the user docs from `SPEC.md`. The two have different audiences,
different structure, and different levels of detail; a mechanical projection would serve neither.

*Rejected alternative:* a "Concepts" group early in the navigation. It is where a maintainer would put
the interesting material and where a user would find nothing they need. `how-it-works` became
`Architecture` under Reference for exactly that reason.
The reference pages that *can* be generated safely — every diagnostic code, every CLI flag — are
instead **checked** against the code, which gets the drift protection without flattening the prose.

### 1.2 The project name is a working title

**Decision: every user-facing occurrence of the project name is derived from one constant**
(`BRAND_NAME` in `packages/protocol/src/branding.ts`), and a test fails the build if the name
appears in a string literal anywhere else.

Renaming a tool is normally expensive because the name leaks into filenames, extension keys, state
directories, help text, and — worst — into generated output that other people's code depends on.
`besdk` is provisional, so that cost is paid up front instead.

The distinction that decides where each occurrence belongs:

> **A name in our files is an inconvenience. A name in generated files is a compatibility
> promise.**

Only the first kind belongs in a constant. The second kind must not exist at all:

- The runtime's base error is `SDKError`, named for its **role**. A generator-branded class would
  put this tool's name into every consumer's `catch` block, making a rename here a breaking change
  for every SDK ever produced. Generated code additionally aliases it to `<ClientName>Error`, so
  the brand a user sees is *their own* — the shape `OpenAIError` has.
- Generated attribution in a README does name the tool, which is correct: vendored and generated
  code should say where it came from.

**Only Go gets a per-file `Code generated by … DO NOT EDIT.` header, and the asymmetry is
deliberate.** In Go that line is machine-read: `gofmt`, `go vet`, and most linters skip a file whose
first line matches `^// Code generated .* DO NOT EDIT\.$`, so omitting it would make generated code
lint like hand-written code. Nothing in the TypeScript or Python toolchains reads an equivalent
marker, so there it would be pure decoration — and worse, a false statement, since `preserve` regions
(§3.6) explicitly invite editing generated files inside marked blocks. Those targets carry attribution
in the README instead, where it is true.

Not centralized, deliberately: **workspace package names** (`@besdk/*`) and import specifiers are
literals no constant can abstract. They are a mechanical pass, and the guard test lists them. The Go
runtime's package name is not among them: it is `core`, named for its role, which is also why the
vendored copy in a generated SDK is byte-identical to the source rather than rewritten on the way in.

**A rule enforced in one language of a three-language project is not enforced.** The guard scanned
only `.ts` files, and the Go target is written in Go — so it accumulated five copies of
`"Code generated by besdk. DO NOT EDIT."`, landing the name in the one place it must never appear.
The Python target had the opposite failure: no attribution at all, because nothing told it to. The
guard now scans `.ts`, `.py`, and `.go`.

**Decision: the brand strings a target emits are carried in `TargetInput.brand`, and the field is
required.** A target in another language cannot import `branding.ts`, so it has exactly two options:
hardcode the name, or be told. Making the field *optional* would force a hardcoded fallback and
reintroduce what the rule forbids, so it is required — a target can rely on it. This also means a
third-party target is correct without being asked, which no amount of documentation achieves.

**Decision: the handshake flag carries no project name.** It is `--sdk-target-protocol`, the one
string in `BRAND` deliberately *not* derived from `BRAND_NAME`. A target hardcodes this flag because
it cannot import the constant that owns it — which makes the flag a promise to third-party target
authors, and a rename would break every target ever written against it. That is a *worse*
compatibility promise than generated files, since those can at least be regenerated. Same argument
for `SDK_GO_RUNTIME`, the Go target's runtime-discovery escape hatch.

The general principle, which subsumes both: **a string this project's name must not appear in is any
string another language's source has to write.** Only TypeScript can import the constant.

**If the name ever changes after release**, the old extension prefix goes in
`LEGACY_EXTENSION_PREFIXES`. Specs in the wild annotated with `x-oldname-*` still state the API
owner's intent, and our rename must not silently stop honoring them — the same argument as reading
another vendor's extensions (§3.1.5), applied to our own history.

The rename procedure is in `AGENTS.md`, where an agent will actually read it.

---

## 2. Core architectural decision

**Do not generate code from the OpenAPI spec. Generate it from an intermediate
representation.**

The spec is an *input format*, not a data model. OpenAPI is too lossy, too flexible, and too
irregular to template against directly. Templating straight off the spec is the mistake
swagger-codegen made, and it is the root cause of its machine-made output.

Every serious generator converged on this independently. So do we.

```
OpenAPI spec ──► Normalizer ──► Semantic IR ──► Language generators ──► Post-processing
  (+ config      (quirk         (SDK concepts,   (idiom mapping,        (format, typecheck,
   overlay)       quarantine)    lang-neutral)    AST emission)          lint, verify)
```

### 2.1 Implementation language: TypeScript

**Decision: the `besdk` core is written in TypeScript.** Reasoning, in the order that
actually decides it:

1. **The target protocol (§3.5) removes the strongest objection.** Because targets are
   subprocesses that speak IR JSON, the core performs *no AST emission at all*. Its job is
   parsing, `$ref` graph work, normalization, IR construction, subprocess orchestration, and
   gate-running. "Which language has the best AST library" is a question about *targets*, not
   the core.
2. **Generating TypeScript requires Node regardless.** `target-typescript` uses `ts-morph`;
   hand-rolling a TypeScript printer in another language is exactly the "templated output
   reads as dead" trap. So a Go core would mean a Go binary *plus* Node on the primary path —
   two runtimes, and Go's single-static-binary advantage evaporates precisely where it was
   supposed to pay.
3. **Rust is the right answer to the wrong timeline.** The normalizer is where Rust's
   exhaustive matching would genuinely shine. But §5 says IR mistakes only surface under ugly
   input, i.e. expect heavy churn — and churn plus Rust is slow. Strict TypeScript with
   discriminated unions and no `any` recovers a useful fraction of that safety far cheaper.
4. **Contributor pool.** This project's value depends on community targets and public
   arguments about taste; TypeScript has the largest pool overlapping "people with opinions
   about SDK ergonomics."

**Switch condition, recorded so it needn't be re-derived:** move the core to Go if the
roadmap's centre of gravity becomes Go/Java/C# targets rather than TypeScript/Python, or if
single-binary distribution into Node-less CI becomes a hard requirement. This is cheap by
construction — the IR JSON boundary is the stable contract, so the core can be reimplemented
without touching a single target.

**Rejected alternatives:** Go (loses ts-morph, adds a second runtime — see 2 above); Rust
(iteration cost lands during peak IR churn — see 3); Python (weakest CLI distribution story,
and the first target is not Python).

---

## 3. The pipeline

### 3.1 Normalizer — the quirk quarantine

All OpenAPI ugliness dies here, once, so that no language generator ever sees it.
Responsibilities:

- Resolve every `$ref`, including circular ones.
- Flatten `allOf` compositions.
- Disambiguate nullable-vs-optional (the two are conflated constantly in real specs).
- Synthesize stable names for anonymous inline schemas.
- Detect and tag common patterns: pagination styles, error envelopes, streaming endpoints.
- Absorb real-world spec violations without crashing.

**Config overlay.** A user-supplied config file (`besdk.yaml`) supplements what the spec
cannot express — "this endpoint paginates by cursor," "group these operations under a `users`
resource," "this string is really an enum." Equivalent in role to Stainless's config or
Fern's `generators.yml`. Design deliberately: this file is the primary user-facing surface
for quality tuning, and it must stay hand-editable and reviewable in a PR.

Precedence is **explicit config > `x-*` extensions > inference**, and *every inference is
reported* (§3.6) rather than applied silently.

**Decision: `x-fern-*` extensions are read natively** as an overlay source. `x-fern-sdk-group-name`
and `x-fern-sdk-method-name` carry exactly the resource/method grouping besdk needs, and the
first corpus spec already annotates 121/121 operations with both. Reading a competitor's
annotations is not an accident of convenience — it is a direct migration path *off* a
commercial generator, which is the anti-lock-in thesis in §1 made concrete. Other vendors'
extensions get the same treatment as they are encountered.

#### 3.1.1 Read/write model conflation

**This is the highest-leverage normalizer concern, and it is easy to miss.** Real specs
routinely `$ref` a single schema from both request and response position. In `corpus/pixwel`,
`AssetsResponse` is the target for six distinct roles: list item, get response, create request
body, create response, update request body, and update response.

Translated naively, that yields `assets.create({ _id: … })` — nonsense, because `_id` is
server-owned. And because such schemas typically declare nothing `required`, the result
*typechecks* while being unusable. This is the exact failure mode where machine-generated
output is worst: it looks fine and is wrong.

The normalizer therefore **detects** request/response co-use and, guided by config, splits the
schema into read and write models (`Asset` / `AssetCreate` / `AssetUpdate`), omitting
server-owned fields from write models. Detection is automatic and always reported; the split
is config-driven because only the API owner knows which fields are server-owned.

#### 3.1.2 Normalizer rules

Each rule below was earned from a real spec, not anticipated. New rules must cite the corpus
entry that motivated them.

| Rule | Input | Output |
|---|---|---|
| `readWriteSplit` | schema used in both request and response position | `Asset` / `AssetCreate` / `AssetUpdate`; server-owned fields dropped from write models |
| `phpEmptyMap` | `oneOf: [{object, additionalProperties: T}, {array, maxItems: 0}]` | `map<string,T>`; runtime coerces `[]` → `{}` |
| `structuralDedupe` | structurally identical inline schemas (e.g. `{error: string}` repeated) | one synthesized named type |
| `nameSynthesis` | inline schema at `paths./assets.post.requestBody` | deterministic name from path + role, never `Schema1` |
| `emptySchema` | `schema: {}` | `unknown` — **never** `any` |
| `scalarUnion` | `oneOf: [string, integer]` | tagged `CoercedScalar`; the target decides representation |
| `constHeaderHoist` | a header param with a fixed value on every operation | runtime default header, removed from method signatures |
| `paginationInference` | `limit`+`offset` params plus a prose total-count header | offset scheme; config confirms |
| `requirednessReport` | a schema with no `required` fields | honored as written, but reported loudly |

Two of these deserve comment:

- **`phpEmptyMap`** exists because a serialization artifact must not become a permanent API
  wart. The corpus spec self-documents it: *"An empty map, which PHP serializes as `[]`."* It
  is not a union, and modelling it as one would force every SDK user to branch forever. The
  union collapses to a map and the *runtime* absorbs `[]`.
- **`constHeaderHoist`** exists because the corpus spec attaches an `Accept` header parameter
  to all 121 operations (omitting it makes the API return HTML and 500). Left alone it appears
  in 121 method signatures. Hoisting it into runtime defaults is the kind of taste judgment
  that separates good output from correct-but-dead output.

**Do not sanitize names you do not understand.** `/translations/ass` maps to a method named
`ass` — that is the ASS subtitle format, and "fixing" it would be wrong. Renaming is a config
decision, never an automatic one.

#### 3.1.7 Discriminated unions, and `anyOf` versus `oneOf`

**Decision: a discriminator narrows the *member* types, not the union.**

The IR already carried the discriminator and its full mapping — `{"member.invited":
"MemberInvitedEvent"}` — and every target threw it away. The consequence was a union nobody could use:
`MemberInvitedEvent.type` was typed `string`, so after `if (event.type === 'member.invited')` a
TypeScript caller still had no access to `event.member`, and pydantic had no way to pick a branch.

The fix is to put the information back where the language can act on it. A mapping entry is an
assertion by the spec author that *this schema has that discriminator value*, so the member's
discriminator field becomes a literal. Then narrowing is free: TypeScript narrows a union of object
types on a literal property with no help, and pydantic's `Field(discriminator=…)` needs exactly this to
work. Nothing in the targets has to understand discrimination at all.

**Narrowing the member, not the union, is what makes this work for a type used in two places.** A
schema referenced both inside a union and standalone keeps one definition, and the literal is correct
in both — the spec asserted it. What is *not* safe is a schema mapped to two different values in two
unions, which is contradictory; that keeps the wider type and produces a diagnostic rather than
silently picking one.

**Decision: `anyOf` and `oneOf` are recorded distinctly but validated identically.**

They mean different things — `oneOf` is exactly one branch, `anyOf` is at least one — and until now
besdk read them through the same line of code. The distinction is now carried in the IR as
`combinator`, because throwing away what the spec said is how a generator ends up unable to explain
itself later.

Validation still accepts a value matching *more than one* branch of a `oneOf`. That is deliberate: a
strict reading would reject data the server legitimately sent, which violates the rule that an API
which *grew* must not break a client (§3.4.1.1). The stricter reading is not more correct in practice
because overlapping branches are extremely common in real specs — usually because two schemas share
most of their fields and the author never intended exclusivity.

What the distinction *does* buy is a diagnostic. A `oneOf` whose branches cannot be told apart — no
discriminator, and structurally overlapping — is a spec that will decode ambiguously in every language,
and that is exactly the class of thing `besdk check` exists to surface rather than absorb silently.

**Two things this work found that were not about unions at all.**

**The schema walker descended into vendor extensions.** The first run of the ambiguity check reported
46 problems in Stripe, every one inside `x-expansionResources` — Stripe's own metadata about which
fields *its* tooling can expand, which happens to contain a `oneOf` of every expandable resource. A
diagnostic with 46 false positives is not a diagnostic. Fixed in `walkSchemas` rather than in the one
check, because every check reading that stream had the same exposure: an `x-*` key can contain anything
shaped like a schema and meaning something else. Stripe now reports 0; GitHub's 57 and Box's 22 survive
and are genuine — GitHub really does return `validation-error | validation-error-simple` with nothing to
tell them apart.

**Type changes in `besdk diff` were unconditionally breaking**, which is the same mistake required-ness
once made: it ignores direction. Narrowing and widening break *opposite sides*.

| | read model | write model |
|---|---|---|
| narrowed (`string` → `'a'`) | **additive** — still assignable, and now narrowable | **breaking** — values callers used to send are rejected |
| widened (`'a'` → `string`) | **breaking** — code relying on the narrower type must handle more | **additive** — callers may send more |

This surfaced because the narrowing pass *is* such a change, and `diff --strict` failed the build on it.
The fix is deliberately narrow in what it recognises — only a primitive-to-literal shift of the same base
type — because a general assignability analysis over the IR is a much larger thing, and guessing wrong
would mislabel a genuinely breaking change as safe. Everything unrecognised stays breaking, which is the
conservative direction.

It is also a real improvement to the differentiator in §8: direction-sensitive classification now covers
two axes rather than one.

### 3.2 Semantic IR — the whole ballgame

The IR does **not** model "HTTP operations with schemas." It models **SDK concepts**:

- resources and methods
- request/response types
- auth strategies
- pagination iterators
- retry policies
- streaming responses
- error taxonomy

It is **language-neutral but SDK-opinionated**. The decision "this API has a `Users` resource
with `list`, `get`, `create` methods" is made exactly once, here — not five times in five
generators.

**This is where uniformity comes from.** Every generated SDK has the same conceptual
structure, method organization, and error hierarchy because all of them are projections of
the same IR.

Names are stored abstractly in the IR (e.g. `user_id` as a token sequence), never
pre-formatted — casing is a generator concern.

### 3.3 Language generators — where idiomaticity lives

Each generator answers exactly one question: *how does this language express each IR
concept?* Examples of the mapping:

| IR concept | Python | TypeScript | Go |
|---|---|---|---|
| paginated list | generator: `for page in client.users.list()` | `AsyncIterable` | iterator with `.Next()` + explicit error returns |
| optional field | `NotGiven` sentinel vs `None` | `?` optional property | pointer or `Option[T]` wrapper |
| error taxonomy | exception hierarchy | error classes + type guards | sentinel errors + `errors.As` |
| naming | `user_id` | `userId` | `UserID` |

Two implementation choices matter enormously:

1. **Emit ASTs / use a structured code builder — never string templates.** Templates cannot
   reason about imports, cannot deduplicate types, cannot restructure. This is why templated
   output feels dead.
2. **Hand-write the runtime; generate only the thin API surface.** Retry logic, auth
   handling, HTTP transport, and pagination machinery live in a small hand-written
   per-language runtime library that generated code calls into. Generation should touch as
   little code as possible.

#### 3.3.1 TypeScript idiom decisions

Recorded because these are exactly the "hundreds of small judgment calls" of §4, and because
each was either argued for or fixed after reading real output.

| Decision | Reasoning |
|---|---|
| Path params positional, body next, `options` last | `assets.get(id)` / `assets.update(id, body)` — the ordering every mainstream TS SDK uses, so it needs no learning |
| Query + non-constant headers collapse into one optional `params` object | 16 positional arguments is not an API; `params` is required only when a member is required |
| `interface`, never `class`, for models | structural, zero runtime cost, accepts plain object literals |
| Literal unions, never `enum` | TS `enum` emits runtime code and is widely avoided; open enums union with `(string & {})` so a new server value is not a decode failure |
| `unknown`, never `any` | forces narrowing at the call site; `any` silently disables the gate that justifies the whole pipeline |
| `?` for absent, `\| null` for null | the presence/nullability distinction from §3.1 must survive into the emitted type or it was pointless |
| Reserved words are fine as *member* names | ES5+ allows them, so `assets.delete(id)` and `.get(id)` stay intact. Suffixing to `delete_`/`get_` is a tell-tale generated-code smell. Bindings still get suffixed |
| Resource class gains a `Resource` suffix only on collision | `session` yields both a `Session` model and a session resource; the class name is invisible to callers, who write `client.session`, so disambiguating there is free |
| `Paginator` is both `AsyncIterable` and `PromiseLike` | `for await` walks items, `await` gives the first page — one return value, no `listPaginated` twin |
| Index signature unions in every property type | `{ playlist?: string; [key: string]: string }` is a TS error; the index type must be a supertype of all properties |
| An explicit `.prettierrc.json` ships with the output | otherwise formatting depends on whatever config sits above the output directory, and regeneration is not byte-stable |
| Client class takes **no `Client` suffix** | Fern defaults to `${Namespace}Client`; Speakeasy defaults to the generic `SDK`. Neither matches the SDKs people enjoy using: `new OpenAI()`, `new Anthropic()`, `new Stripe()`. `new X()` already says "construct a client", so the suffix is redundant |
| Client name preserves the author's casing | `service.displayName` carries `info.title` verbatim, because `name.tokens` is lowercase by contract and re-casing it yields `OpenAi` and `IbmCloud` — flattening an initialism the author spelled correctly. Used when it forms a valid identifier with an uppercase initial; otherwise the tokens are cased |
| Document-descriptive words are stripped from the title | `Stripe API` → `Stripe`, not `StripeAPI` — nobody writes `new StripeAPI()`. Deliberately narrow: only `API`/`REST API`/`OpenAPI`/`Specification`/`Service`. `Platform` and `Cloud` are plausibly brand, and renaming someone's product is worse than a slightly long name they override in one line |
| Wire names are kept verbatim on model fields | `display_name` stays `display_name`. Renaming to `displayName` would require a serialization layer on every request and response, and a lossy one wherever the mapping is not bijective. Stripe's and OpenAI's TypeScript SDKs do the same. The IR still carries `name.tokens`, so Python and Go targets can recase — that decision belongs to each target |
| Sub-resources nest | `orgs.invoices` becomes `client.orgs.invoices`, not `client.orgsInvoices`. Flattening discards structure the spec took trouble to express |
| Streams are `AsyncGenerator<T>` | the same shape pagination uses, so `for await` works on both. Consistency beats exposing each protocol's peculiarities |
| Non-JSON text is `string`, opaque bytes are `Blob` | typing a CSV export as a `Blob` forces callers to unwrap something that was always text |
| Synthesized names never shadow a JS/DOM global | a model called `Error` or `Response` shadows the built-in for any module importing it, and fails confusingly rather than loudly. Applies only to names *besdk* chooses — a component the spec itself names `Event` keeps that name |

**Two bugs worth remembering, both found only by reading emitted output:**

- Spreading paginator-controlled params *before* the static query object let an `undefined`
  overwrite the computed offset, so every page after the first refetched page one and the
  iterator returned duplicates forever. Paginator-driven parameters are now excluded from the
  static object and `...page` is spread last. Pinned by a conformance test asserting the actual
  offset sequence.
- Referencing a `*Params` interface without emitting it. Caught by the `tsc --noEmit` gate,
  which is the argument for the gate being non-negotiable rather than advisory.

#### 3.3.2 Python idiom decisions

The second target exists to answer one question: **is the IR actually language-neutral, or is it a
TypeScript IR with the serial numbers filed off?** That risk compounds with every language added, so
it is worth paying early. The answer so far is recorded honestly in §3.3.3.

**Decision: the Python target is written in Python.** It uses Python's own tooling — `ruff format`
for layout, `mypy --strict` as the gate — because that is the only way output matches what the
community writes. This is also the first genuine exercise of the target protocol by something that
is not a Node program, which is the point of the protocol existing (§3.5).

**Decision: a structured code builder, not the `ast` module.** AGENTS.md permits "ASTs *or* a
structured code builder", and for Python the builder is correct on evidence rather than taste:
`ast.unparse` **discards comments entirely** — `ast.unparse(ast.parse("x = 1  # keep"))` returns
`"x = 1"`. Preservation regions are comments (`# region`), so an `ast`-based target could not
support the feature the `lineComment` handshake field exists to enable. A secondary consideration:
building one four-line class through `ast` node constructors takes about thirty-five lines and a
`fix_missing_locations` call, which buys nothing here because `ruff format` is what decides layout.

The builder keeps the properties that "no string templates" is actually about: a module is a
*model* of declarations, imports are collected and rendered once, and names are resolved against
what the module already declares.

**Decision: pydantic v2 for read models, `TypedDict` for write models and params.**

This is what the two Python SDKs people most enjoy — OpenAI's and Anthropic's — both do, and the
reasoning survives inspection: a response is something you *receive*, so attribute access
(`widget.id`) and validation are what you want; a request body is something you *construct*, so a
`TypedDict` lets callers pass a plain dict literal and still be checked structurally.

It also lands the IR's read/write split (§3.1) exactly onto a distinction the language already
makes, which is the strongest evidence so far that the split was modelled at the right level: a
`role: 'read'` object becomes a `BaseModel`, a `role: 'create'` or `'update'` object becomes a
`TypedDict`. Nothing in the target has to infer it.

One consequence worth stating plainly: **the Python target validates responses at runtime and the
TypeScript target does not.** §8 lists response validation as a Tier 1 gap, and pydantic closes it
for free on this target only. That asymmetry is a real inconsistency in the product, not a feature,
and it belongs in the open questions (§9) rather than being quietly enjoyed.

**Decision: both a sync and an async client, from one IR.** `Widgets` and `AsyncWidgets`, `Acme` and
`AsyncAcme`. Python has no equivalent of `await` working on both, and shipping only one half is the
single most common complaint about generated Python SDKs. The protocol anticipated this with the
`sync-and-async` capability, so the core already knows how to ask.

**Decision: httpx for transport.** Sync and async share one API surface, which is what makes the two
client hierarchies thin rather than duplicated. It is also what OpenAI, Anthropic, and most modern
Python SDKs use, so it is not an unusual dependency to inherit.

| IR concept | Python rendering | Reasoning |
|---|---|---|
| read model | `class Widget(BaseModel)` | attribute access and validation on data you receive |
| write model / params | `class WidgetCreate(TypedDict)` with `NotRequired[...]` | callers pass dict literals; structural typing checks them |
| optional vs nullable | `NotRequired[T]` vs `T \| None` | the presence/nullability distinction of §3.1, expressed natively |
| field names | `snake_case`, and the wire name is already snake in most specs | Python's convention; `alias` carries the wire name where they differ |
| enum | `Literal['a', 'b']`, open enums `Literal[...] \| str` | matches the TypeScript decision for the same reason: a new server value must not be a decode failure |
| paginated list | `for widget in client.widgets.list()` — the page object *is* iterable | Python iterates items, not pages; `.pages()` is available for the envelope |
| error taxonomy | exception hierarchy, `except NotFoundError` | narrowing by `except` is the language's own mechanism |
| reserved words | trailing underscore, but only where actually required | `from_` is unavoidable and idiomatic; `delete` is not a keyword, so `client.widgets.delete(id)` stays |
| unknown data | `object`, never `Any` | `Any` disables the `mypy --strict` gate that justifies the pipeline, exactly as `any` does in TypeScript |

#### 3.3.4 Go idiom decisions

Go is the first target with no exceptions, no garbage-collected-dynamic-language conveniences, and a
community style enforced by a formatter with zero options. It is the strongest available test of
whether the IR describes *SDK concepts* or merely describes them the way a scripting language would.

**Decision: the Go target is written in Go**, using `go/format` (which is `gofmt`) as its formatter
and `go build` plus `go vet` and `staticcheck` as its gates.

**Decision: a structured code builder, not `go/ast`.** Same conclusion as Python (§3.3.2) and again on
measured evidence rather than preference — but for a *different and worse* reason:

- A synthesized `ast.File` has no valid `token.Pos` on any node, so the printer cannot space
  declarations correctly. Emitted output puts a doc comment flush against the `package` clause.
- Far worse: **re-printing relocates comments out of function bodies.** Parsing
  `func f() { // region custom }` and printing it back yields `func f() {\n}\n// region custom` — the
  marker escaped the function and landed at file scope. `ast.File.Comments` is a flat, position-keyed
  list, and a fresh `FileSet` breaks the association.

That second behaviour is disqualifying on its own. Preservation regions live *inside* a struct's
method set, and a code-preservation feature whose markers migrate to the wrong scope on every
regeneration would silently destroy the user's code — the failure mode §3.9 exists to prevent.

So: build a model of declarations, render to text, and hand the text to `go/format.Source`. Since that
function *is* gofmt, output is byte-identical to what `gofmt` produces, which is what the quality bar
actually requires.

**The pattern across three targets is now clear enough to state as a rule.** Emit through the
language's AST only when its AST library is designed for *synthesis* — ts-morph is; `ast` and `go/ast`
are designed for *analysis* of code that already exists, and both lose or move comments. Where the AST
is analysis-oriented, a structured builder plus the canonical formatter is the correct choice, and it
preserves the properties that "no string templates" is really about: managed imports, deduplicated
types, and layout decided by a tool rather than by whitespace in the generator.

| IR concept | Go rendering | Reasoning |
|---|---|---|
| every method | `func (r *Widgets) Get(ctx context.Context, id string) (*Widget, error)` | `context.Context` first and `error` last are not stylistic in Go; an SDK without them is unusable in real services |
| optional field | `*string`, plus `acme.String("x")` helpers | Go has no absent-versus-null distinction other than the pointer, and constructing one inline requires a helper. Stripe's Go SDK does the same |
| optional parameter | a `*WidgetListParams` struct with pointer fields | Variadic functional options are idiomatic for *client* construction, not for per-call parameters, where a struct is what every major Go SDK uses |
| read/write split | distinct structs, `Widget` and `WidgetCreateParams` | The split lands on Go's grain too: params structs carry pointers, read structs carry values |
| enum | `type Role string` with `RoleOwner Role = "owner"` constants | Open by construction — an unknown value is still a valid `Role`, which is exactly the property §3.3.1 wants |
| error taxonomy | `*APIError` with typed subclasses, matched by `errors.As` | The language's own mechanism, as `except` is Python's and `instanceof` is TypeScript's |
| paginated list | an explicit iterator: `for it.Next(ctx) { ... }; it.Err()` | Range-over-func needs Go 1.23; an iterator with `Next`/`Current`/`Err` works everywhere and is what Google Cloud and Stripe ship |
| naming | `UserID`, `HTTPSPort`, `APIKey` | Go capitalises initialisms wholly. This is the first target where `pascal(tokens)` is *wrong*, which is a genuine test of names-as-tokens |
| unknown data | `any` | Unavoidable and idiomatic in Go; unlike TypeScript's `any` it does not disable type checking, it is the top type |
| absent versus null | pointer versus `json:",omitempty"` | Imperfect: Go's encoder cannot distinguish "omit" from "null" without a wrapper type, so the runtime marshals params explicitly |

**Go's functional options force structure, not cosmetics.** `Option` is `func(*core.ClientOptions)`,
applied *after* the options struct is built, so anything a generated constructor would compute from an
option's value cannot be computed inline. That is why templated server URLs resolve in the Go runtime
and in the other two targets' constructors (§3.4.0.2). Worth naming as a category rather than a
one-off: whenever a decision depends on a value an option supplies, Go needs the decision deferred
past option application, and the runtime is where that deferral lives.

**A generated file emitted only under a condition needs the condition to cover everything in it.**
`schemas.go` holds two symbols — the named-type descriptor table and the per-operation response map —
and was emitted only when the *table* was non-empty. A spec whose every response is `[]string` has no
named types and a non-empty response map, so the file was skipped while resource methods still
referenced both symbols: an SDK that does not compile. It passed every corpus spec because each of them
declares named types. The gate now consults both collections, and the response map was extracted into a
method so the gate and the file read the same source.

**A declared capability with no implementation behind it is worse than an absent feature.** Go's handshake
declared `multipart-requests`, and the runtime genuinely supported them — `Request.Multipart`, `FilePart`, a
`multipart.Writer`. The *target* never set the field, so a `multipart/form-data` operation generated a method
that marshalled its body as JSON and sent it to an endpoint that cannot read JSON. It compiled, passed `go
vet`, and read as correct; only the server would ever object. Multipart operations are now skipped with a
`GO002` warning and the capability is not declared. The general rule this instantiates: **the capability list
is a promise about the target, not the runtime**, and the two can drift precisely because the runtime is
hand-written and tested while the code that reaches it is generated. Every capability any target declares
should be traceable to a line in the *target*.

This is also why the skip is decided before the file's imports are chosen rather than inside the method
emitter. The first version returned an empty declaration from `method` and skipped it at the call site, which
left a resource whose only operation was multipart importing `context` and never using it — an SDK that does
not compile. **A conditional emission changes what the surrounding file needs**, so the condition has to be
evaluated before anything derived from it.

#### 3.3.3 What the second language actually proved

The Python target exists to answer whether the IR is language-neutral or merely a TypeScript IR in
disguise. The honest answer: **the IR needed no changes at all**, and one field turned out to be
better designed than intended — but the *target protocol* needed two additions, and the emitted-code
defects were almost entirely Python-specific name collisions.

**What held up.** Every semantic decision was reusable as-is. Names as lowercase token sequences did
exactly the job they were designed for: `["user","id"]` became `user_id` here and `userId` there with
no coordination. `role` on an object type turned out to land *precisely* on a distinction Python
already makes — `read` → pydantic `BaseModel`, `create`/`update` → `TypedDict` — which is stronger
evidence for the read/write split than anything the TypeScript target could provide, because a second
language independently wanted the same boundary. Pagination schemes, the error taxonomy, and the
constant-header hoist all transferred without argument.

**What the protocol was missing.** Two things, both now fixed:

- **Targets must declare their own verification gates** (`Handshake.gates`). The core previously
  hardcoded prettier and `tsc`, which meant a non-TypeScript target had *no* gates — and the core
  growing a table of "Python means ruff and mypy" is exactly the §3.7 violation the boundary exists
  to prevent. A gate also has a `kind`: `'fix'` runs for side effects and ignores the exit code,
  `'verify'` treats non-zero as failure. That distinction is not cosmetic — `ruff check --fix` exits
  non-zero for what it *could not* fix, but at that point the formatter has not run, so treating it as
  a verdict failed generation on a line the very next step would have wrapped.
- **`targets.<name>.command`**, an argv escape hatch. §3.5 already claimed targets resolve "on `PATH`
  or via `besdk.yaml`"; only the first half was implemented. A target written in another language is
  neither an npm package nor necessarily installed during development, so the claim had to become
  true.

**A structured builder, not `ast`.** Recorded in §3.3.2 with the evidence: `ast.unparse` discards
comments, and preservation regions *are* comments.

**Sixteen defects, found by reading output and running it.** The two gates between them caught most
of these, but the ones that mattered most were invisible to both:

| Defect | How it was found |
|---|---|
| **Every request body silently dropped** — the IR field is `body`, not `request` | Reading the output: `publish()` took no arguments |
| **Pagination never detected** — the field is `paginationId`, not `pagination` | Reading the output: every paginated method returned one page |
| **The client would not accept `http_client`** | Trying to write a test against the generated SDK |
| `from .models import BankAccount \| Card` — a syntax error | `ruff` |
| A docstring ending in `"` made the delimiter four quotes | `ruff` |
| A model named `Field` shadowed `pydantic.Field` | `mypy`, as 393 errors from one collision |
| A field named `object` shadowed the `object` annotation | `mypy` |
| A method named `list` shadowed `list[X]` in its own class body | `mypy` |
| A field named `validate` collided with `BaseModel.validate` | `mypy` |
| Two GitHub fields both sanitising to `_1`, one silently lost | `mypy` |
| A query parameter named `query` captured the body's `query` local | `mypy` |
| `NotRequired` imported from `typing` on a package declaring 3.10 | `mypy` |
| Module files named `Api20100401Address.py` | Reading the output |
| `datetime` imported into every module once any module needed it | `ruff` |
| Docstrings three characters over the limit, in 424 places | `ruff` |
| An invalid `version` in `pyproject.toml` | `ruff` — see below |

Four of these generalise past Python:

1. **Reading the wrong IR field is the worst failure mode there is.** `method.get("request")` instead
   of `method.get("body")` is a one-word mistake that produces an SDK which typechecks, lints,
   imports, and cannot send a request body. No gate can catch it. The only thing that caught it was
   running the generated SDK against a mock server and asserting on the wire, which is why the
   conformance suite is not optional and why the corpus is exercised, not just compiled.

2. **A single invalid field can silently disable a whole gate.** Stripe's API version is
   `2026-07-29.dahlia`. Emitted into `pyproject.toml` it is not valid PEP 440, so **ruff could not
   parse the config file and fell back to its defaults** — the 100-column limit the package declared
   was never applied. That presented as 667 line-length errors, of which the real count was
   twenty-three. A tool that cannot read its config usually does not fail; it proceeds with different
   settings. Worth remembering when a gate's output looks implausible.

3. **Every language has its own shadowing rules, and they are not guessable from another.** The
   TypeScript target reserves `Record` and `RequestOptions`. Python needs a *different* and larger
   set, split three ways: names that break at *class* scope (`object`, `str` — but not `id` or
   `type`, which are never emitted as annotations), names that break at *method* scope (`list`, whose
   fix is to qualify the annotation as `builtins.list` rather than rename the method, because
   `client.users.list()` is correct), and names the *framework* owns (`pydantic.Field`,
   `BaseModel.validate`). A generator cannot inherit this analysis between targets; each has to do it.

4. **Generated temporaries must be chosen against the spec's names, not hardcoded.** A generator that
   writes `query = {...}` into a method body has a latent bug the day an API has a parameter called
   `query` — and Stripe does. The spec picks the identifiers; the generator has to accommodate them.

**A core fix that came out of it.** Deeply nested schema paths repeat their own context: Twilio
produced a 105-character type name containing "IncomingPhoneNumberAssignedAddOn" twice, and Stripe one
with "Resource" three times. Synthesized name hints now drop tokens that repeat later in the hint,
keeping the last occurrence so the leaf token — the type's own name — survives. This improves both
targets, which is the argument for the fix living in the core rather than in one emitter.

**What stayed long, and deliberately.** Stripe declares a component named
`customer_balance_resource_cash_balance_transaction_resource_funded_transaction_resource_…` — 110
characters before any Python is written. No formatter can wrap an identifier, so `E501` is disabled in
generated packages rather than renaming an author's schema. The rule from §3.3.1 applies: do not
sanitize names you do not understand.

**One asymmetry to resolve.** The Python target validates responses at runtime, because pydantic makes
it free; the TypeScript target does not. §8 lists response validation as a Tier 1 gap, and having it
on exactly one target is an inconsistency in the product rather than a feature of one. Recorded in §9.

#### 3.3.5 What the third language proved

Go was chosen third precisely because it shares least with the first two: no exceptions, no optional
syntax, value semantics, and a formatter with no options. If the IR were secretly shaped by
scripting-language assumptions, this is where it would show.

**It did not.** The IR again needed no changes, and the protocol needed none either — the two
additions Python forced (`Handshake.gates`, `targets.<name>.command`) were exactly what Go needed too,
which is the first evidence that they were the right abstractions rather than Python-specific patches.
Names as token sequences earned their keep a second time and more sharply: Go wants `UserID` and
`HTTPSPort` where TypeScript wants `userId`. **This is the first target for which `pascal(tokens)` is
actively wrong**, so a core that pre-cased names could not have served it at all.

**Nine defects, and their distribution is the interesting part.** `go build` caught six of them
immediately, because Go's compiler enforces things the other two languages do not:

| Defect | Why only Go |
|---|---|
| **A struct containing itself by value** | `type A struct { Parent A }` is infinitely sized. TypeScript and Python reference objects, so a recursive type is free |
| **An enum constant redeclaring a struct** | Go has *one* package namespace for types, constants, and functions. GitHub declares both an `EventComment` struct and an `Event` enum with a `COMMENT` member |
| `time` used but not imported | Go rejects a missing import; the mapper knew it needed one but had no file to tell |
| `os` imported and not used | Go rejects an *unused* import too, which is stricter than anything else and correct to be |
| `*params.CreatorID` on a slice | Only pointers dereference, and a slice is already nilable so it is not pointer-wrapped |
| `&T{}` where `T` is an alias to `any` | A composite literal needs a composite type |
| **A nil slice marshalled as `null`** | Go's `encoding/json` emits `null` for a nil slice where every other language emits `[]` — so a run with no warnings produced a manifest the core rejected |
| Doc comments with a blank `//` between every line of a code example | Passing each line as a separate paragraph |
| `// ListMembers list members of an organization` | Not English; see below |

Four lessons worth keeping:

1. **The `cyclic` flag on a type is not enough; cycles are a property of *edges*.** The IR marks a type
   as participating in a cycle, which is what a breaking-change analysis needs. Go needs to know
   *which field closes* the cycle, because pointer-ising every field of a cyclic type would turn
   required scalars into pointers for no reason. So the target computes value-edge reachability
   itself. The IR is not wrong — this is genuinely target-specific knowledge about value semantics,
   and it belongs where value semantics live.

2. **A cross-language protocol has to be explicit about empty collections.** `[]` versus `null` is the
   kind of difference that is invisible until the language that disagrees shows up. Go was that
   language, on the very first CLI invocation.

3. **A generator cannot conjugate.** Go's convention is that a doc comment begins with the identifier
   it documents, and "ListMembers list members of an organization" is not a sentence. `Name: Summary`
   — the form Google's generated Go clients use — is both established and honest about being
   generated. Prose the author already wrote as a sentence is left alone.

4. **Strictness is a feature when you are generating.** Go rejects unused imports, unused variables,
   and unreachable code. Every one of those is an annoyance when writing code by hand and a *gift*
   when writing a generator, because it converts "emitted something slightly wrong" into a build
   failure. Six of the nine defects above were found by `go build` in the first thirty seconds.

**One thing Go cannot express, recorded honestly.** A union has no representation: Go has no sum type,
and the alternatives — an interface with unexported marker methods, or a struct with one field per
variant — are respectively unusable and unsound. So a union renders as `any` with the variants named
in the doc comment, which is what Stripe's Go SDK settled on for the same reason. It is the one place
where the Go output carries less type information than the TypeScript output, and no amount of IR
design fixes it.

**A note on where the target's own correctness comes from.** The Go target decodes the IR into typed
structs, which does *not* prevent the Python target's worst bug — JSON decoding leaves an unknown field
at its zero value, so reading `request` where the IR says `body` would be just as silent here. What
typing buys is that each field name appears exactly once, beside its `json` tag, instead of at every
call site. The remaining gap is closed by `sanity.go`, which compares the decoded structs against a
loose `map[string]any` decode of the same bytes and fails loudly when the IR describes forty-one
request bodies and the target decoded zero. That check exists because **no gate over generated output
can catch a target that read the wrong field** — the output is well-formed, it simply does nothing.

#### 3.3.7 PHP idiom decisions

**Built.** The fourth target, and the first chosen for breadth rather than to test the IR (§3.3.6). PHP 8.4
is the floor: 8.1 for enums and readonly, 8.2 for `readonly` classes and DNF types, 8.4 for property hooks. A
generator targeting PHP 7 would be generating for a version that reached end of life in 2022.

| IR concept | PHP rendering | Reasoning |
|---|---|---|
| read model | `final readonly class` with promoted constructor properties | Immutable by construction; a response is not something a caller should mutate |
| write model | named arguments on the method, not a builder | PHP has named arguments since 8.0, so `$client->widgets->create(name: 'x')` needs no builder object |
| optional field | `?T $x = null` | The language's own idiom; a sentinel class would be inventing a problem |
| enum | native `enum X: string` | Real since 8.1, and `tryFrom()` is exactly the open-enum behaviour §3.3.1 requires |
| open enum | `enum` plus a raw-string escape hatch | `tryFrom()` returns null on an unknown value rather than throwing, so a server adding a member is not a decode failure |
| scalar union | native union type `int\|string` | PHP expresses this *better* than Go, which must widen to `any` |
| typed collection | `array` plus `@return list<Widget>` | **The one real gap.** PHP has no generics, so the typechecker carries what the language cannot |
| error taxonomy | exception hierarchy, caught by type | The language's own mechanism, as `except` is Python's |
| paginated list | `IteratorAggregate` over items, `->pages()` for pages | `foreach ($client->widgets->list() as $w)` is what a PHP developer expects |
| naming | `PascalCase` classes, `camelCase` methods and properties | PSR-1 and PSR-12; property names follow the wire only when they must |
| namespace | `Acme\Sdk`, PSR-4 autoloaded from `src/` | Composer requires it, and it is how every PHP consumer resolves classes |

**Decision: the target is written in PHP.** Same argument as Python and Go (§3.3.2) — it needs the
language's own formatter, and `php -l` for a syntax check that does not depend on our own parser being
right. The protocol is JSON on stdin and stdout, so this costs nothing structurally.

**Decision: a structured code builder, not `nikic/php-parser`.** Third time reaching the same conclusion
(§3.3.4 states it as a rule): emit through the AST only when the AST library is designed for *synthesis*.
`php-parser` is an analysis library, its pretty-printer normalises formatting in ways that fight
`php-cs-fixer`, and comment attachment has the same fragility that disqualified `go/ast`. A builder plus
the canonical formatter is correct here.

**Gates: `php -l`, then `php-cs-fixer`, then PHPStan at level 9 (max).** `php -l` first because a syntax
error makes every later tool's output noise. PHPStan rather than Psalm on a coin-flip — both are
credible, PHPStan has the larger install base — and at level 9 because that is where it stops accepting
`mixed`, which is the level that actually holds generated code to the bar `AGENTS.md` sets. Neither is
bundled with PHP, so both are Composer dev-dependencies of the generated package and the gates are
declared `optional: false` for PHPStan, `optional: true` for the formatter (§3.5).

**Non-goal: PSR-18 / PSR-17 as the transport abstraction.** Tempting, because it is the ecosystem's
standard and would let a consumer swap in Guzzle. Rejected for the *default*: it would make Composer
dependencies mandatory for a hello-world SDK, and it pushes a discovery problem (`php-http/discovery`)
onto the user. The runtime uses cURL directly and accepts a PSR-18 client when one is supplied — the same
shape as `http_client` in Python and `HTTPClient` in Go, which exists so a caller can test their own code
without real network calls.

#### 3.3.8 What the fourth language proved

**The marginal-cost claim in §3.3.6 held.** The IR needed no changes and no version bump. Every semantic
decision was reusable as-is: names as token sequences, `role` on object types, the pagination taxonomy, the
error taxonomy, the descriptor format. The protocol needed nothing either. What PHP cost was a hand-written
runtime, a target, a conformance-shaped test suite, and gate wiring — exactly the list that section names,
and nothing beyond it.

**PSR-4 forces one class per file, which no previous target did.** Go groups freely within a package,
Python within a module, TypeScript within a file. PHP's autoloading standard makes the file name the class
name, so the runtime is 30 files rather than 6. Worth recording because it is not a style preference: a
grouped file simply does not autoload, and the first attempt failed at `class not found` rather than at
review.

**PHP expresses two things better than an existing target and one thing worse.** Better: native union types
mean `oneOf: [string, integer]` maps directly, where Go must widen to `any`; and named arguments mean a
write body needs no builder. Worse, and it is the only real gap: no generics, so a typed collection is
`array` to the engine and `list<Widget>` only in phpdoc. PHPStan at level 9 is what makes that phpdoc
load-bearing rather than a comment — which is why the level is not negotiable here in the way it might look.

**Level 9 caught two bugs that every other gate passed.** The first: `fromArray` passed
`$data['name'] ?? null` — a `mixed` — into a `string` parameter, which would have raised a `TypeError` from
inside a constructor with no field name in it. Generated decoders now narrow into locals first, so the
typechecker proves each argument and a required field of the wrong type fails with a message naming it. The
second: a paginated method declared `Paginator<Widget>` and constructed `Paginator<mixed>`, because no
decode closure was passed — a *behavioural* bug, not a typing one, since `foreach` handed the caller raw
arrays.

**The cross-language suite earned its keep twice, on things no gate could see.** PHP passed `php -l`,
php-cs-fixer, and PHPStan level 9; its own unit tests passed; and I had read the generated output. Then the
conformance drivers disagreed:

1. **A backed enum arrived on the wire as `"member"`, with literal quotes.** `Query::scalar` fell through to
   `json_encode` for objects, and a PHP enum instance is an object. Every other language sent `member`. No
   typechecker can see this — the value is a correctly-typed string, just the wrong one — and a unit test
   would only have caught it if someone had thought to write it.
2. **PHP validated the paginated *envelope* where the others validate *items*.** This spec declares
   `has_more` required on the envelope and the mock omits it, so PHP rejected a page the other three
   accepted. Both behaviours are defensible in isolation; only comparing them shows one is wrong. Items is
   the right contract: the caller receives items, and the envelope is transport detail.

That is the argument for §3.4.2 in one paragraph. Four gates and a careful read produced a target that was
*self-consistently* wrong, and the only thing that found it was another language doing the same thing
differently.

**And the paginated-validation bug reproduced for a fourth time.** A paginated method never touches
`requestJson`, so validation placed only there silently skips every list operation. This was found and
fixed in TypeScript and Go earlier, and written into this document — and it was still reproduced in PHP
before the note was applied. The lesson is not "remember this" but that the *shape* recurs: any
cross-cutting concern attached to the single-response path will miss the pagination path, because the two
call the transport differently in every language. A conformance scenario that paginates *and* returns a bad
shape is the only thing that catches it, and one now exists.

#### 3.3.9 Java idiom decisions

**Built.** The fifth target, and the hardest of the nine (§3.3.6). **Java 21 is the floor**, and the reason is
specific: records (16) and sealed interfaces (17) give Java a genuine sum type, but pattern matching in
`switch` — the thing that makes a sealed type *checked for exhaustiveness at compile time* — is a preview
feature in 17 and only final in 21. On 17 the validator's dispatch would have to be an `if`/`else
instanceof` chain, which discards the exact property the sealed interface was chosen for. 21 is the current
LTS, so the cost is small and the alternative is a design that argues for a benefit it does not get.

This is the `devbox` rule from §3.4 working as intended: the installed JDK was 17, the correct floor is 21,
and the answer was to install 21 rather than to weaken the design and call it a constraint.

| IR concept | Java rendering | Reasoning |
|---|---|---|
| read model | `record` with a compact canonical constructor | Immutable, value-equal, and `toString` is free. Exactly what a decoded response is |
| write body | **builder**, not named arguments | Java has neither keyword nor default arguments; a 20-optional-field record constructor is unusable |
| optional field | `@Nullable T`, `null` when absent | `Optional<T>` as a *field* is discouraged by its own designers — it is a return type |
| enum | native `enum` with a `wireValue` and `fromWire` | `fromWire` returns null for an unknown member, which is the open-enum rule (§3.3.1) |
| scalar union | `Object` today; sealed interface designed | See the note below — the design is real and unbuilt, and saying so is better than implying otherwise |
| error taxonomy | **unchecked** exceptions | See below — the most consequential decision here |
| paginated list | `Iterable<T>` plus `stream()` | `for (var w : client.widgets().list())` is what a Java developer expects |
| naming | `PascalCase` types, `camelCase` methods | Initialisms are *not* wholly capitalised: `getApiKey`, not `getAPIKey` — unlike Go |
| package | `com.acme.sdk`, Maven `pom.xml` | Maven because a library is consumed by both Maven and Gradle users; the reverse is not true |

**Decision: unchecked exceptions for the entire error taxonomy.** Checked exceptions would force every
caller of every method to `try`/`catch` or declare `throws`, which is how Java code acquires
`catch (Exception e) {}`. The ecosystem has settled this: Spring, the AWS SDK, Stripe, and the JDK's own
`java.net.http` all throw unchecked for remote failures. Checked exceptions model *recoverable, local*
conditions; a 500 from someone else's server is neither.

*Rejected alternative:* checked for `ApiError`, unchecked for the rest. It has a real argument — an HTTP
failure genuinely is expected — but it produces the worst of both: every signature carries `throws`, and
the one exception a caller most wants to ignore in a script is the one they cannot.

**Decision: builders for write models, and this is not a style preference.** Named arguments are what
made PHP and Python need no builder (§3.3.7). Java has neither them nor default parameter values, so the
alternatives are a telescoping constructor set — combinatorial and ambiguous once two optional fields
share a type — or a builder. Read models stay records: they are always fully populated, so a constructor
is honest there.

**Decision: no runtime dependencies. JSON is hand-written.** Made *after* installing Maven, because the
absence of a build tool was briefly about to decide this (§3.4), and the answer has to be arguable from
Java's own ecosystem instead:

- A generated SDK is a **library**, and a library that pins Jackson creates version skew with whatever the
  consuming application already has. This is among the most-reported problems in Java dependency
  management, and it is why Stripe's Java SDK shades its JSON library rather than depending on one.
- The JSON needed here is **narrow**: parse a response into a tree, serialise a request from a tree. No
  annotations, no reflection, no polymorphic binding — generated models carry explicit decoders exactly as
  the PHP target's `fromArray` does. That is a far smaller problem than general-purpose JSON binding, and
  it is hand-written runtime code, which is where this project puts quality.
- Zero dependencies also removes shading, relocation, and any `dependencyManagement` burden on consumers.

The risks this takes on are named rather than discovered: `\uXXXX` escapes including surrogate pairs,
numeric precision (a JSON integer that exceeds `long`), and stack depth on deeply nested input. Each has a
test.

*Rejected alternative:* Jackson. It is the ecosystem standard and would be the right call for an
*application*. For a library whose whole job is to be depended upon, the conflict it creates is the
consumer's cost and the SDK's fault.

**Unions map to `Object`, and the sealed-interface design is recorded rather than built.** Java *could*
express a union better than any other target: a sealed interface plus pattern matching gives a `switch` the
compiler checks for exhaustiveness, which is genuinely better than Go's `any` or TypeScript's structural union.
That property is why `Schema` in the runtime *is* a sealed interface — so the design is proven in hand-written
code. It is not yet what the emitter produces for a spec's unions, which today match Go's treatment. Stated
plainly because the alternative is a document that claims an advantage the output does not have.

**Gates: `javac -Xlint:all -Werror`, then `google-java-format --dry-run`.** `-Werror` because a warning in
generated code is a defect in the generator — a consumer cannot fix it by editing. google-java-format is
the closest thing Java has to `gofmt`: one canonical style, no configuration, which is exactly the property
that makes a formatter a gate rather than an argument.

#### 3.3.10 What the fifth language proved

**The IR held again, and needed no version bump.** Five languages now, and every semantic decision has been
reusable as-is. What Java cost was the same list §3.3.6 predicts: a hand-written runtime, a target written in
the language, a conformance driver, gate wiring.

**Java is the first target where the *compiler* found the bugs the other languages found at runtime — or not
at all.** Three examples, all from the same spec:

- **A field named `data` shadowing the decoder's parameter.** PHP hit this on the identical spec and *silently
  read from the wrong variable*, so `has_more` was always absent. Java refuses to compile it:
  "variable data is already defined". Same mistake, and the language decided whether it was a build failure or
  a data-corruption bug.
- **An enum decoded with the wrong method.** The emitter called `fromJson` on an enum, which has `fromWire`.
  In a dynamically typed target that is a runtime `AttributeError` on the first response containing that field.
- **A request body typed `Object` with `.toJson()` called on it.** Caught at the gate rather than in
  production.

**And one bug the compiler could not find, which reading did.** `Map.copyOf` rejects null *values*, and an
omitted optional query parameter is exactly a null — so every paginated call that left a parameter unset threw
`NullPointerException`. That is the common case, not an edge one. It compiled cleanly, passed every gate, and
was found by reading the generated `Widgets.java` and asking what happens when `offset` is null. Three
`copyOf` calls had the same defect. This is the discipline in `AGENTS.md` earning its place: a passing
typechecker proves output is well-formed, not that it works.

**`-Werror` is worth the friction it causes.** It rejected the runtime's own exception classes for holding
`Map` and `List` fields, because `Throwable` is `Serializable` and those interfaces are not. The resolution —
a narrowly scoped `@SuppressWarnings("serial")` with the reasoning attached, rather than `transient` fields
that would silently discard data — is the kind of decision a warning-tolerant build never forces anyone to
make.

**The toolchain lesson from §3.4 was tested immediately.** The installed JDK was 17; pattern matching in
`switch` is final only in 21; the sealed `Schema` type depends on it. The wrong move was available and
tempting — write an `if`/`else instanceof` chain and call 17 a constraint — and the right one was
`devbox add jdk@21`.

#### 3.3.11 C# / .NET idiom decisions

**Built.** The sixth target. **.NET 8** is the floor: it is the current LTS, and it is where `required` members, list
patterns, and `System.Text.Json`'s source generators are all available.

| IR concept | C# rendering | Reasoning |
|---|---|---|
| read model | `sealed record` with `required` init properties | Immutable and value-equal like Java's record, but `required` means the compiler enforces presence without a positional constructor |
| write body | object initialiser with `required` | **No builder.** `required` init properties give C# what Java lacks: compile-time enforcement of mandatory fields *and* named assignment |
| optional field | `T?` under `#nullable enable` | Nullable reference types are the analogue of `strict` — a nullability warning is an error here |
| enum | `enum` plus a `JsonConverter` | C# enums cannot carry string values, so the wire mapping lives in a converter |
| open enum | converter returns null on an unknown member | Same rule as everywhere (§3.3.1): a server adding a value must not crash a client |
| errors | exceptions | C# has no checked exceptions, so the Java debate does not arise |
| paginated list | `IAsyncEnumerable<T>` | `await foreach` is the language's own answer, and it is the only target where laziness and async compose natively |
| naming | `PascalCase` for members, `camelCase` for parameters | .NET's convention capitalises methods and properties, unlike every other target here |
| package | NuGet `.csproj` | |

**Decision: the whole surface is async.** `HttpClient` has no synchronous API worth using — `.Result` on a
`Task` deadlocks in several hosting models, which is one of the most-reported bugs in .NET history. So every
generated method returns `Task<T>` and pagination is `IAsyncEnumerable<T>`. This makes C# the second target
after TypeScript where async is the *only* shape, and unlike TypeScript it is a deliberate narrowing rather
than a language constraint: a synchronous overload is possible and is left out on purpose.

*Rejected alternative:* sync and async pairs, as the Python target emits. Python's `sync` client is genuinely
usable because `httpx` has a real synchronous transport; .NET's does not, and a `.Result` wrapper would ship a
deadlock with a friendly name on it.

**Decision: `System.Text.Json`, not a hand-written parser.** The opposite call to Java (§3.3.9), and the
difference is not taste — `System.Text.Json` ships *in the BCL*. There is no dependency to conflict with,
because it is part of the platform the consumer already has. The argument that made Jackson wrong for Java
(a library pinning a JSON version its consumer also depends on) simply does not apply.

**Decision: `required` init properties instead of builders.** This is the cleanest illustration of why each
target gets its own idiom decisions rather than a shared one. Java needs a builder because it has neither
named arguments nor a way to demand a field at compile time. PHP and Python need none because they have named
arguments. C# has *both* named assignment and compile-time enforcement:

```csharp
var widget = new WidgetCreate { Name = "Sprocket" };   // omitting Name is a compile error
```

So a builder here would be strictly worse than the language's own feature.

**Gates: `dotnet format --verify-no-changes`, then `dotnet build -warnaserror`.** Warnings as errors for the
same reason as Java: a warning in generated code is a defect a consumer cannot fix by editing. Nullable
reference types are enabled and their warnings are in scope, which is what makes `T?` load-bearing rather than
documentation.

#### 3.3.12 What the sixth language proved

**The IR still needed no changes, and this time that is not the interesting part.** Six languages, no version bump.
What .NET showed instead is that *idiom decisions genuinely do not transfer*, and the clearest illustration is
builders:

| | Named assignment | Compile-time "required" | Builders? |
|---|---|---|---|
| Python, PHP | yes | no | no — named arguments are enough |
| Java | no | no | **yes** — no other way to make 20 optional fields usable |
| C# | yes | **yes** (`required`) | no — the language does both |

Java's builders and C#'s object initialisers look like the same feature from a distance, and the reason they differ is
a property Java simply lacks. A shared "how do write models work" decision would have been wrong for at least one of
the three.

**Nullable reference types found what nothing else would have.** An array of unmodelled values was declared
`IReadOnlyList<object>` and produced `IReadOnlyList<object?>`, which nullable analysis rejects. The declaration was
wrong — a JSON array element can genuinely be null — and no other target's typechecker distinguishes those two types
at all. Six languages in, it is still finding new *classes* of imprecision rather than repeats.

**And `-warnaserror` caught an enum used as a value type.** The encoder emitted `if (Role is not null)` for a
required enum field, which is CS0037: a non-nullable value type cannot be compared to null. The emitter had a
hardcoded list of primitives and enums were not in it. The fix is not the list but the question — "is this a
non-nullable value type" is something the emitter can answer from the IR, and the hardcoded list was a guess at the
answer.

**The enum-wire-value bug recurred for the third time.** `kind=Member` reached the wire instead of `kind=member`,
because a **C# enum cannot implement an interface** — so the runtime's `IWireValued` check, which works in Go and
Java, can never match. TypeScript and Go got this right by construction; PHP and C# both got it wrong. The pattern
is now clear enough to state: *the languages where an enum is not simply a string are the ones where its wire value
will be wrong*, and only the cross-language suite catches it, because the value is a correctly-typed string in every
case — just the wrong one.

**Two C#-specific traps worth recording.** A ternary unifies its branches, so
`TryGetInt64(out var i) ? i : GetDouble()` types the whole expression as `double` — every integer boxed as a double,
which then silently broke the descriptor parser's required-field check. One type-inference rule, two failures, neither
where it looked. And a type whose name is also a namespace segment is unreferenceable from outside the package, which
a spec titled "Widget Co" packaged as `WidgetCo.Sdk` produces by default; the target now detects that and warns.

#### 3.3.6 Language roadmap

**Decision (2026-08-06): match the language set Fern generates, in-tree and blessed. PHP and Java
first.**

Full set, in intended order:

| # | Language | Status |
|---|---|---|
| 1 | TypeScript | Built (§3.3.1) |
| 2 | Python | Built (§3.3.2) |
| 3 | Go | Built (§3.3.4) |
| 4 | **PHP** | Built (§3.3.7) |
| 5 | **Java** | Built (§3.3.9) |
| 6 | **.NET / C#** | Built (§3.3.11) |
| 7 | **Ruby** | Next |
| 8 | Swift | Planned |
| 9 | Rust | Planned |

**This reverses "three was the point," and the reversal is honest rather than convenient.** The earlier
position — depth on three beats breadth on ten — was an argument about *where limited effort goes* and
about *proving the IR is language-neutral*. The second half is now done: three targets, one of which
(Go) forced a real casing decision (`UserID` versus `userId`) and a real structural one (options applied
after construction, §3.4.0.2). The IR needed no changes for either. That proof was the expensive part,
and it does not need repeating.

So the marginal cost of language *N* is now much lower than the cost of language 2 or 3 was. What
already exists and is not rebuilt per language: the semantic IR (stable at 1.5.0), the subprocess target
protocol, the read/write split, the pagination and error taxonomies, the validation descriptor format,
the diagnostic set, `check`, `diff`, `release`, and — most importantly — the conformance scenario suite
(§3.4.2), which is one set of scenarios and one mock server with a thin driver per language.

**What is actually per-language, and therefore the real cost:** a hand-written runtime, a target
program written *in* that language, a conformance driver, and gate wiring. Nine runtimes is nine things
to maintain, and pretending otherwise would be the mistake here. The runtime is where the quality lives
(`AGENTS.md`), so it is also the part that cannot be generated or shared.

**PHP and Java first, and each is interesting for a different reason.**

*PHP* is a better fit than its reputation suggests. PHP 8 has native union types (`int|string`), so the
scalar-coercion unions of §3.1.2 map directly — better than Go, which has to widen them to `any`. It has
named arguments since 8.0, so optional parameters need no builder. What it lacks is generics: a typed
collection is `array` plus a `@param list<Widget>` docblock, which means the *typechecker* rather than
the language carries the type. There is a pleasing loop closure here — the `phpEmptyMap` normalizer rule
(§3.1.2) exists because a PHP backend serialized an empty map as `[]`, and PHP will be the first target
whose own idioms explain that rule.

*Java* is the hardest of the nine and worth doing early for that reason. It has no structural typing and
no primitive union, so it constrains the IR harder than Go did — but sealed interfaces plus records
(Java 17+) give a genuine sum type, so discriminated unions (§3.1.7) should express *better* in Java than
in Go. Two decisions it forces that no existing target has: builders versus constructors for models with
many optional fields (Java has neither keyword nor default arguments), and checked versus unchecked
exceptions for the error taxonomy. Both are taste decisions the language will not make for us, so both
belong here before any code is written.

**Open question this creates: the strict-typechecker gate does not exist in every language.**
`AGENTS.md` calls it non-negotiable — `mypy --strict`, `tsc --noEmit`, `go vet` — and that premise holds
for PHP (PHPStan level 9 or Psalm at max, third-party but effectively standard), C#, Swift, and Rust. It
is weaker for Ruby, where Sorbet and RBS are real but far from universal, and a generated SDK that ships
`.rbs` signatures nobody consumes is a different kind of output than a `mypy --strict`-clean package. The
decision — whether Ruby's gate becomes "RuboCop plus a runtime conformance run" rather than a
typechecker, and whether that still counts as meeting the bar — is deferred to §9 rather than answered
by whoever happens to implement Ruby.

### 3.4 Post-processing and verification

**A missing local tool is not a design constraint.** `devbox` is available, so any formatter,
typechecker, or build tool a language needs can be installed and committed to `devbox.json`
(`AGENTS.md` has the commands). This is recorded as a decision rather than left as an obvious
convenience, because the failure mode is specific and expensive: the machine happens to have
`javac` but not Maven, so the *dependency* decision for the Java target starts drifting toward "no
dependencies, because we cannot resolve any" — which is a defensible conclusion reached for an
indefensible reason, and it becomes permanent the moment it is written down. Every target decision
must be arguable from the language's own ecosystem. If the argument is "the tool was not
installed", install the tool and make the argument again.

The corollary is that a gate is never quietly dropped for lack of a tool. It is either installed,
or its absence is declared (`optional: true`) and reported on every run (§3.5).

- Run the language's canonical formatter (ruff/black, prettier, gofmt) so output matches
  community style exactly.
- Run its typechecker and linter as a **correctness gate**: output that fails
  `mypy --strict` or `tsc` fails the build.
- **Generated documentation**: a README covering install, auth, pagination, errors, retries and
  timeouts; an `api.md` reference listing every resource and method; and an `examples/` directory.
  This is standard for the tools worth imitating — Stainless ships an `api.md` and examples,
  Speakeasy ships per-operation docs — and at 121 operations a reference is not optional: nobody
  discovers `client.workRequests.notifyWorkflowPhase` by reading 23 resource modules.

  **Examples are emitted inside the typecheck gate**, via a second `tsconfig.examples.json` that
  covers `examples/` alongside `src/`. This is the whole reason they are worth generating: a
  renamed method makes generation *fail* rather than shipping a snippet that lies. Unverified
  documentation is worse than none, because a plausible-but-wrong example teaches the wrong thing
  confidently — and the gate immediately earned its keep by catching a generator bug that passed
  the params object into a path parameter.

  Two supporting rules. **Never invent data that looks real:** values come from the spec's own
  `example:` fields where present, and are obviously placeholders (`'...'`) otherwise, because a
  fabricated-looking id in a sample gets copied into production. And **a handful of example
  *shapes*, not one per operation** — 121 files is noise; what a reader needs is one instance of
  each distinct pattern the API has.

- **Snapshot tests** over the generated **public API surface**, not every emitted byte. A
  2,700-line `models.ts` fixture is technically a snapshot but nobody reads it, and an unreviewed
  snapshot is worse than none: it turns "the output changed" into a rubber stamp. The surface —
  file list, client accessors, every resource method signature, exported type names — is what a
  consumer depends on, so a rename or dropped field shows up as one reviewable line. Two
  representative files are also snapshotted verbatim to catch formatting regressions the surface
  listing would miss, plus an assertion that generated code never contains `any`.
- **Conformance tests**: every generated SDK runs the same scenario suite against a mock
  server, proving all languages behave identically at the wire level while the code reads as
  native to each. See §3.4.2 — this is the test that can falsify the project's central claim.

### 3.4.1 Generation speed is a feature, and it is a property of how the AST is built

**Decision: a target builds each file's complete structure and creates it in one parse. Never hold
a source file and mutate it declaration by declaration.**

Emitting Stripe's SDK took **five and a half minutes**. A CPU profile of that run attributed 63% of
308 seconds to TypeScript's scanner and JSDoc parser, and a further 18% to the garbage collector
feeding them — 81% of the wall clock spent parsing text this process had itself just written.

The cause is that ts-morph reparses a source file after **every** structural mutation, to keep its
node wrappers valid. So the natural-looking shape

```ts
const iface = file.addInterface({ name });
for (const field of type.fields) iface.addProperty({ … });   // one reparse each
```

costs one parse per property, of a file that is growing as you go: quadratic in the size of the
file, with a large constant because every reparse re-reads the JSDoc prose too. Passing the whole
structure to `createSourceFile` parses once. The same Stripe run then took **2.3 seconds** — 136×,
with byte-identical output.

Three consequences worth stating, because they are not obvious from the outcome:

- **This is a rule for every target, not a TypeScript detail.** Any real AST library maintains
  invariants across mutations, and any generator that mutates per-declaration pays for them per
  declaration. A target's structure should be assembled as data and handed to the library once.
  Where a single raw insertion is genuinely unavoidable — the preservation region has to sit
  *inside* a class body, and a class structure takes members by kind rather than as free text — one
  mutation per file is linear and affordable. The loop is what costs.

- **Speed was a correctness gate before it was a feature.** At five minutes a run, the large specs
  get exercised once a session instead of on every change, which is exactly how the eleven defects
  in §7 survived as long as they did. Fast generation is what makes a big corpus usable as a test
  suite rather than an occasional audit.

- **It is guarded by a wall-clock test, deliberately.** `emit.perf.test.ts` emits 20 resources of
  30 types of 30 documented fields and asserts it finishes inside 15 seconds; it takes about one.
  A structural assertion ("the emitter never calls `addProperty`") would pin the current shape of
  the code rather than the property anyone cares about, and would pass while a different quadratic
  mutation crept in elsewhere. The size and the budget were chosen by **benchmarking both patterns
  at that exact scale** — mutation takes 56 seconds there. That step is the point: the first
  version of the test used a third of the scale and a 30-second budget, where the quadratic pattern
  takes 14 seconds and would have passed. **A guard test that has not been run against the bug it
  guards is decoration.**

A related fix from the same profile, on a much smaller scale: looking a type up with
`ir.types.find(…)` inside a loop over every resource's types is 1,440 × 76 comparisons on Stripe
for something a `Map` answers in constant time.

#### 3.1.5.1 Credentials from the environment

**Decision: every credential a spec declares falls back to an environment variable, named by the core
and read by each target. An explicit argument always wins; an empty value counts as absent.**

The names are built from the client name: `ACME_TOKEN`, `ACME_API_KEY`, `ACME_USERNAME`/`ACME_PASSWORD`,
`ACME_CLIENT_ID`/`ACME_CLIENT_SECRET`, `ACME_REFRESH_TOKEN`. `envPrefix` overrides the prefix, separately
from `name`, because an organisation's existing variables rarely match a class name and renaming the
class to match them is the wrong end of the problem.

**The names live in the IR, not in the targets.** This is the load-bearing part. Four targets had already
grown their own derivation — `screaming(service.name.tokens) + "_TOKEN"` in Python, an equivalent in Go,
another in Java, another in C# — and each read the environment for a *bearer token only*. So `new Acme()`
worked on a bearer API and silently produced an unauthenticated client on an API-key API, in five
languages, by five separate omissions of the same thing. Six independent derivations of one string is six
chances to disagree, and a client reading `ACME_TOKEN` in TypeScript and `ACMEPLATFORM_TOKEN` in Python is
a support ticket diagnosable from neither side. It belongs where every other cross-language decision
lives.

Empty counts as absent because `ACME_TOKEN=` is how a variable gets unset in a shell and in a `.env` file.
Treating it as a credential sends `Authorization: Bearer ` and produces a 401 whose cause is invisible from
both ends of the call.

**Credentials resolve into locals before the auth expression, in every target.** Not a style preference —
every target had written the environment read *inside* the auth conditional, so `resolved(builder.token,
"ACME_TOKEN")` appeared twice per credential, once in the condition and once in the value. Two expressions
for one credential, and only one of them ever stayed correct as the code changed. PHP had
`($token ?? getenv(X) ?: null) !== null` in the condition and `(string) ($token ?? getenv(X))` in the
value; C# had a pattern match and a separate call. Resolving first collapses each credential to one name
that every branch reads.

**A branch per scheme combination cannot be complete; a builder driven by the IR can.** The TypeScript
target hand-wrote branches for `apiKey` alone, `bearer` + `basic`, and `bearer` alone — and emitted
`{ type: 'none' }` for `basic` alone, which is exactly what Twilio's spec declares. The generated Twilio
SDK could not authenticate at all. It compiled, it read as correct, and no gate could see it because
"cannot authenticate" is not a type error. The branch cascade is now one builder that adds a rung per
declared scheme, so a combination nobody enumerated cannot fall through. Precedence: a fetched OAuth2
token, then bearer, then API key, then Basic.

#### 3.1.6 OAuth2

**Decision: implement the client-credentials flow, and the refresh half of authorization code.
Implement neither the authorization-code redirect nor implicit nor password.**

The scoping is the whole decision here, so the reasoning matters more than the code:

- **Client credentials** is machine-to-machine. The SDK holds an id and a secret, exchanges them for a
  token, and refreshes it. That is entirely an SDK's job and there is nothing an application can
  usefully do that the SDK cannot. This is what most API SDKs mean when they say they support OAuth2.
- **Refreshing a token** the caller already has is also pure HTTP, so the SDK does it. An application
  that completed an authorization-code flow in a browser has a refresh token and no good reason to
  hand-roll the refresh.
- **The authorization-code redirect is not an SDK's job.** It needs a browser, a redirect URI, a
  callback server, and a human. An SDK that pretends to own that flow either spawns a browser (wrong
  in a server process) or returns a URL and waits (which is the application's control flow, not the
  SDK's). The honest interface is: the application obtains a token however it must, and passes it in —
  which the existing bearer scheme already covers.
- **Implicit and password are deprecated** by OAuth 2.1 and should not be made easier to use.

So a spec declaring `authorizationCode` gets a bearer-token option and a `check` diagnostic explaining
that the redirect is the application's to perform. A spec declaring `clientCredentials` gets a client
that authenticates itself.

**The engineering that actually matters is not the token request.** It is three things around it:

1. **Single-flight refresh.** Ten concurrent calls on a cold client must produce *one* token request,
   not ten. Without this, the first thing a new SDK does under load is hammer the authorization server
   and possibly trip its rate limit — and the failure appears as unexplained 429s from a host the
   caller never configured.
2. **Proactive expiry.** Refreshing when a token has *already* expired means at least one request fails
   first. A token is refreshed slightly before `expires_in` elapses, so the failure never happens.
3. **A 401 must be retried exactly once, after a forced refresh.** Clocks disagree and servers revoke
   tokens early, so expiry arithmetic is necessary but not sufficient. Retrying more than once turns a
   genuinely-revoked credential into a loop.

**Token requests never go through the retry policy for API calls.** They are a different service with
different failure semantics, and a 400 from a token endpoint means the credentials are wrong — retrying
it is pointless and looks like a brute-force attempt.

**Refresh tokens are adopted when rotated.** A server that issues a new `refresh_token` invalidates the
old one, so caching the caller's original would fail on the *second* refresh — a bug that only appears
after a token lifetime has elapsed, which is the worst kind to find in production.

**Diagnostics rather than silent degradation.** A spec whose OAuth2 the SDK cannot own still generates
a working client, and says why: `A001` for a scheme with no usable flow (including `openIdConnect`,
whose discovery URL would make generation non-hermetic), `A002` for authorization code, `A003` for
implicit or password only. Each explains what the caller must do instead.

**One bug worth recording, because it was invisible.** The first version of the generated auth chain
checked only for a bearer token as its fallback. A spec declaring *both* OAuth2 and an API key — which
kitchen-sink now does — produced a client that silently ignored `apiKey`: it compiled, it read
correctly, and it could not authenticate that way at all. Every declared scheme now gets a rung in one
shared fallback chain rather than each branch reinventing the list.

**Status: all three targets.** Python needed *two* token sources rather than one,
because it has two clients: a `threading.Lock` for the sync path and an `asyncio.Lock` for the async
one. Merging them would mean the sync path driving an event loop, which breaks for a caller who already
has one running — and most callers do. The lock is created lazily in the async source, because
constructing an `asyncio.Lock` outside a running loop is deprecated and a client is often built before
the loop exists.

Both Python sources re-check the cache *inside* the lock. A caller that queued behind another thread's
refresh should use its result, not immediately fetch again — without the second check, single-flight
degrades to serialised-flight, which is quieter but no cheaper.

**Two bugs, both of the same shape, both found by generating and running rather than by reading.**

1. **The generated auth chain overwrote itself.** In both TypeScript and Python, the pre-existing
   bearer/basic/apiKey chain was a *separate* statement that ran after the OAuth2 block and reassigned
   `auth` unconditionally — making the OAuth2 branch dead code that compiled, linted, typechecked, and
   silently did nothing. The branches are now genuinely exclusive.
2. **`max_retries=-1` made the Python retry loop run zero times.** `-1` is a natural way to write "no
   retries" and both other runtimes accept it, but Python stored it raw, so `while attempt < -1` never
   entered and *every* request failed with "no recorded error". Negative counts are clamped now, at the
   client and per call.

**A third instance of duplicated lists drifting.** The Python target kept the runtime re-export names
in two places — the import statement and `__all__` — and adding `OAuth2Config` to only one produced an
unused import that failed the generated package's own lint. They are one tuple now. That is the third
time this exact class of bug has appeared here (pagination detection, resource grouping, and now this),
which is enough to state as a rule: **two lists of the same thing will drift; extract the list.**

**Go's single-flight is shaped differently, and had to be.** There is no promise for a second caller to
join, so waiters block on a channel that the one in-flight fetch closes. A `sync.Once` would be the
obvious reach and is wrong: a fetch can *fail*, and `Once` would cache the failure permanently. Holding
the mutex across the HTTP request would also work and is worse — a waiter could not abandon the wait
when its own context is cancelled. The channel is closed only *after* the result is published under the
lock, so a waking waiter cannot race the write. Verified under `go test -race`.

**A fourth bug of the same family, and this one was a cross-language divergence.** kitchen-sink declares
*two* OAuth2 schemes — client credentials and authorization code. Each target kept only one, and they
disagreed about which: Go took the last and generated only refresh support, while TypeScript and Python
took the first and generated only client credentials. The same spec produced SDKs with different
capabilities in different languages, and every gate passed. All three now emit an option per declared
flow, deduplicated by flow rather than by scheme.

That is the third distinct bug this iteration caused by *silently choosing one of several declared
things*: the auth fallback chain dropping `apiKey`, the OAuth2 branch being overwritten, and now this.
The pattern is worth naming: **when a spec declares several of something, handle all of them or
diagnose the omission — never quietly pick one.**

**One limitation, recorded rather than fixed.** The token URL comes from the spec, so a caller testing
against a sandbox authorization server cannot point at it. It is reachable today by injecting an
`http.Client` whose transport intercepts the host — which is how the Go test above works, and which is
only possible because the token source uses the *caller's* client rather than its own. A `tokenUrl`
override in `besdk.yaml` would be more direct and is not yet built.

#### 3.4.0.1 Retry safety and idempotency keys

**This began as a missing feature and turned out to be a bug.** §8 listed idempotency keys as "safe
replay of non-idempotent requests", which sounds like an enhancement. But besdk already retried, and the
retry policy never looked at the HTTP method — so a `POST /charges` that returned 503 was sent **three
times**, verified. Whether the server processed the first one is unknowable from the client, and the
plausible outcome is three charges.

**Decision: retry by method, and let an idempotency key unlock the rest.**

- **`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`** retry freely. They are idempotent by HTTP's definition,
  so a replay is safe whether or not the first attempt landed. `DELETE` is included deliberately: a
  second delete returning 404 is a *correct* outcome, not a failure.
- **`POST` and `PATCH`** are retried **only when an idempotency key is present.** With a key the server
  deduplicates, which is the only thing that actually makes a replay safe — a client cannot make it safe
  by itself.

**Not auto-generated, and that is the harder call.** Stripe's own SDKs mint a key for every request, and
it is tempting: it would restore retries for POST with no work from the caller. It is wrong here because
besdk generates for *arbitrary* APIs. Sending `Idempotency-Key` to a server that ignores it produces a
client that believes its retries are safe when they are not — which is worse than no retry, because the
belief is what makes someone stop thinking about it. A key is sent when the caller asks for one, and
`besdk.yaml` names the header because it is not standardised (`Idempotency-Key`, `X-Idempotency-Key`,
`Idempotency-Token` are all real).

**One key per logical request, not per attempt.** The whole point is that the server recognises the
replay, so the key is generated once by the caller or once per `request()` call — never inside the retry
loop, which would defeat it entirely.

**This is a behaviour change, and the right direction.** A `POST` that used to be retried now is not,
unless a key is supplied. Someone relying on that retry loses it — and what they were relying on was
unsafe.

**The safety rule is a conformance scenario, not a unit test.** `no_retry_without_idempotency_key`
asserts that a `POST` returning 503 is sent **exactly once** in all three languages, and
`retry_then_success` asserts that the same `POST` *with* a key is sent twice with a byte-identical
body. Both assertions are needed and they are the same test at heart: a runtime that never retried
would pass the first and fail the second, and one that retried blind would do the reverse. Putting
them in the cross-language suite is what makes "all three behave identically" mean something here —
this is exactly the kind of policy that drifts per language, because each runtime implements its own
retry loop.

The existing `retry_then_success` scenario originally sent a `POST` with no key and *expected* two
requests. It failed when the fix landed, which was correct: the suite was pinning the bug.

#### 3.4.0.2 Server variables

OpenAPI allows a templated server URL:

```yaml
servers:
  - url: https://{region}.api.example.com/{version}
    variables:
      region: { default: us-east-1, enum: [us-east-1, eu-west-1] }
      version: { default: v2 }
```

besdk modelled none of it, so the base URL kept its braces and every request went to a host that does not
resolve. **Decision: substitute defaults at generation time, and expose each variable as a client
option.** The default is baked in so the common case needs no configuration, and a variable with an
`enum` becomes a union type rather than a string — the spec listed the valid values, and discarding them
would leave a caller to guess at a region name.

**`Server.url` is always resolved, and `urlTemplate` is kept beside it.** Two fields rather than one,
because they answer different questions: a target that knows nothing about variables reads `url` and
produces a working SDK, and a target that exposes them needs the shape to re-substitute into — which
cannot be recovered once the defaults are in. Substituting into the template rather than assembling from
parts also means a URL where a variable appears twice, or inside a path segment, comes out right with no
special cases.

**Only variables the URL references are modelled.** A declared variable the URL never uses is dead
weight, and emitting a client option for it would invite a caller to set something with no effect. The
reverse — a `{placeholder}` with no declaration — has no default, so nothing can be substituted; that
warns (`S003`) and the placeholder is **left in place**. Stripping it would produce
`https://.api.example.com`, which looks plausible and fails at DNS with nothing to point at, where
`https://{tenant}.api.example.com` is obviously wrong to whoever reads it. Where OpenAPI requires
`default` and a spec omits it, the first `enum` member is used, for the same reason.

**An explicit base URL always wins.** That is what makes the option usable for a proxy, a private
deployment, or a test server, and a template quietly overriding it would defeat the purpose.

**Go resolves the template in the runtime; TypeScript and Python resolve it in the constructor.** Not an
inconsistency to tidy up — a genuine language difference. Go's functional options run *after* the options
struct is built, so by the time `WithRegion` executes, a constructor that substituted inline would already
have assembled the URL. So `core.ClientOptions` carries `BaseURLTemplate` and `ServerVariables`, and
`NewClient` resolves them; the other two never set those fields. This is the third time Go's option
pattern has forced a structural difference rather than a cosmetic one (§3.3.4).

Each language expresses the enum the way it actually expresses a closed set: TypeScript a union
(`region?: "us-east-1" | "eu-west-1"`), Python a `Literal`, Go a named string type with exported
constants (`RegionEuWest1`). Go's is not a weaker version of the other two — a named type is how Go makes
a value non-substitutable, and the constants are what an editor can complete.

#### 3.4.1.1 Runtime response validation

**The problem.** A generated type is a *claim* about what the server sends. Without checking it, the
claim is unverified: `widget.name.trim()` on a response where the server omitted `name` fails with
`Cannot read properties of undefined`, three frames inside the caller's code, with nothing pointing at
the API that broke its contract. Python got validation for free from pydantic; TypeScript and Go had
none, so the same spec produced SDKs with materially different failure behaviour (§8 item 7).

**Decision: generate schema descriptors as *data*, and hand-write the validator in the runtime.**

Rejected alternatives, and why:

- **Zod** (what Speakeasy uses). It works, and it is a runtime dependency in a package whose stated
  selling point is having almost none. A generated SDK currently depends on nothing at all in
  TypeScript; adding a validator library spends that, and spends it on every consumer.
- **Generated validator *code*** — a `validateWidget()` function per type. Straightforward, and it
  makes output size scale with the number of types: Stripe has 1,440. Descriptors are data and
  compress to a fraction of the equivalent code, and AGENTS.md is explicit that hand-written runtime
  beats generated machinery.
- **Validating with the typechecker only** — the status quo. It is what makes the claim a lie.

So: the target emits a compact descriptor table, and one reviewed validator walks it. Descriptor keys
are single characters (`{ k: 'o', f: … }`) because this table is emitted once per type and Stripe's is
large; the readability that matters is the validator's, and that is hand-written.

**What is checked, and what deliberately is not.**

| Checked | Not checked | Why |
|---|---|---|
| A required field is present | — | This is the claim that actually lies, and the one whose violation crashes user code later |
| A declared field has the declared type | — | Same |
| `null` where the schema is not nullable | — | The presence/nullability distinction (§3.1) is worthless if it is not enforced somewhere |
| — | **Unknown fields** | A server adding a field must never break a client. Extra keys are always ignored |
| — | **Enum membership** | The open-enum rule (§3.3.1) exists because servers add values without warning. Checking membership would reintroduce exactly the decode failure that rule prevents — so an enum is validated as its *base type* only |

**Decision: `strict` by default.** The alternative is defensible and I think it is wrong. A missing
required field crashes the caller either way; the only question is *where they find out*. At the SDK
boundary they get `orgs.listMembers: response.data[0].email is required but was absent`, naming the
API's own violation. Three frames later they get a property access on `undefined` and start debugging
their own code. `validation: warn` and `validation: off` exist for a sloppy server, and `besdk check`
already tells an author their spec is under-specified — this is the runtime consequence of that same
under-specification, which is a coherent story rather than two unrelated features.

**Errors are their own type.** A validation failure is not an `APIError`: the request *succeeded* and
the contract was violated. That is a different problem for the caller, usually a different problem for
the API owner, and it must not be swallowed by a `catch (APIError)` that meant "handle a 4xx". Python
already distinguishes these, and the shape now matches.

**Only response-reachable types get a descriptor.** A descriptor is useful only for a type that can
arrive in a response, and a spec's type graph is much larger than its response graph — on Stripe,
2,841 descriptors from 5,409 declared types. Reachability is computed outward from response types.

**The cost, measured, and how a user declines it.** Stripe's descriptor table is 624 KB inside a
4.2 MB SDK. That is not free, and a bundler cannot tree-shake it: the table is one object literal, so
importing a single resource still pays for all of it. Splitting it per resource would duplicate every
shared type, which is worse. So `validation: off` omits the table *and* the call sites entirely rather
than emitting them unused — 4.2 MB becomes 3.5 MB. The config key therefore buys bundle size and not
only behaviour, which is what makes it an honest option rather than a token one.

**All three targets validate, and the conformance suite proves they agree.** Two scenarios assert it:
a response missing a required field must be rejected by every language *with the same path*, and an
additive field must be accepted by every language. All three report `[0].name`, which is what makes the
guarantee identical rather than merely present in three places.

**Go needed it most, not least.** `encoding/json` **silently ignores a field whose type does not
match**: a server sending `"slug": 123` for a `string` leaves the field empty, and the caller cannot
distinguish that from a legitimate empty string. Nothing fails and the wrong value propagates. So the
ordering is not an implementation detail — validation must run against a *generic* decode, before the
bytes reach the typed struct, because afterwards the mismatch has already been discarded. It costs a
second `json.Unmarshal` of one buffer, paid only when validation is on.

**Go embeds the table as JSON, not as Go literals.** The one place the three implementations
legitimately differ. `Schema{K: SchemaObject, F: []SchemaField{{Name: …}}}` is several times the bytes
of `{"k":"obj","f":[{"n":…}]}`, and a large Go literal is markedly slower to compile. The blob is
parsed once at package initialisation.

**Response descriptors are looked up, never parsed per call.** The first version emitted
`core.MustParseSchema("{…}")` inline in each method, which would have decoded JSON on *every request*
for data that never changes. Operation descriptors go in their own embedded table and the generated
method does a map lookup.

#### 3.4.1.2 Date coercion

**Decision: `format: date-time` becomes the language's native instant type in every target. `format:
date` stays a string in TypeScript, and that difference is deliberate.**

The TypeScript target used to return `string` for a timestamp, with this reasoning recorded in
`types.ts`: *"Claiming `Date` would be a lie unless the runtime revived it, and silently reviving
changes what round-trips."* That was **correct when it was written** — there was no runtime pass over
responses, so a `Date` in the type and a string at runtime would have been a straightforward lie.

The premise changed when response validation landed (§3.4.1.1). The runtime now walks every response
against a descriptor tree, so reviving a timestamp costs one branch inside a walk that already happens.
The old decision is reversed on that basis, not on taste.

**Why `date` is different, and staying a string is the *more* correct answer.** JavaScript has no
date-only type. `new Date('2026-08-06')` parses as midnight UTC, so a caller in UTC-5 asking for
`.getDate()` gets `5`. That is a notorious class of bug, and handing someone a `Date` for a calendar date
is how they walk into it. Python has `datetime.date` and Go has nothing but `time.Time`, so those targets
use what they have — and this is the one place the three legitimately differ. Recorded rather than
papered over.

**Coercion is paid for only when a spec has dates.** The walk returns the original object by reference
unless something actually needed converting, so a spec with no `date-time` field carries no copying cost.
That matters because the walk runs on every response.

**Round-tripping still works.** A `Date` passed back into a request body serialises through
`JSON.stringify` as RFC 3339, which is what the server declared — so reading a model and sending it back
is unchanged. This was the second half of the original objection, and it turns out not to bite.

**A related gap this makes visible but does not fix.** `format: int64` is emitted as `number` in
TypeScript, which silently loses precision above 2^53. Reviving it as `BigInt` would fix the precision
and break `JSON.stringify`, which refuses to serialise one. That trade needs its own decision and is not
made here.

**The gap this actually found, which was much worse.** Wiring coercion revealed that
**paginated responses were never validated either** — in TypeScript *or* Go. A paginated method calls
the transport directly to read its envelope, so it never reached `requestValidated`, and every item in
every list response went unchecked from the moment validation shipped two iterations earlier. A list
method is the most common thing in an SDK, so that was most of the surface.

Three things about how it stayed hidden are worth keeping:

1. **The conformance suite had a scenario for pagination and a scenario for validation, and neither
   crossed.** `paginate_members` sent conforming data, so validation passed vacuously;
   `validation_catches_a_broken_contract` used a non-paginated method. Two passing tests, one uncovered
   intersection. The suite now has a scenario that is specifically the *product* of the two.
2. **Python was unaffected**, because pydantic validates wherever a model is constructed rather than at
   one chokepoint. So the cross-language comparison found it the moment a scenario existed: TypeScript
   and Go said "no error", Python said "validation". The comparison is what turned a silent hole into a
   failing test.
3. **The fix confirms the composition rule twice over.** `validationMode` had to become public for the
   same reason `requestValidated` did: a generated resource class *holds* a client rather than extending
   one, so anything generated code needs is reachable only through the instance. That is the second time
   `protected` was the wrong choice for the same reason, which makes it a property of the generated
   surface rather than an oversight.

Go validates items *before* unmarshalling them into the typed slice, for the same reason a single
response is checked that way: `encoding/json` discards a mismatch silently, so checking afterwards could
never see it.

#### 3.4.1.2 Streaming, and what a caller can reach

**Decision: a streaming method yields decoded payloads. Event metadata is reachable through a sibling
method, and `Last-Event-ID` is a request option. besdk does not reconnect.**

Three sub-decisions, and the third is the one that scopes the feature.

**The default yields payloads, not frames.** `for await (const event of client.events.stream())` gives the
decoded event, so `event.type` works. Yielding `{ data, id, event, retry }` from the default would make the
common case read `event.data.type` in order to serve the rare one — the same trade the pagination iterator
already refuses by yielding items rather than pages.

*Rejected alternative:* attaching metadata to the payload object non-enumerably. It would keep both call
sites clean and it is invisible in a debugger, absent from `JSON.stringify`, and unknown to structural
typing. A field a reader cannot see is worse than a field they have to ask for.

**Metadata comes from a sibling method,** `streamEvents()`, yielding `{ data, id, event, retry }` with
`data` typed exactly as `stream()` yields it. Two methods rather than an option, because the *return type*
differs — an option that changes what a generator yields cannot be typed in any of the six languages
without a union the caller has to narrow.

**`retry` is parsed and surfaced, having been discarded.** The frame parser read `event`, `data`, and `id`
and dropped `retry` with a comment saying so. It is the server telling the client how long to wait before
reconnecting, which is meaningless to a client that never reconnects — and exactly the thing a caller
writing their own reconnect loop needs.

**besdk does not reconnect, and that is the scoping decision.** Automatic resumption sounds like the
natural completion of this feature and is not:

- **Nothing in OpenAPI says whether an endpoint supports resumption.** A spec declares
  `text/event-stream`; it does not declare that replaying from an id yields the missed events rather than
  starting over. Reconnecting on that assumption silently duplicates or drops events.
- **It changes the iterator's contract.** A loop over a reconnecting stream never ends on a dropped
  connection, so the caller loses the ability to *notice* one — and the failure mode is a process that
  looks healthy while receiving nothing.
- **The backoff policy is the caller's.** `retry` is a hint, and whether to honour it, cap it, or give up
  after N attempts depends on what the consumer is doing with the events.

So besdk supplies everything resumption needs — the id on each event, and `RequestOptions.lastEventId` to
send `Last-Event-ID` on the next call — and leaves the loop to the caller. That is the same line drawn for
the OAuth2 authorization-code flow (§3.1.6): implement the part that is purely mechanical, decline the part
that requires knowledge the spec does not carry, and say which is which.

*Rejected alternative:* reconnecting behind an opt-in flag. It would still be besdk asserting that
resumption works for an endpoint nobody has told it about, and an opt-in that is wrong when enabled is not
safer than an absent feature — it is the same false confidence as an unconfigured webhook verifier.

**A target must satisfy the strictest configuration a consumer might have, not the one it ships.** The
metadata sibling first imported `StreamEvent` as a value. The generated package's own `tsc` gate passed —
its tsconfig does not set `verbatimModuleSyntax` — and the *conformance* build, which does, rejected it.
Worth recording because the reflex is to conclude the stricter config is wrong: it is not. A consumer's
tsconfig is theirs, and generated code that only compiles under the settings besdk happens to emit is
generated code that breaks on contact with a real project.

**All six targets decode SSE, or emit nothing.** A method handing back raw lines or a byte reader is not a
streaming method; it is the transport with a docstring. Python's `Iterator[str]` and Go's `io.ReadCloser`
were the honest thing to ship before the framing logic existed in those runtimes, and they are not the
honest thing to keep once it does — a caller writing `line.startswith("data: ")` is reimplementing the part
this project exists to have written once. Where a target cannot yet decode, it skips the operation with a
warning, which is what the three that skip streaming already do.

#### 3.4.1.3 Webhooks

**Status: built in TypeScript.** Landed as one piece, which the first attempt did not: config schema, IR
(`webhooks` on the root, added in 1.8.0), hand-written runtime verifier with 20 tests, target emit, a
corpus spec that declares two webhooks, the `W001` diagnostic, and docs. The earlier attempt landed the
config key and the diagnostic before anything read them and the docs drift guard correctly rejected it — a
`besdk.yaml` key a user can set and besdk ignores is worse than an absent feature.

The remaining five targets need the event union and a thin call into a per-language verifier. The
descriptor is in the IR for all of them, so what is missing is rendering plus one hand-written verifier
each — and the verifier is the part that must not be shared by generating it (see below).

An SDK for an API that sends webhooks has two jobs, and they are different in kind. One is ordinary
generation; the other is security-critical hand-written runtime code.

**Typed events come from the spec.** OpenAPI 3.1 declares them in a top-level `webhooks:` map, 3.0 has
`callbacks` on an operation, and Fern, Speakeasy, and Redocly all read `x-webhooks`. besdk reads all
four, for the reason in §3.1.5: they state the API owner's intent, which does not stop being true for
having been written for another tool. Each entry names an event and carries a request body schema, which
is exactly a named type plus a key — so this reuses the discriminated-union machinery from §3.1.7 rather
than adding any.

**Verification is hand-written and lives in the runtime.** A generated HMAC comparison is the last thing
anyone should want: it is short, it is security-critical, and it has three ways to be subtly wrong.

1. **The HMAC must be computed over the raw request bytes.** Verifying a re-serialized body is the
   classic failure — it passes in testing and breaks the moment the sender's key order, whitespace, or
   unicode escaping differs from the receiver's serializer. So the entry point takes bytes, never a
   parsed object, and parsing happens *after* verification succeeds.
2. **The comparison must be constant-time.** A byte-by-byte early return leaks the expected signature
   to an attacker who can time responses.
3. **A timestamp must be checked against a tolerance.** Without it a captured request stays valid
   forever, which makes the signature a bearer token rather than a proof of freshness.

**Decision: the signature scheme is a descriptor in config, not generated code.** Same argument as
response validation (§3.4.1.1) — the varying part is data, and one hand-written interpreter of that data
is more trustworthy than N generated verifiers. The variation across real providers is entirely in five
fields:

| Provider | Header | Value shape | Signed template | Encoding |
|---|---|---|---|---|
| Stripe | `Stripe-Signature` | `t=…,v1=…` | `{timestamp}.{body}` | hex |
| GitHub | `X-Hub-Signature-256` | `sha256=…` | `{body}` | hex |
| Slack | `X-Slack-Signature` + separate timestamp header | `v0=…` | `v0:{timestamp}:{body}` | hex |
| Shopify | `X-Shopify-Hmac-Sha256` | bare | `{body}` | base64 |

So `webhooks.signature` in `besdk.yaml` names the algorithm, the header, how to get the signature out of
the header value (`bare`, `prefixed`, or `structured`), the encoding, the signed template, and the
tolerance. Four providers, one interpreter, no generated crypto.

**Decision: with no configured scheme, no verifier is emitted at all.** This is the same call as
idempotency keys (§3.4.0.1) and it is the one that matters most here. OpenAPI has no field describing a
signature scheme, so besdk cannot infer one. A `verify()` that returns `true` because it checked
something meaningless is strictly worse than its absence: the false confidence is precisely what stops
someone from thinking about the problem, and the failure is silent and total. Typed events are still
emitted — those come from the spec and are useful alone — and `check` reports the gap with the config
fragment that closes it (`W001`).

*Rejected alternative:* a built-in table of provider presets (`signature: stripe`). Tempting, and it is
what a hosted product would do. Rejected because a preset that drifts from a provider's actual scheme
fails in the direction of accepting forged requests, and besdk has no way to notice. The descriptor is
barely longer than the preset name and says what it does.

**What building it added to the design.** Four things the design did not anticipate, all found by writing
it:

- **A request from the *future* must be refused too.** The tolerance check reads as "reject anything
  older than N seconds", and implemented that way it accepts a request timestamped a year ahead — which
  lets a captured request be replayed at any later time by a sender whose clock is wrong or claims to be.
  The comparison is on the absolute difference.
- **The tolerance is checked *before* the HMAC.** A stale request is refused whatever it is signed with,
  so doing the cheap check first avoids computing a digest for something already rejected. It also means
  a caller cannot use the endpoint as a timing oracle for the HMAC by sending stale requests.
- **A signed-timestamp scheme with no timestamp present is refused,** not treated as "no timestamp to
  check". Accepting it silently converts the signature into a bearer token — the exact property the
  tolerance exists to prevent — and it is the one degradation an attacker can trigger at will, by
  omitting a header.
- **The verification error must not name the expected signature.** An error that helpfully reports what
  the signature *should* have been is an oracle. Asserted by a test, because it is the kind of thing a
  later "improve the error message" change would reintroduce.

**Verification throws; it does not return a boolean.** A handler that forgets to check a returned `false`
is silently accepting forged requests, and that is a plausible mistake in a five-line Express handler. The
one thing worse than no verification is verification whose failure is ignorable.

**`error.reason` distinguishes the failures,** because the operational response differs: a bad signature
means someone sent you something, while a stale timestamp usually means your own queue is backed up.
Conflating them sends people to the wrong dashboard.

**`crypto.subtle`, not Node's `crypto`.** Same reason the transport uses `fetch`: the runtime stays
dependency-free and works in a worker, an edge function, and Node alike. Verified against RFC 4231 test
case 2, so the test suite cannot agree with a broken primitive.

**A webhook payload is frequently a schema the API also returns**, so the generated module imports its
types from the *owning resource module* rather than from `shared.ts`. Assuming `shared.ts` produced an SDK
that did not compile, caught by the typecheck gate on the first run — and worth recording because the
ownership map already existed and the webhook emitter simply did not consult it.

**Non-goal: framework adapters.** Verification takes raw bytes and headers and returns a parsed event, so
it composes with Express, FastAPI, `net/http`, or a Lambda handler without besdk knowing about any of
them. Shipping an adapter per framework per language is a combinatorial surface that ages badly, and the
three-line integration it saves is the part a user should be able to read.

#### 3.4.1.4 Every corpus spec, every target

**Decision: `generate:all` generates every corpus spec in every target, and `pnpm verify` runs it.**

The alternative was what existed: the kitchen-sink fixture in all six languages and Twilio in TypeScript
alone. That asymmetry hid four build-breaking bugs — a required `unknown` field that did not compile in
.NET, and three decode-narrowing bugs in PHP (an optional map, an optional list of enums, an optional list
of scalars). Each surfaced the *first time* Twilio was generated in that language. No gate could have found
them earlier, because no gate ever ran on that pairing.

The general form is worth stating plainly, because it is not obvious and it recurred four times before
being acted on: **a gate is a property of a (spec, target) pair, not of a target.** Six targets each with a
passing gate suite tells you nothing about the fifth spec none of them has seen. Coverage is the product,
not either factor.

*Rejected alternative:* running the extra pairings in CI only. Two minutes is small enough that the local
loop can carry it, and a gate that fires after a push is a gate that costs a round trip to learn from.
Revisit if the corpus grows: the cost is linear in specs × targets, and PHPStan at level 9 over ~900 files
is already 44 seconds of the 120.

*Rejected alternative:* a third, smaller corpus spec exercising the same constructs faster. It would need
to be *known* to cover what Twilio covers, and the four bugs above were found precisely because Twilio is
real and irregular in ways nobody would think to write down.

**A note on how the gap was measured, which is a lesson about verification rather than about besdk.** The
first measurement loop reported all five pairings passing. It counted lines beginning `✗` and found none —
but a run that dies during the handshake prints no `✗` at all, so a target invoked with a broken command
scored the same as one that passed every gate. Two of the five had not run. The CLI's own exit code was
correct throughout (2, in both cases); the harness simply did not consult it. **A success signal that a
non-event also produces is not a success signal**, and the corrected loop asserts on `Wrote N files` — the
one line only a real run emits.

#### 3.4.2 Cross-language conformance

The central claim is that one spec produces SDKs that *behave identically* while *looking native*.
The IR, the target protocol, and the read/write split all exist to make that true. This is the test
that can falsify it.

**Shape.** One real HTTP server, one shared scenario file, and a driver per language that calls its
own generated SDK idiomatically — `client.orgs.listMembers('o1', { limit: 2 })`,
`client.orgs.list_members("o1", limit=2)`, `client.Orgs.ListMembers(ctx, "o1", params, nil)`. Each
driver reports what it observed as JSON. Then **two** assertions per scenario:

1. Each driver matched the scenario's expected wire trace and values.
2. **Every driver agreed with every other driver.**

Neither subsumes the other, and that is the point. A mistake in the *expectations* passes (1) for all
three languages and fails (2). A bug present in all three *implementations* — say, boolean query
encoding — passes (2) and fails (1). Both checks are needed.

**A real server, not a mocked transport.** A stubbed `fetch` proves the TypeScript SDK calls `fetch`
the way the test expects, which is close to tautological, and it cannot be shared with Python or Go
at all. A socket is the only thing three languages can be compared on.

**What it found immediately.** Three genuine defects, none of which any single-language gate could
see:

| Defect | How the comparison exposed it |
|---|---|
| **Go sent a pointer address as a query value** — `?kind=0x1400018c550` | TypeScript and Python sent `kind=member`. The runtime's type switch cannot enumerate types the *caller* declares, and an optional enum is a `*QueryKind`, so `%v` printed the address. The general case has to be reflective |
| **`error.message` meant different things per language** | TypeScript prefixed the status (`404 Organisation not found`); Python and Go kept the server's words and added the status when *rendering*. Three SDKs from one spec must agree on what a field means; the server's message is the honest answer, since `.status` already carries the code |
| **A generated example that could not compile** | The TypeScript target hardcoded `{ token: … }` regardless of the spec's auth. For an apiKey-only spec no `token` option exists — a snippet in the client's own doc comment that would fail to build. It lived in a comment, where the typecheck gate cannot reach |

The `{ token: … }` bug is worth dwelling on. §3.4 already argues that examples belong *inside* the
typecheck gate because unverified documentation is worse than none. That argument was right and the
implementation had a hole: a doc comment is not compiled. Writing a driver in each language forced
someone to actually construct each client, which is what surfaced it.

**A divergence that is real and remains.** Python validates responses with pydantic; TypeScript and Go
do not. The suite made this concrete rather than theoretical: an early fixture used `"id": "m1"` for a
field the spec declares as `format: uuid`, and **only Python rejected it**. The fixtures now send data
the contract permits, because a conformance suite should exercise valid traffic — but the asymmetry
itself stays in §9 as an open question, not quietly enjoyed.

**Skips are loud.** A driver whose toolchain is absent is reported by name with the reason. A
contributor working on the TypeScript target should not need Go and Python installed; CI has all
three. What is never allowed is a silent skip that reads as a pass.

**One harness lesson.** The first version deadlocked: the mock server runs in the test process, and
spawning a driver with `execFileSync` blocks the event loop the server needs to answer. The drivers
finish in under two seconds each; the harness was the slow part. Spawning is asynchronous now.

### 3.5 The target protocol — how "any language" works

**Decision: a target is a subprocess that reads IR JSON on stdin and writes a file manifest on
stdout.**

```
besdk-target-<lang> --sdk-target-protocol
  → { name, irVersions: ["1.x"], capabilities: [...] }          # handshake

besdk-target-<lang>
  stdin  ← { irVersion, ir, options, runtimeVersion }
  stdout → { files: [{ path, contents }], warnings: [...] }
```

`irVersion` is negotiated at handshake; a mismatch is a hard error, never a warning. Blessed
targets ship in-tree. Third-party targets resolve as `besdk-target-*` on `PATH` or via
`besdk.yaml`.

Why a subprocess boundary rather than an in-process plugin API:

- **Targets get written in their own target language.** A Go target written in Go, by Go
  people, using `go/ast` and `gofmt`. This is not incidental — the canonical AST and printer
  for a language lives in that language's own ecosystem, and §3.3 forbids string templates. A
  single-host-language plugin API would force every target to hand-roll a printer for a
  language its author may not primarily write.
- **Idiomaticity requires native expertise**, and expertise follows language communities.

**Two ways this principle was quietly broken, both found by running the commands rather than reading
them.**

**`besdk targets` and `besdk generate` resolved targets differently.** `generate` honoured
`targets.<name>.command`, then an installed package, then `PATH`; `targets` read only the config *keys*
and went straight to `PATH`. So the command whose entire job is reporting which targets are usable
reported the configured Python and Go targets as "not installed" — wrong about two thirds of the project,
in the first thing anyone evaluating besdk would run. One resolver now, in
`packages/cli/src/target-resolution.ts`, and this is the fifth instance of the rule already recorded
here: two implementations of one decision will disagree, and the one nobody exercises is the wrong one.

**The TypeScript target declared no gates, and the core covered for it.** Go declared gofmt, build, and
vet; Python declared ruff and mypy; TypeScript declared none, and `generate` fell through to a hardcoded
prettier-and-tsc branch. That branch is exactly the language-specific table §3.7 exists to prevent, and
keeping it meant the blessed reference target was the only one not exercising the protocol it ships —
this very principle, inverted. It also meant a third-party target declaring no gates silently got none.
The target now declares its own gates with absolute paths resolved from its own dependencies, which is
what the protocol always asked for, and a target with no gates gets a warning saying its output is
unverified rather than a hidden fallback.

The same pass found the TypeScript target **under-declaring its capabilities** — `pagination` and
`read-write-split` only, while emitting SSE streaming, binary responses, and multipart bodies, all
tested. `besdk targets` prints that list, so an author reading the reference target to learn what is
expected of theirs was told less than the truth.

**Capabilities are still only reported, never enforced.** §3.5 says the core uses them "to fail early
rather than emitting an SDK that silently drops a feature," and it does not: nothing checks an IR
containing streaming operations against a target that does not declare `streaming`. Left open
deliberately rather than half-built — see §9.

**Decision: blessed targets get no in-process privileges.** `target-typescript` runs as a
subprocess exactly like a third-party target, even though the core is also TypeScript.

*Rejected alternative:* run the first target in-process for iteration speed and extract it
later. Rejected because a plugin API that nothing external exercises rots — the first
consumer's special-case access is how protocol boundaries silently become fiction. The cost is
a little developer convenience; the benefit is a protocol that is honest from the first commit.

#### 3.1.3 Naming

Names are the most visible signal of whether output looks hand-written, and three rules do most
of the work.

**Compound splitting.** Specs name resources `assettypes` and `workrequests` — no case boundary,
so tokenization alone yields `Assettypes`, which reads as machine output. Splitting requires a
vocabulary; there is no way to infer the boundary otherwise. besdk ships a curated word list and
`naming.words` in `besdk.yaml` extends it.

Deliberately conservative, because **a wrong split is worse than no split** — it produces a
confidently misspelled public identifier. Guards: tokens under 6 characters are left alone (so
`ass`, the subtitle format, survives); a token already in the vocabulary is never split (so
`translations` stays whole); every segment must be ≥3 characters and known; fewest segments wins.
A leading capital is *not* a word boundary — `Assettypes` must split exactly as `assettypes`
does, which an earlier version got wrong by guarding on "all lowercase".

**Synthesized names escalate, they do not concatenate.** Joining the whole JSON path produces
`NotificationEventWorkRequestMaterialsItemChangeRequestsItemRepliesItem` — unique and unusable.
Humans name a type after what it *is* and add parent context only to disambiguate, so besdk tries
the last token, then the last two, and takes the first unclaimed candidate. This cut the longest
generated name from 60 characters to 26.

Two refinements this needed:

- **Array elements singularize** rather than gaining an `Item` suffix: the items of a `replies`
  array are each a `Reply`, not a `RepliesItem`.
- **Generic leaf tokens require a qualifier.** `Links`, `Meta`, `Value`, `Data` say nothing as
  exported type names, and whichever schema was traversed first would claim the bare name —
  making output order-dependent. These start escalation at two tokens: `PreviewLinks`, never
  `Links`.

**A name is stored as the tokens that produced it.** Targets render `name.tokens`, so writing the
short id while storing the full path as `tokens` leaves the long name in the output and the
escalation invisible. The two must agree.

**Qualifiers are singular; the final token keeps its number.** `PermissionSources`, not
`PermissionsSources` — English uses the singular attributively ("permission sources"). The last
token is the type's own name and keeps whatever number it had.

**Singularization needs the vocabulary, not cleverer regexes.** English gives no way to tell
`studios` (plural of `studio`) from `status` (singular) by shape, and every regex-only attempt
produced a visible wart:

| Rule that seemed right | What it broke |
|---|---|
| `(ch\|sh\|x\|z\|s)es$` → strip `es` | `phases` → `phas`, `houses` → `hous` |
| `os$` means already-singular | protected `studios`, giving `Studios` as a single-item type |
| strip a bare `s` | `aliases` → `aliase` |

The working design is three layers: a set of mass nouns and invariant plurals (`graphics`,
`news`, `series` — `graphics` names a thing, so `GraphicComment` is wrong); a vocabulary lookup,
which settles `studios`/`status` definitively; then conservative regexes for everything else.
`naming.words` extends the vocabulary, so a user can fix a domain word without patching besdk.

**Synthesized names never shadow a JS/DOM global.** A model called `Error` or `Response` shadows
the built-in for any importing module and fails confusingly. Applies only to names besdk chooses
— a component the spec itself names `Event` keeps it.

#### 3.1.4 Where generated types live

**Types are colocated with the resource that owns them.** A type reachable from exactly one
resource is declared in that resource's module; anything reachable from several, or from none,
goes to `shared.ts`. This is reachability, not a heuristic, so the placement is stable.

Reasoning: types are erased, so there is no bundle-size argument in either direction — this is
purely about navigability, and one 2,736-line `models.ts` is not navigable. Colocation is also
what the SDKs worth imitating do. On the first corpus entry it puts 168 types beside their
resources and leaves 72 shared, dropping the largest file from 2,736 to 753 lines.

Two consequences worth stating:

- The barrel must `export *` from each resource module, not name its class. Naming only the class
  made every colocated type unreachable from the package entry point.
- Cross-module type cycles are fine. `import type` is erased, so two resources whose types refer
  to each other produce no runtime cycle — which is what makes colocation safe at all.

An unexpected benefit: with `StudiosResponse` renamed to `Studio`, the `Studios` resource class no
longer collides with a model, so the `Resource` disambiguation suffix disappeared on its own.

#### 3.1.5 Vendor extensions

**Decision: besdk defines `x-besdk-*`, and also reads other generators' extensions.**

Extensions exist because a spec cannot say "group these under `users`", "this paginates by
cursor", or "the server assigns this field". Every serious generator invented them for exactly
that reason. So does besdk.

**Reading a competitor's extension is deliberate, not incidental.** `x-fern-sdk-method-name: list`
is the API owner stating unambiguously that they want this method called `list`. That intent does
not stop being true because it was written for a different tool. Ignoring it would make besdk
produce *worse* names than the spec already asks for, and would force anyone migrating to
re-annotate a spec that is already annotated.

**Extensions and config serve different owners**, which is why both exist:

- Own the spec? Annotating it is natural, and the intent travels with the API to every generator.
- Generating from someone else's spec? You cannot edit it, so config is the only option.

Precedence, therefore:

| Tier | Source | Rationale |
|---|---|---|
| 1 | `besdk.yaml` | the consumer's explicit override, closest to whoever runs besdk |
| 2 | `x-besdk-*` | the spec owner's explicit intent *for besdk* |
| 3 | other vendors' `x-*` | the spec owner's intent for *some* generator — still intent |
| 4 | inference | besdk guessing |

Supported `x-besdk-*`: `group` and `method` on an operation (dotted group nests), `ignore` on an
operation/schema/property, `pagination` on an operation, `name` on a schema, and
**`server-owned` on a property**. That last one is the most valuable thing an extension can
express: it is precisely what besdk cannot infer, the API owner knows it for certain, and living
next to the field means it cannot drift out of sync with a rename the way a config list does.

Read from other vendors: `x-fern-sdk-group-name`, `x-fern-sdk-method-name`, `x-speakeasy-group`,
`x-speakeasy-name-override`, plus `x-fern-ignore`, `x-speakeasy-ignore`, and `x-internal` — the
last being a broad convention rather than any one generator's, so honoring it is what the author
expects.

**An extension besdk half-understands is worse than one it ignores**, because the user assumes it
was applied. Only unambiguous keys are acted on. Complex nested ones whose semantics differ
between vendors — `x-fern-pagination`, `x-speakeasy-pagination` — are **reported as unhandled**
with the config setting that does work, rather than guessed at. Unrecognized `x-*` keys are listed
too, since a typo in `x-besdk-server-owned` would otherwise be indistinguishable from silence.

`besdk check` reports which tier supplied each name, so a surprising method name can be traced to
its source.

#### 3.1.6 `besdk.yaml` conventions

Three decisions about the overlay format, all following from "it must stay hand-editable and
reviewable in a PR":

- **Unknown keys are an error, never ignored.** A typo'd key that silently does nothing is
  worse than a failed run, because the user believes they fixed something and moves on. Every
  config object is closed; only per-target option blocks are open, since the core must not know
  individual targets' settings (§3.7).
- **Shorthand where it reads better.** `{ error: string, code: integer? }` rather than a nested
  schema object; `header:X-Content-Range` rather than `{ kind: header, name: … }`. These appear
  inline constantly and the nested forms are materially noisier.
- **`besdk init` writes inferred values explicitly**, each tagged with the diagnostic code that
  produced it, and marks with `REVIEW` the judgments only the API owner can make. A config
  that omitted everything besdk could guess would leave those guesses invisible and
  un-overridable — the overlay would be magic, which is the opposite of the point.

`besdk init` refuses to overwrite an existing `besdk.yaml` without `--force`: the file
accumulates hand-made judgments about the API and is the most expensive artifact in the repo.

### 3.5.1 `besdk release` — versions, changelogs, and publishing

**Decision: besdk computes the version and the changelog; CI does the publishing.**

That split is the whole design, and both halves are deliberate.

**What besdk owns, because only it can.** The next version is a *diff* question, and `besdk diff` already
answers it: `impliedBump` maps breaking changes to major, additive to minor, and everything else to
patch, using the direction-sensitive classification from §3.8 that knows a required-ness flip breaks
read and write models in opposite directions. Nothing else in a pipeline has that information. The same
diff produces the changelog, so the entry describes what actually changed rather than what a commit
message claimed.

**What besdk does not own, and must not.** It never runs `npm publish`, `twine upload`, or `git push
--tags`. A tool that publishes is a tool that needs registry credentials, and a tool that needs
credentials is one nobody runs locally to see what it would do. Publishing is also inherently
environment-specific — a private registry, an internal proxy, a monorepo release train. So `release`
writes the version and the changelog, and emits a workflow that does the rest where the secrets already
live.

**The SDK's version is not the API's version.** Stripe's API version is `2026-07-29.dahlia`; its SDK
version is semver. Conflating them is why the Python target once emitted a `pyproject.toml` that `ruff`
could not parse (§3.3.3). So the SDK version is tracked separately, in `.besdk/<spec>.sdk-version`
alongside the IR baseline, and committed. One version per spec across every target: three languages
releasing from one contract at three different numbers is a support burden with no upside.

**Go has no version field, and that is not a gap in besdk.** A Go module's version *is* its git tag, so
`release` emits the tag to create rather than editing a file. Two consequences that are easy to miss and
that make the difference between real support and a checkbox:

- A major version at or above 2 must appear **in the module path** — `github.com/acme/acme-go/v2`. So a
  major bump rewrites `go.mod` and every internal import, or consumers cannot `go get` it at all.
- A module in a subdirectory is tagged `sdks/go/v1.2.3`, not `v1.2.3`.

**First release is `0.1.0`, not `1.0.0`.** A generator declaring someone's API stable on their behalf is
overstepping; `0.x` says "this is generated and not yet promised", which is true. Reaching `1.0.0` is an
explicit act, which is what `--version` is for.

**Two bugs worth recording, both from the release computation itself.**

1. **A first release reported the *bumped* version.** With no recorded version, `planRelease` applied
   the diff's bump on top of `0.1.0` and returned `0.2.0` — claiming a release that never happened.
   There is no published SDK for a change to be additive *to*: the diff is against the IR baseline,
   which tracks the *spec*, not against anything a consumer has installed. A first release is the
   initial version whatever the diff says.

2. **The explanation contradicted the number.** Below 1.0.0 a breaking change is classified `major` but
   moves the *minor*, and the description was keyed on the classification alone — so `0.3.0 → 0.4.0`
   was labelled "1 breaking change" and left a reader thinking the classifier was broken. The
   description now depends on the current major as well as the bump.

Both are the same shape: a value computed correctly and *described* wrongly. Neither would fail a
typechecker, and the second would not fail a test that only asserted the version number.

**The brand guard earned its keep.** Six hardcoded occurrences of the project name reached string
literals in the emitted workflow and the changelog header before the test in
`packages/protocol/src/branding.test.ts` failed the build. The name is a working title (§1.2), and
every one of those would have baked it into a user's repository.

### 3.6 `besdk check` — surfacing under-specification

A first-class command, not a lint afterthought. It follows directly from "enrichment, not just
translation" (§1): on an under-specified spec, a silent generator emits something that
compiles and is useless, so the tool's job includes *telling the user what the spec fails to
say*. Every diagnostic carries a copy-pasteable `besdk.yaml` fix.

```
example.yaml → 121 operations, 23 resources

  ⚠ 20 schemas serve as both request and response
      AssetsResponse: list item, get response, create body, update body
      → models.AssetsResponse.split: { read: Asset, create: AssetCreate }
  ⚠ 186 error responses declare no schema
      → errors.default: { error: string }
  ⚠ 22/22 fields on AssetsResponse are optional
      → users will null-check every field; promote with models.AssetsResponse.required
  ℹ 14 oneOf branches are PHP empty-map artifacts → collapsing to map<string,T>
  ℹ Accept header on 121/121 operations → hoisting to runtime defaults
```

`--strict` exits non-zero on any ⚠ so CI can gate. This command is also how the project earns
the trust it is premised on: it makes the generator's judgment calls auditable instead of
magic.

**Decision: `check` builds the IR and reports its diagnostics too, and loads config while doing it.**
It reported only the analyzer's findings, which left five codes reachable *only* by running
`generate` — a colliding `operationId` (`M004`), a conflicting `discriminator` (`T005`), an OAuth2
scheme with no usable flow (`A002`), a server URL that cannot be resolved (`S003`), and a tolerated
spec violation (`S001`). A command whose entire purpose is surfacing what a spec fails to say cannot
hide half of it, and "run `generate` to see the rest of the warnings" is not a defensible answer for
the command meant to be the differentiator.

Config is loaded for the same reason the diagnostics are merged: a finding the user has already
answered in `besdk.yaml` is noise, and a `check` that keeps naming a fixed problem stops being read.
Running without `--config` against a spec with no config beside it still shows the raw picture.

**And loading it was not enough — `--strict` could never pass.** Walking the documented flow on a fresh
spec: `besdk init` writes `models.Widget.split`, `models.Widget.required`, and `pagination.default`, then
`check --strict` reports all three of the warnings init had just resolved and exits non-zero. The one job
`--strict` exists for — gating CI — was impossible on any spec that needed configuring at all, which is
every real spec.

**Decision: a diagnostic declares the config paths that answer it, in `resolvedBy`.** `check` drops any
diagnostic whose paths are all present. Declared *by the diagnostic that raises it*, deliberately: a
table mapping codes to config keys elsewhere is the same knowledge written twice, and this document
already records four instances of two such lists drifting.

Two details that are not obvious:

- **Every path must be present, not any.** One `M001` diagnostic covers all conflated schemas, so
  configuring one of five would otherwise silence a warning still true of four.
- **An empty value does not count.** `required: []` says nothing was promoted, so the diagnostic that
  asked for it still applies. Same for `pagination.default: {}`.

A diagnostic declaring no `resolvedBy` is never suppressed, so silence is opt-in per diagnostic rather
than a blanket behaviour an unrelated config key could trigger.

*Rejected alternative:* moving those five checks into the analyzer so `check` could stay
config-and-IR-free. They are conclusions the IR build *reaches* — you cannot know two `operationId`s
collided until you have tried to name both methods — so re-deriving them in the analyzer would mean
two implementations of the same judgment, which will disagree. The cost is that `check` now does the
IR build's work, which on Stripe is real but not close to the cost of being wrong.

This surfaced a latent import cycle: `CommandContext` lived in `check.ts`, so every other command
imported from `check` to name its own arguments, and the moment `check` needed something back from
`ir.ts` the boundary check failed. A type shared by every command belongs to none of them; it lives in
`commands/context.ts` now.

### 3.7 Package boundaries

```
packages/protocol/            IR + manifest schemas. The public contract. Depends on nothing.
packages/core/                load → resolve → normalize → overlay → ir
packages/cli/                 besdk binary; commands, reporters, exit codes
packages/target-typescript/   Node program; IR JSON → manifest, via ts-morph
packages/runtime-typescript/  HAND-WRITTEN. transport, retries, auth, pagination, errors
```

`core/` must never import a target; `target-typescript/` must never import `core/`. Enforced
in CI by a dependency check — this boundary *is* the architecture, and it erodes silently
otherwise.

Two further rules the check enforces, each added after it caught a real defect:

- **No import cycles.** A package barrel (`index.ts`) must stay a pure re-export, and modules
  inside a package import each other directly. Re-exporting a module that imports the barrel
  forms a cycle; this happened immediately with `index → init → index`.
- **No unresolvable imports.** An import that fails to resolve stays a bare specifier, matches
  no path pattern, and therefore satisfies every rule above — which makes the boundary rules
  unsound rather than merely incomplete. Unresolvable imports are errors in their own right.

A corollary worth stating because it is easy to get wrong: workspace `main` fields point into
`dist/`, so a cross-package import resolves to `packages/<name>/dist/index.js`. Excluding
`dist/` from the dependency graph silently drops the exact nodes the boundary rules match on,
and every rule passes vacuously. Entry points are restricted to `src/` on the command line
instead. **Verify that a boundary check fails on a deliberate violation before trusting it.**

The pipeline runs as named stages — `load → resolve → normalize → overlay → ir → emit →
materialize → verify` — and `--emit-stage=<name>` dumps any stage. This is both the debugging
affordance and what keeps the protocol contract inspectable rather than notional.

### 3.8 `besdk diff` — breaking-change detection

**Decision: diff the IR, not the emitted code.** This settles the §9 question of how to keep
regeneration from silently breaking downstream users.

Diffing generated text cannot answer it: reformatting registers as a change, a renamed method
looks like one removal plus one addition, and the whole analysis would have to be rewritten per
target — in the core, which §3.7 forbids from knowing any language. A change is breaking because
of what it does to the *contract*, and the IR **is** the contract, so one diff covers every target.

`generate` **bootstraps** an IR baseline when none exists; `diff` compares the current IR against
it and classifies each change as `breaking`, `additive`, or `patch`, reporting the implied semver
bump. `--strict` exits non-zero so CI can gate; `--accept` updates the baseline.

**The baseline is written only when absent, never on every run.** Writing it unconditionally
destroys the comparison point: the normal workflow is generate-then-diff, so an unconditional
write made `diff` report "no contract changes" every time and the gate could never fire. Updating
the baseline must be a deliberate act.

**The service name is part of the contract.** It becomes the exported client class name, so
renaming it breaks every `import { … }` in every consumer. Omitting that check let a client rename
pass `diff --strict` while the repository's own conformance tests stopped compiling.

**The classification is direction-sensitive, and the direction is easy to invert:**

| Change | Read model | Write model |
|---|---|---|
| required → optional | **breaking** — code that assumed presence must handle absence | additive |
| optional → required | additive — the value is now guaranteed | **breaking** — callers must supply it |
| field added (required) | additive — nothing a caller writes changes | **breaking** |

A `shared` model flows both ways, so either flip breaks one side. This is why `role` exists on
object types in the IR: without it, a required-ness change cannot be classified at all.

Two things that are breaking but not compile errors, so they need flagging explicitly: gaining or
losing pagination (the return type changes from a promise to an iterator), and a changed default
server (every existing client silently calls a different host).

**Baselines are per-spec.** A single shared path meant generating a second spec overwrote the
first one's baseline, and the next `diff` compared one API against a completely different one —
258 spurious changes. The path is derived from the spec path and committed to the repo.

**Config values are validated against the schema, not just the config grammar.** `serverOwned:
[createdAt]` on a schema whose field is `created` parses fine and does nothing — leaving a
server-owned field in the write model, which is the exact bug the split exists to prevent. Every
field name in `required`, `serverOwned`, and `exclude` that matches nothing is reported. This is
the "unknown keys are an error" principle (§3.1.6) extended from keys to values.

---

## 4. Where the difficulty actually is

Recorded explicitly so it isn't underestimated: the pipeline above is the *easy* part and is
roughly what everyone converges on. What separates good from mediocre is

- the hundreds of small judgment calls per language ("should union variants be tagged classes
  or a discriminated literal type?"), and
- the endless grind of never breaking on anyone's weird spec.

Design implication: the idiom mappings must be *readable and reviewable as a unit*, because
they encode taste and will be argued over. Don't scatter them through the generator.

---

## 5. Build order

1. The IR.
2. One language, end to end.
3. **A corpus of ~20 nasty public specs as the test suite, from day one.** IR design mistakes
   only reveal themselves under ugly input, so the corpus cannot be deferred until after the
   IR is "done."

---

## 6. Settled decisions

Recorded here because they were open questions and future agents should not relitigate them.

- **First target language: TypeScript.** Largest SDK audience, and `ts-morph` is the
  best-in-class structured code builder — so §3.3's "ASTs, never templates" rule is cheapest
  to honor here. It is the strongest first proof of the quality bar.
  *Rejected for first position:* Python (hardest idiom decisions — `NotGiven` sentinels,
  sync/async duality, Pydantic v2 — valuable as a stress test but slower to a polished
  result); Go (best at proving the IR is genuinely language-neutral, but the most verbose
  output to get right).
- **Core implementation language: TypeScript.** See §2.1 for reasoning and switch condition.
- **Config overlay format: YAML** (`besdk.yaml`). Matches the input format, so users edit one
  syntax; comments are essential since the file records judgment calls; and `besdk init`
  writes inferred values *explicitly* so nothing about the output is magic.
- **License: Apache-2.0.** Permissive plus an explicit patent grant. The patent grant is the
  part that makes companies comfortable depending on a generator for their public SDKs, which
  is the entire adoption thesis in §1. MIT is simpler but offers no patent protection.

## 7. Corpus

Snapshot coverage requires real specs, and §5 makes the corpus a day-one artifact rather than
a later addition. Specs are vendored and pinned so diffs are attributable to generator changes
alone.

**`corpus/pixwel` — Pixwel Platform, OpenAPI 3.1.0.** 8,878 lines, 62 paths, 121 operations.
The first entry and current design forcing-function. What makes it valuable:

All figures below are measured by `besdk check`, not estimated by hand.

| Property | Value | Exercises |
|---|---|---|
| Operations / resource groups | 121 / 23 | — |
| Named component schemas | 27, for 121 operations | every request and response body is a `$ref`; see note below |
| Anonymous inline schemas | 4 | `nameSynthesis` — barely exercised by this spec |
| Schemas used in both request and response position | 19 | `readWriteSplit` (§3.1.1) |
| Named schemas with no `required` fields | 21 of 27; worst is `WorkrequestsResponse` at 42/42 optional | `requirednessReport`; optional-vs-nullable |
| Error responses with no schema | 182 of 186 | error taxonomy cannot come from the spec |
| Declared response headers | 0 (total-count cited in prose only) | `paginationInference` |
| Collections with paging params but no declared pagination | 19 | `paginationInference` |
| Paging params on non-collections | 14 | pagination must require response corroboration |
| Empty-map-as-`[]` unions | 11 | `phpEmptyMap` |
| Scalar-only unions | 19 | `scalarUnion` |
| Content declared with no schema | 23 | `emptySchema` |
| Repeated inline schema shapes | 1 shape across 4 sites | `structuralDedupe` |
| Constant header params | `Accept` on 121/121 operations | `constHeaderHoist` |
| `x-fern-sdk-*` coverage | 121/121 | native `x-fern-*` overlay reading |
| Auth | HTTP Bearer **or** HTTP Basic | multi-scheme auth in the runtime |

**Where the deep nesting actually is.** All 82 typed response bodies and all 43 typed request
bodies are `$ref`s to named components — there are no inline *bodies* at all. The ~10-level
nesting is *inside* those components (`NotificationsResponse.properties.event.properties.
workRequest.…`), as anonymous nested property schemas. So this spec stresses nested-property
naming, not body naming. An earlier draft of this section claimed "most bodies are inline";
that was wrong, and it mattered — it would have aimed `nameSynthesis` at the wrong problem.

**Pagination requires corroboration.** This spec applies one shared parameter block to every
GET, so 33 operations accept `limit`/`offset` while only 19 return a collection. The other 14
are actions (`reindex`, `analyze`, `syncclerk`, `automateJob`). Paging parameters alone are
therefore *not* evidence of pagination; the success response must independently look like a
collection. Without that rule the generator emits an iterator for `assets.reindex()`.

### What the first real third-party spec found

`corpus/twilio` — 197 operations, 75 resources, vendored specifically because nobody designed it for
besdk. Every one of these was a real defect, and none was reachable from the specs already in the
corpus:

| Defect | Cause |
|---|---|
| **Pagination undetected on all 75 resources** | Twilio spells the parameters `PageSize`, `Page`, `PageToken`; matching was case-sensitive. 61 operations were silently unpaginated |
| Duplicate method implementations | `hasPathParam` was end-anchored, and Twilio's paths end in `.json` — so `/Accounts/{Sid}.json` read as a collection, making `FetchAccount` collide with `ListAccount` |
| Duplicate identifiers | Twilio's inequality filters `StartTime<` and `StartTime>` both reduced to `startTime` |
| A pagination config the runtime's own types reject | Twilio offers *both* page-number and cursor paging; the scheme carried `pageParam` on a cursor style |
| Error classes named but never defined | Twilio declares a 408; the taxonomy named `Status408Error` and nothing generated it |
| ~40 numerically-suffixed type names | Inline request bodies were named from the method alone, so every `UpdateRequest` in the API collided |

Fixes, in order: parameter matching is case- and separator-insensitive; instance paths are detected
by a parameter in the *final segment*; comparison operators become words (`startTimeBefore`);
pagination schemes only carry the parameters their own style uses; targets generate an error class
for any declared status the runtime does not provide; and synthesized names are scoped by resource.

The lesson generalizes: **each of these was invisible until a spec written by someone else went
through the pipeline.** Two corpus entries designed with knowledge of the implementation found none
of them.

### What Stripe, GitHub, and Box found

Three more third-party specs, fetched on demand (§7). Scale: Stripe 589 operations / 1,440 schemas,
GitHub 1,220 operations, Box 296. Every item below was a real defect that the earlier corpus could
not reach:

| Defect | Cause |
|---|---|
| **Stripe generated one resource with 589 methods** | It declares no tags and every path begins `/v1/`, so the path fallback grouped everything under `v1` |
| `check` said 1 resource, `generate` said 76 | Two implementations of the same grouping decision, drifting after only one was fixed |
| Required parameter after an optional one | An optional body followed by a required `params` — legal in the IR, illegal in TypeScript |
| Every `deepObject` query parameter failed to compile | Stripe's range filters (`created[gte]=…`) are objects; the query type accepted only scalars |
| A generated type named `RequestOptions` | It shadowed the runtime import in the same module |
| **A generated type named `Record`** | Every emitted `Record<string, T>` then failed with "Type 'Record' is not generic" |
| **Two GitHub descriptions contain a comment-close sequence** | It terminated the JSDoc and injected a syntax error; generation aborted with a ts-morph error pointing at the property, not the prose |
| `init` wrote a config `besdk` itself rejected | GitHub's error body has an `array` field, and the config shorthand accepts only scalars |
| Box: nullable headers, arrays of objects in the query | Runtime types were too narrow |

Three of these generalize into rules now encoded:

1. **Names the language or the runtime occupies must be reserved.** `Event` merely shadows a global
   and a spec may legitimately want it (§1.2). `Record` and `RequestOptions` *break compilation*, so
   a spec-declared name is renamed — `RecordModel`, which reads as deliberate where `Record2` reads
   as the generator giving up. Reserved in the **target**, since which names are taken is a property
   of TypeScript and of this runtime, not of the IR.

2. **Query serialization is inherently dynamic, so it is typed `unknown` internally.** TypeScript
   gives an `interface` no implicit index signature, so a generated `interface Created { gte?: number }`
   can never satisfy `Record<string, QueryValue>` however correct it is. Callers stay fully typed by
   the generated `*Params` interfaces; the runtime validates every value.

3. **One decision, one implementation.** The `check`/`generate` disagreement is the second instance
   of duplicated logic drifting — pagination detection was the first. Both are now single functions.

Note what the corpus still does *not* exercise: OAuth flows, external `$ref`s across files
(DigitalOcean's spec is split this way and besdk resolves only same-document pointers), and
link-style pagination where the next page is a URL rather than a cursor — Twilio's `next_page_uri`
and GitHub's `Link` header both work that way.

**The corpus is split three ways, by who owns the spec.**

| Directory | Committed? | Purpose |
|---|---|---|
| `corpus/kitchen-sink/` | yes | ours, hand-authored, covers every construct |
| `corpus/twilio/` | yes | a real third-party spec, vendored under MIT and pinned to a commit |
| `corpus/vendor/` | **no** | large specs (Stripe, GitHub, Box) fetched by `pnpm corpus:fetch` |
| `corpus/private/` | **no** | the developer's own specs, run by `pnpm corpus:private` |

The private tier is not a convenience. **A spec licensed `UNLICENSED` cannot be redistributed**, so
the API description a maintainer most wants to develop against is often the one that must never be
committed. Keeping it out of the repository is a licensing requirement, and `pnpm verify` must pass
in a checkout that has none of it — otherwise the project is untestable by anyone but its author.

Private IR baselines are gitignored too (`.besdk/corpus-private-*`), even though `.besdk/` is
otherwise committed: a baseline contains every schema and method name in the spec.

Size decides the vendor tier. Committing Stripe and GitHub would add ~16 MB of third-party YAML;
committing nothing would make the test suite depend on the network. One real spec is committed so
the default suite stays hermetic, and the giants are fetched. **Everything is pinned to a commit
SHA, never a branch** — otherwise a snapshot diff could come from an upstream edit rather than a
besdk change, and the snapshots would be worthless as a regression signal.

**`corpus/kitchen-sink` — hand-authored, ~280 lines.** Deliberately synthetic: a *conformance
fixture* written against the gap list above, not a substitute for a second real gnarly spec.
Being written to a documented checklist rather than to the implementation is what keeps it
honest, but it remains a weaker test than a spec nobody designed for besdk. Acquiring a real
second entry (Stripe, GitHub) stays open.

Every construct it covers was broken when it was first run, and **not one of those bugs was
caught by `tsc`**:

| Construct | What was wrong | Why the gate missed it |
|---|---|---|
| `allOf` on a named schema | `export interface Member {}` — every field lost | an empty interface is valid TypeScript |
| `oneOf` on a named schema | union dropped; variants never emitted | ditto |
| `text/csv` response | typed `Promise<Blob>` | a Blob is a real type, just the wrong one |
| `text/event-stream` | typed `Promise<Blob>` | ditto |
| `multipart/form-data` | body JSON-stringified | request shape is not typechecked |
| Declared error schemas | `ValidationError` never emitted | errors are untyped by default |
| Cursor pagination in an envelope | not detected; `Paginator<unknown>` | `unknown` typechecks everywhere |
| Dotted group `orgs.invoices` | flattened to `client.orgsInvoices` | a valid name, wrong shape |
| `apiKey` security scheme | no auth sent at all | auth is a runtime concern |
| Synthesized `Error` type | shadowed the JS global | shadowing is legal |

The lesson is recorded because it generalizes: **`tsc --noEmit` proves the output is
well-formed, not that it is useful.** Only reading the output and running it against a mock
server catches this class of defect, which is why §3.4 requires conformance tests rather than
treating the typecheck gate as sufficient.

### 3.9 Code preservation

**Decision: support both file-level protection and in-file marked regions, and never destroy code
when preservation cannot succeed.**

Without preservation the generator is unusable for real work: the first customization anyone makes is
erased by the next `generate`. Fern and Speakeasy each solved half of it, and the halves are not
interchangeable:

| | Fern | Speakeasy |
|---|---|---|
| Mechanism | `.fernignore` — whole files, never touched | `#region` markers inside generated files |
| Custom methods | subclass and re-export a wrapper | land on the generated class itself |
| Cost | an ignored file goes stale silently | the generator must read its own prior output |

besdk supports both, because a helper module and a one-method convenience wrapper are different
problems. A region keeps `client.assets.myHelper()` reading exactly like a generated method;
`preserve.files` is right for anything wholly yours.

**`preserve.regions` defaults to on, and getting that wrong made the whole mechanism a liability.**
It was opt-*in*. Every target emits `#region` markers unconditionally, with a comment saying custom
methods between them are preserved — so a user with no `preserve` block in `besdk.yaml` read an
invitation, wrote a method, regenerated, and lost it with no warning. Reproduced against the
kitchen-sink SDK: the method was gone and the run reported nothing. The merging logic was correct
throughout; the default alone caused it, and it was an inline `config.preserve?.regions !== true` in a
600-line command function.

Two things changed. The default is now opt-out, because a feature whose safe behaviour must be
discovered is not safe. And the test lives on a named predicate — `regionsEnabled(config)` in
`preserve.ts` — rather than on an inline comparison nothing could assert against. The general lesson is
worth keeping: **a generated file that invites the user to write code has already promised to keep it.**
The marker and the default are one feature, not two, and they were shipped as two.

**Three things neither Fern nor Speakeasy states, which matter more than the mechanism:**

1. **Preservation failure aborts.** If a region has content on disk and the regenerated file has no
   matching marker — a renamed marker, a resource that left the spec — generation writes *nothing*
   and exits non-zero. Silently dropping hand-written code is unforgivable, and a moved marker is
   exactly when it would happen. `--force-overwrite` exists but is never a default.

2. **Malformed markers are refused, not guessed at.** An unclosed region, a stray `#endregion`, a
   mismatched or duplicated name: each makes placement ambiguous, and guessing risks relocating code.

3. **Silent staleness is reported.** A preserved file also stops receiving improvements, so besdk
   says when holding one back has cost an update. This is the failure mode of a plain ignore list.

**Markers are brand-neutral** — plain `#region`/`#endregion`, the editor-folding convention — never
`besdk:`-prefixed. A marker carrying the tool's name would live in users' files, making a rename of
this project a breaking change for everyone who customized anything (§1.2).

**The explanatory comment sits outside the region, not inside.** Inside, the placeholder counts as
user content: it inflated the carried-region count from 1 to 25, and would have made every removed
resource's placeholder an "orphan" that blocks generation. An empty region must mean untouched.

**Where the work lives.** The target emits markers, because only it knows where a class body is and
what a comment looks like; the handshake declares `lineComment` so the core can find them
generically. The core does the splicing and the refusing. That keeps preservation language-agnostic
while leaving placement to the target.

### 3.9.1 Removing what is no longer generated

**Decision: besdk records the files it wrote to each output directory and removes, on the next run, the
ones it no longer generates. Only files it wrote itself are ever candidates.**

Generated output previously only grew. Rename a resource and the old module stayed on disk forever; there
was no way to get rid of it short of `--clean`, which deletes the directory wholesale. That was survivable
while every emitted path derived from a *resource* name — a stale resource module still compiled — and it
stopped being survivable the moment paths derived from *operation* names (§3.11), because those change
whenever a spec does.

It was reported as a generation that failed for a reason the user had not caused: a bare
`besdk generate <spec>` picked up an `examples/pagination.ts` left by an earlier run with a different
config, importing a client name the new run did not produce, and the examples typecheck gate — correctly —
rejected it. The orphan did not merely linger; it made every subsequent run fail.

**The record is what makes this safe, and it is the reason there is a record rather than a directory
sweep.** Clearing everything unclaimed would delete a `.git`, a `node_modules`, or any file the user added
without marking it preserved. Deleting something a generator did not create is unforgivable in a way that
leaving a stale file is not, so the rule is narrow: a path is removable only if besdk wrote it last time
*and* is not writing it now *and* preservation is not holding it. A corrupt or absent record means "we do
not know what we wrote", and the safe reading of that is to delete nothing.

The record lives in the state directory keyed by the **configured** output path, not inside the output — a
manifest inside a generated package would be published to npm with it. Keyed by the configured path rather
than the resolved absolute one, because the first version produced
`.besdk/users-jeff-www-besdk-sdks-kitchen-sink.written.json`: a filename carrying one machine's home
directory into a directory the repository commits, which would churn per checkout and stop matching the
moment the repo moved. These records are gitignored — they are local build state describing gitignored
output, not a baseline anyone should review, which is the opposite of the IR baseline sitting beside them.

Removals are printed, because a deletion nobody mentioned is indistinguishable from a bug and a user needs
to see what a rename cost.

**Confinement is asserted, not assumed.** A record is a file on disk and could be stale or hand-edited, so
following it blindly would turn a text edit into a delete-anything primitive. `removeOrphans` refuses any
path that resolves outside its output directory — `../`, absolute, or otherwise — and there are tests for a
sibling SDK directory specifically, because several SDKs generated side by side under one `sdks/` is the
normal arrangement and one run reaching into another's output is the failure that would matter most.

*Rejected alternative:* making `--clean` the default. It is the same operation with none of the safety,
and its blast radius is the whole directory.

*Rejected alternative:* deleting any file matching a pattern besdk owns (`src/resources/*.ts`). Patterns
drift from what is actually emitted, and the first time they disagree the tool deletes something it should
not have.

### 3.10 `besdk targets`

Reports which targets are installed and whether they will run. Worth a command because three
distinct failures are indistinguishable from `generate`: a target that is not installed, one that
crashes on handshake, and one that does not accept the IR version besdk emits. It also lets someone
writing a target check their handshake without generating anything.

**IR version compatibility lives in `protocol`**, beside `IR_VERSION`, because both `generate` (which
gates on it) and `targets` (which reports it) need it. A compatibility check that disagrees with
itself between two commands is worse than one that is merely strict — the duplication existed
briefly and was consolidated.

---

### 3.11 Generated examples and generated tests

**Decision (2026-08-06): generate a runnable example and a test per operation, and synthesize the
example *values* in the core rather than in each target.** This reverses the §8 entry listing "SDK test
generation" as surrounding product. It was classed that way by analogy with docs-site generation, and the
analogy is wrong: a docs site is a separate artefact *about* the SDK, whereas an example that compiles and
a test that runs are verification of the SDK itself, in the package, on the same gate as the code.

#### Why the values belong in the IR

The TypeScript target already has an example synthesizer — `exampleValue` and `callArguments` in
`docs.ts` — deciding what a plausible value for a field is: the first enum member, the spec's own
`example` when present, required fields in preference to optional ones, and a handful of real field names
when a schema declares nothing required. Every one of those is a **language-neutral judgment**, and none
of them is about syntax.

Copying that into five more targets would be the exact failure this document records five times over
(§3.3.8, §3.1.5.1, §8): one decision, six implementations, and the unexercised ones are wrong. Worse than
usual here, because divergence is invisible — a Python example using a different enum member than the
TypeScript example is not a test failure, it is two documents that quietly disagree about the same API.

So the IR gains `Method.example`: the argument values and a response body, as **language-neutral JSON**.
Targets render it in their own syntax and case the field names their own way — the same division as names
as token sequences (§3.2). One consequence worth stating: every language's example for an operation then
shows the *same* data, which is what makes six SDKs' documentation comparable.

*Rejected alternative:* each target synthesizes its own values from the type graph. Simpler per target,
and it is what exists today for TypeScript — but it puts a shared judgment in six places, and the whole
argument for having an IR is that shared judgments live in one.

*Rejected alternative:* emit examples only into docstrings and the reference document, no separate files.
Docstring examples are not compiled, so they rot — which is the reason TypeScript's `examples/` directory
is inside the typecheck gate rather than beside it. Both are wanted: the docstring for discoverability in
an editor, the file for the gate.

#### What a generated test must and must not do

**It runs against an injected transport, never a network.** Every target already accepts one, and it is
documented as the way to test code that calls the SDK (§3.3.x per language). A generated test that called
the real API would be an integration test that fails in CI for reasons having nothing to do with the SDK,
and the first thing any user would do is delete it.

Each test asserts the four things generated code is actually responsible for:

1. the **path** after parameter interpolation, including escaping
2. the **query string**, including that an omitted optional parameter does not appear
3. the **request body** encoding, and its content type
4. that a declared response **decodes** into the declared type

That list is deliberately not "does the endpoint work". It is the boundary between generated code and
hand-written runtime, which is precisely the seam no other test covers: the cross-language conformance
suite (§7) exercises twelve hand-authored scenarios against a real server, and unit tests cover each
runtime. Neither one touches operation number 87 of 121.

**The value is coverage, not depth.** A per-operation test is shallow by construction, and shallow tests
across every operation are what catch the class of bug this project keeps finding — a path built wrong for
one operation's parameter shape, a body posted in the wrong format for one content type.

That is not a prediction. **The first run against a real corpus spec found a shipped bug in the reference
target**: Twilio declares `application/x-www-form-urlencoded` on all 62 of its write operations, the
runtime's `BodyKind` knew only `json` and `multipart`, and so every one of the 62 was sent as JSON — a
request Twilio rejects outright. The generated TypeScript SDK for Twilio could not perform a single write.
It compiled, it passed `tsc --noEmit`, it passed prettier, it passed the twelve-scenario cross-language
conformance suite, and it had been committed as a corpus SDK. The one thing that could see it was an
assertion on a content type, on an operation nobody had hand-written a scenario for.

Worth being precise about why every other gate missed it. A typechecker cannot see a content type. The
conformance suite exercises the kitchen-sink spec, which declares JSON bodies. `besdk check` reports what
the *spec* fails to say, and this spec said exactly what it wanted. The gap was between what the spec
declared and what the target did with it, which is the seam generated tests occupy and nothing else does.

`BodyKind` now has a `form` variant and the target sets it from the declared content type. The multipart
and streaming gaps (§9) are the same shape and would have been caught the same way.

**Generated tests are overwritable output, not preserved.** They carry no preservation regions. A test a
user edits is a test that no longer follows the spec, and the honest place for a hand-written test is a
file the user owns via `preserve.files` (§3.9). Stated because the opposite default is tempting and it
would make the suite unable to track a renamed operation.

#### Generated tests are verified by running, not by typechecking

`tsconfig.examples.json` covers `src/` and `examples/`, and deliberately **not** `tests/`. The tests
`import { describe } from 'vitest'`, and a freshly generated directory has not had `npm install` run in
it — so including them made *every first generation fail*, on the one command a new user runs first.

`optional: true` on a gate could not have rescued this: it covers a missing *executable*, not a gate that
runs and fails. That asymmetry is worth remembering, because it makes "declare it optional" a weaker
escape hatch than it reads as.

The tests are not unverified as a result — they are verified by being **run**, which is the stronger check
and which vitest performs without needing anything installed in the output directory. A third config,
`tsconfig.tests.json`, is emitted for `npm run typecheck` to use once dependencies are present, so a user
who installs gets both.

#### Scope of the first increment

Design settled here; implementation proven in one target before it is copied. TypeScript first, because
its example machinery already exists and moving it into the core is the change that makes the other five
cheap. The remaining targets are tracked in §9 rather than assumed — a design proven once is not the same
as a design proven six times, which is the lesson §3.3.3 and §3.3.5 exist to record.

## 8. Where this stands against Fern and Speakeasy

Recorded so the gap is not rediscovered, and so the sequencing reasoning survives.

### The bar

The standing goal is to be **credibly as good as Fern or Speakeasy**, which needs a definition or it
can never be reached. Three conditions, and deliberately not "feature parity" — see *Parity is the
wrong goal* below:

1. **Nothing under "Blocks adoption outright" remains.** These are the items where a team evaluating
   besdk stops evaluating.
2. **Nothing under "Correctness gaps inside what is already claimed" remains.** These are worse than
   missing features: a missing feature is honest, a broken promise is not.
3. **The differentiators stay genuinely better, not merely present.** `besdk check`, direction-sensitive
   `besdk diff`, reading competitors' extensions, and the no-lock-in thesis are the reasons to choose
   this over a funded product. A feature that exists but is worse than the competitor's equivalent is
   not a differentiator.
4. **Nothing under "Client-level features the competitors ship and besdk does not" remains undecided.**
   Not *built* — decided. A recorded non-goal satisfies this; a blank does not. The list exists because
   the first three conditions are all measured against besdk's own intentions, and a gap nobody wrote
   down cannot fail any of them. It is refreshed by reading the competitors' published documentation,
   because their navigation is the only inventory of their features that is not marketing.

Explicitly **out of scope**, as a decision rather than an omission: docs-site generation, MCP server
generation, and a hosted playground. Those are product surface around an SDK generator, not SDK
quality, and chasing them is how an open-source project loses on the axis it can actually win.

For scale: Speakeasy ships 10 languages at $600 per month per language; Fern ships 9 including
Swift, plus a documentation product and support for AsyncAPI, OpenRPC, and gRPC.

### Done since this list was written

1. ~~**Code preservation across regeneration.**~~ Built (§3.9): `preserve.files`, `.besdkignore`, and
   `#region` markers, with a refusal to write rather than a destructive merge when markers are
   ambiguous.
2. ~~**A second and third language.**~~ Built: Python (§3.3.2) and Go (§3.3.4), each written *in* its
   own language and using its own toolchain as a gate. The architectural risk this was meant to
   surface is discussed in §3.3.3 and §3.3.5 — the IR needed no changes; the protocol needed two
   additions.
3. ~~**A real second corpus spec.**~~ Twilio is vendored and pinned; Stripe, GitHub, and Box are
   fetched on demand (§7). All four generate and pass every gate in all three languages.
4. ~~**Cross-language behavioural proof.**~~ Built (§3.4.2). This was not on the original list and
   should have been: it is what turns "all languages behave identically" from a claim into a test,
   and it found three real defects on its first run.

### Blocks adoption outright — none remaining

5. ~~**OAuth2 flows.**~~ Built on all three targets (§3.1.6): client credentials and refresh, with
   single-flight refresh, proactive expiry, and retry-once-on-401 in each. The authorization-code
   redirect is deliberately *not* implemented and never will be — it needs a browser, so it belongs to
   the application, and an SDK claiming to own it would be lying.
6. ~~**Publishing automation.**~~ Built as `besdk release` (§3.5.1): the version comes from the
   contract diff, the changelog from the same changes, and the publishing steps are *emitted* as a CI
   workflow rather than run. **Nothing under "Blocks adoption outright" remains.**

### Language coverage

Fern generates nine SDK languages; besdk generates six. **Decision (2026-08-06): match Fern's set, PHP
and Java first** (§3.3.6). Not on the "blocks adoption" list, because good SDKs beat numerous ones and a
team whose language is missing can write a target against the public protocol. But it is the most visible
gap in a side-by-side comparison, and the argument that once justified stopping at three — proving the IR
language-neutral — is now settled evidence rather than an open risk (§3.3.3, §3.3.5).

| Built | Next | Planned |
|---|---|---|
| TypeScript, Python, Go, PHP, Java, .NET | Ruby | Swift, Rust |

Each built target has a hand-written runtime, a target written in that language, declared gates, and a
cross-language conformance driver — so all twelve scenarios are asserted to behave identically in six
languages. Streaming is absent from PHP, Java, and .NET; multipart from everything but TypeScript. Both are
skipped with a warning rather than emitted as something that cannot work.

**Two languages sit outside the tracked set**, and both are deliberate rather than overlooked:

- **Kotlin** (Stainless ships it). A Kotlin consumer can use the Java SDK — that is what JVM
  interoperability is for — so this is the cheapest gap on the list to *decline*. It becomes worth doing
  only for coroutine-native suspend functions, which is a genuine idiom difference and not urgent.
- **Postman collections** (Fern ships them) and **Stainless's "SQL"** are not SDKs. Generating a Postman
  collection from the IR would be straightforward and is squarely the product surface §8 rules out.

Recorded so the roadmap's "nine languages" is a claim about Fern's SDK set specifically, not about every
artefact either competitor lists as a generator.

### Correctness gaps inside what is already claimed

7. ~~**Runtime response validation.**~~ Built on all three targets (§3.4.1.1), and the cross-language
   suite asserts they reject the same violation with the same path. Go turned out to need it *most*:
   `encoding/json` silently discards a type mismatch, so an unvalidated Go SDK cannot tell a wrong
   value from a zero one.
8. Webhooks — signature verification and typed handlers.
9. ~~Discriminated-union decoding at runtime.~~ Built (§3.1.7): a `discriminator` mapping narrows each
   member's field to its literal, so TypeScript narrows and checks exhaustiveness with no help, and
   pydantic dispatches to the right class. Go still has no sum type, so a union remains `any` there.
10. ~~`anyOf` and `oneOf` are conflated.~~ Recorded distinctly in the IR as `combinator` (§3.1.7).
    Validated identically on purpose, which is what the `T006` ambiguity diagnostic exists to
    compensate for.
11. ~~Server variables and templated server URLs.~~ Built on all three targets (§3.4.0.2). The IR
    resolves defaults so `Server.url` never contains a placeholder, and each variable becomes a client
    option typed to its declared values.
12. ~~Date coercion.~~ Built (§3.4.1.2). Go already coerced via `time.Time`; TypeScript now revives
    `date-time` as a `Date` in the walk that validation already performs. `format: date` deliberately
    stays a string in TypeScript, because JavaScript has no date-only type and a `Date` for a calendar
    date shifts by a timezone — the one place the three targets legitimately differ.
13. ~~Idempotency keys, for safe replay of non-idempotent requests.~~ Built on all three targets
    (§3.4.0.1). Listed here as a missing *feature*; it was a **bug** — the retry policy never looked at
    the HTTP method, so a `POST /charges` returning 503 was sent three times. The cross-language suite
    now asserts both halves: exactly one request without a key, two with byte-identical bodies with
    one. `targets.<name>.idempotencyHeader` names the header, which is not standardised.

### Client-level features the competitors ship and besdk does not

Derived by walking Stainless's and Fern's published documentation and diffing their feature inventory
against what besdk *emits* — not against what this document intends, which is the comparison that flatters. Everything here is a **wire- or client-level capability**, not product
surface, so none of it is excused by the out-of-scope decision above.

**WebSocket clients.** Both competitors generate them; besdk has no mention of them anywhere, in the IR
or in this document, which makes this the one gap that was not even a recorded non-goal. The decision
needed first is whether it belongs at all: a WebSocket API is not described by OpenAPI, so supporting it
means reading a second definition format (AsyncAPI, or a vendor extension), and that is a larger commitment
than any target-side work. Recommended answer: an explicit non-goal until an AsyncAPI story exists, stated
here so it is a decision rather than a blank.

**~~Webhook signature verification.~~** Built in TypeScript (§3.4.1.3); the other five targets need the
event union and one hand-written verifier each. The IR carries both halves for every language.

Worth recording what the work actually cost, since this entry claimed "thirty lines of HMAC per runtime":
the HMAC was indeed about thirty lines, and the *rest* — reading a header case-insensitively behind both
Node and Lambda, refusing a request from the future, refusing a signed-timestamp scheme with no timestamp,
keeping the expected signature out of the error — was several times that, and every one of those is where
a hand-rolled verifier goes wrong. The estimate was right about the crypto and wrong about the feature.

**Dynamic authentication.** Fern lets a caller supply a *callback* that produces a credential per request.
besdk resolves auth once at construction, and the only moving credential it supports is an OAuth2
`TokenSource`. Every runtime therefore forces "rotate a credential" to mean "construct a new client" —
which is what §3.1.5.1 documents, honestly, but it is a workaround rather than an answer. An API gateway
issuing short-lived tokens out of band is a common enough deployment that the `Auth` union should grow a
`provider` variant carrying a supplier the transport calls per request. This is a runtime change in six
languages plus one IR-free constructor argument, so it is bounded.

**Unstable and audience-filtered endpoints.** Stainless marks endpoints unstable; Fern filters by audience
(`x-fern-audiences`, which besdk reads and reports as unsupported). Both are the same underlying feature —
*emit a subset of the spec, chosen by annotation* — and besdk has one half of it already in
`x-besdk-ignore`, which is unconditional. Generalising `ignore` into a named-audience filter is a
normalizer change, and it is the cheapest item here. The reason it matters more than it looks: a team with
internal endpoints in one spec cannot ship a public SDK from it today without maintaining a second spec,
which is the exact lock-in this project exists to avoid.

**SSE metadata.** Fern exposes the event `id` and `retry` fields alongside the decoded payload. besdk's
TypeScript runtime parses the framing and discards everything except `data:`, so a caller cannot implement
resumption via `Last-Event-ID` — which is the one thing the metadata is for. Cheap to fix wherever SSE is
already decoded, and it should be settled *before* Python and Go grow SSE decoding, so all three yield the
same shape rather than converging later (§9).

**.NET target-framework breadth.** The generated `.csproj` pins `net8.0`. Fern documents multi-targeting
down to `netstandard2.0`, which is what lets a package be consumed by Unity, Xamarin, and .NET Framework
applications. Pinning is a defensible default and an indefensible only option; the open part is whether
besdk multi-targets by default or exposes `targetFrameworks` in config.

**Python is the one target with runtime dependencies**, and Fern offers `aiohttp` where besdk pins `httpx`.
Transport injection already exists everywhere, so a caller is not blocked — but "which HTTP library does
this add to my dependency graph" is a question every other target answers with "none", and Python answers
with three (§8, dependencies). Worth a decision recorded either way rather than an inherited default.

**Not gaps, and worth recording so nobody builds them twice.** Both competitors document a *preview* or
*local generation* workflow — Fern's "Local SDK previews", Stainless's "Preview builds" and "Branch-based
changes". Those exist because both are hosted services where generation normally happens on someone
else's machine against a tracked branch. besdk generates locally, from a spec on disk, into a directory
you name, every time; `--emit-stage` exposes each pipeline stage and `besdk diff` shows what regenerating
would do to consumers before it does it. There is nothing to add here, and a `--preview` flag would be a
synonym for `generate`. Likewise Stainless's "AI-generated commit messages": `besdk release` derives the
changelog from the *contract diff*, which is strictly more reliable than inferring it from a diff of
generated text.

**Deprecation is emitted by five targets of six.** TypeScript emits `@deprecated`, Python and Go a doc
note, Java `@Deprecated`, .NET `[Obsolete]` — and **PHP emits nothing**, despite carrying the flag through
the IR. The reason nobody noticed is the more useful finding: **no corpus spec declares a deprecated
operation**, so five implementations of this are untested and the sixth's absence is invisible. This is the
same shape as every other bug in this document (§3.3.8) — one decision, six implementations, and the
unexercised ones are wrong — and the fix is a corpus entry before it is a target change.

### The surrounding product, and operations

Docs-site generation (Fern's real differentiator), `x-codeSamples` injection, MCP server generation,
playground. **SDK test generation moved *out* of this list on 2026-08-06** — it was grouped here by
analogy with docs-site generation, and the analogy does not hold: a test that runs on the package's own
gate is verification of the SDK, not product surface around it. Designed in §3.11. Operationally: a standalone binary for air-gapped use — besdk
requires Node — spec-change-to-PR automation, and generator version pinning.

### The largest risk, and how it turned out

**The central architectural claim was untested.** §3.2 asserts the IR is language-neutral, so every
target is a projection of one set of decisions — but every field of it was designed while looking at
one TypeScript target, so some of it was probably TypeScript-shaped without anyone having noticed.

Two more targets later, the answer is recorded in §3.3.3 and §3.3.5: **the IR needed no changes.**
Names as token sequences did exactly their job, and `role` on an object type landed precisely on a
distinction Python and Go both wanted independently. What *was* missing lived in the target protocol,
not the IR — targets could not declare their own verification gates, and the documented `besdk.yaml`
escape hatch for locating a target had never been implemented. Both were added, and Go then needed
neither, which is the evidence that they were the right abstractions rather than Python-specific
patches.

One genuine limit surfaced: Go needs to know *which field* closes a value cycle, and the IR's
type-level `cyclic` flag cannot say. That is target-specific knowledge about value semantics and it
belongs in the target, so the IR is not wrong — but it is the one place where a target had to compute
something the IR could not hand it.

### Parity is the wrong goal

An open-source project does not beat funded competitors on feature count. It wins by being credibly
better on a few axes and adequate elsewhere. The candidates, all already built:

- **`besdk check`** (§3.6) — surfacing under-specification appears to be genuinely novel.
- **`besdk diff`** (§3.8) — direction-sensitive breaking-change classification: read and write models
  break in opposite directions, and that distinction does not appear to be handled elsewhere.
- **Reading competitors' extensions** (§3.1.5) — a Fern-annotated spec works immediately. A migration
  wedge rather than a feature.

Plus the thesis in §1: no vendor can strand you.

### Recommended order

1. ~~Code preservation~~ — done.
2. ~~Python target~~, then ~~Go~~ — done; the IR held.
3. **Runtime validation** — closes the gap in item 7, and the asymmetry is now demonstrable rather
   than theoretical. Next.
4. OAuth2.
5. Publishing automation.

Steps 1 and 2 carried the real architectural risk and it did not materialise. What remains is known
work, which is a much better position to be in than the same list was three iterations ago.

---

## 9. Open questions

**~~Runtime response validation is not on every target.~~** Resolved (§3.4.1.1) — all three validate,
`strict` by default, and the conformance suite asserts they agree on the same violation and the same
path. The ordering constraint this question anticipated turned out to be real: Go must validate before
unmarshalling, because `encoding/json` discards a mismatch silently.

What remains is narrower and worth stating separately. **Python coerces where the others only check.**
pydantic turns a `format: date-time` string into a `datetime`; TypeScript and Go hand back the string
(§8 item 12). So the three agree on *what is rejected* but not on *what a caller receives*, which is a
smaller inconsistency than the one just closed and a different kind: it is about richness, not safety.
Fixing it means the TypeScript and Go runtimes coercing declared formats too, which is a
straightforward extension of the descriptor table — the descriptors already carry `format` information
the walker currently ignores.


**~~Form-encoded request bodies are broken in five targets of six.~~** Resolved. Every target now honours
`application/x-www-form-urlencoded` on the request body, verified by generating a form-only spec in all six
and by 62 correct call sites each in the Twilio SDKs.

The finding worth keeping is how the other five were confirmed. TypeScript's instance was caught by a
generated test asserting a content type; the other five were *inferred* from the same shape and then
checked by hand — and every one of them was broken, in the same place, for the same reason. Ironically each
runtime already knew how to form-encode: all five did it for the OAuth2 token request and nowhere else. A
capability present in a runtime and unreachable from the target is the recurring shape of this document
(§3.3.4), and it appeared here for the fourth time.

**One decision, one implementation, per language.** Each target routes the body through its *JSON*
representation before form-encoding it — `json.Marshal` then flatten in Go, `toJson()` then flatten in Java
and C#, `json_encode`/`json_decode` in PHP, pydantic's dump in Python. Reflecting over the model separately
would be a second implementation of field naming, and the two would disagree the first time a wire name
changed. The cost is a round-trip through JSON on every form request, which is not measurable against a
network call.

Three sub-decisions, identical in all six because a form body has no standard for any of them: a list
becomes a **repeated key** (`key[]=` is a PHP convention servers outside PHP do not read, and `key=a,b` is
a third); a nested object is **JSON-encoded**, matching the multipart path, because form encoding has no
canonical nesting and inventing one would send something no server asked for; and an integral float is
written as an **integer**, because a JSON parser hands back `1.0` for an id and a server expecting `1`
rejects it.

**Two pre-existing target bugs surfaced from generating Twilio in PHP and .NET for the first time**, both
found only because form encoding made those SDKs worth generating at all:

- **.NET: a required `unknown` field did not compile.** It renders as non-nullable `object` and decoded via
  a helper returning `object?` — CS8601, an SDK that does not build. Every other required type in that
  decoder already fails loudly on absence; this one silently did not.
- **PHP: an optional list decoded to a raw array.** Declared `list<string>` and assigned
  `array<mixed, mixed>`, which PHPStan level 9 rejects — and which was also wrong at runtime, since the
  elements were never converted. Narrowed now by `array_values(array_filter(...))`: filtering alone
  preserves the original keys, so list-ness is lost and the type is still wrong. A doubled `null|null|` in
  the docblock of a field both nullable and optional was fixed alongside it.

Both are the same lesson as §3.3.4 once more: **a corpus entry only exercises the targets it is generated
in.** Twilio was a TypeScript-only corpus SDK, so two targets carried build-breaking bugs against it
without anyone knowing.

**~~Every corpus spec should be generated in every target, and is not.~~** Resolved. `generate:all` runs
twelve SDKs — both corpus specs in all six languages — and `pnpm verify` runs it.

The measurement settled the where: **two minutes for all twelve**, of which the five new Twilio pairings
are 75 seconds and PHP alone is 44 (PHPStan level 9 over 892 files). That is cheap against four
build-breaking bugs in two turns, and a CI-only gate is one nobody sees until after they have pushed — so
it belongs in the local loop.

**Webhooks exist in one target of six** (§3.4.1.3). TypeScript has the event union and the verifier; the
IR carries both halves for every language. Each remaining target needs the union — ordinary generation —
plus one hand-written verifier, which is deliberately *not* shared by generating it: an HMAC comparison is
exactly the code that should be reviewed once per language rather than emitted per SDK.

The ordering question worth answering first: whether the five verifiers should be five hand-written files
or one descriptor interpreter per language reading the same `WebhookSignature`. They are the same thing —
the descriptor already *is* the shared decision, and the per-language file is the interpreter. Recorded
because "share the verifier" sounds like the right instinct and would mean generating crypto.

**~~Per-operation examples and tests exist in three targets of six.~~** Resolved. All six emit them, each
in that language's own idiom and location. Rolling out to the last three found five more bugs, three of
them in shipped SDK code:

Rolling out to two more targets found four further bugs, which is the pattern holding:

1. **The Python SDK could not send a model as a request body.** `prune_body` passed a pydantic model
   through untouched and httpx serialises with the *stdlib* encoder, which raises
   `TypeError: Object of type MemberInvitedEvent is not JSON serializable`. Every operation whose body is
   a named schema failed at runtime. Nothing caught it because the conformance driver passes plain dicts;
   a generated test, which constructs the declared model exactly as a user would, found it immediately.
2. **The generated Python package's mypy config lacked the pydantic plugin,** so mypy typed every model's
   `__init__` by field *alias* — `WidgetCreate(friendly_name="x")` was an error despite
   `populate_by_name=True` making it work. That is wrong for the examples and wrong for any user code
   doing the same, which is the more important half.
3. **Python omitted the content type on an empty form body.** `data={}` makes httpx send no body *and* no
   header, so a POST whose form fields are all optional and all unset arrived unclassifiable. PHP, Java,
   and .NET all set it. The form body is now encoded explicitly and the header set unconditionally, which
   also makes the repeated-key rule this project documents ours rather than httpx's.
4. **Go's generated example naming failed `go vet`.** `ExampleOrgsListMembers` reads fine and vet rejects
   it: the convention is `ExampleType_Method`, and vet checks that the part before the underscore names a
   real identifier. The one case so far where a *language's own tooling* enforced a naming rule no other
   target has.

**Each target's rendering differs, and that is the design working.** TypeScript needed `new Blob([…])`
where the core supplies a string; Python needed `UUID("…")` and model construction rather than a dict; Go
needed `core.String(…)` for an optional field, a named type for an enum, and its params struct only where
the method declares one. Every one of those is a *type-system* fact, not a data fact — which is exactly the
line §3.11 draws. The values were never in question once they lived in the IR.

**Where the tests live is each language's own convention, not a house style.** TypeScript gets
`tests/operations/*.test.ts` under vitest; Python `tests/operations/test_*.py` under pytest; Go
`operation_*_test.go` **in the package itself**, because that is where `go test` looks and a separate
directory would need its own module. Go's examples are `ExampleType_Method` functions in a `_test.go` file
for the same reason — `go doc` shows them beside the method. Imposing one layout would have produced output
that reads as generated in five languages out of six.

**Go's test gate is not optional, unlike the other two.** A test runner has to be installed in the output
for vitest and pytest; Go's is the toolchain, so if `go build` could run then `go test` can. The gate also
passes `-count=1`, because Go's test cache would otherwise report a pass from a previous run against
different generated code — the exact failure a gate exists to prevent.

**Three shipped SDK bugs, one per target, found by the last three rollouts:**

1. **Java could not send a union body at all.** `Json.write` threw
   `cannot serialise MemberInvitedEvent as JSON`. The runtime has a `Json.JsonValue` interface whose own
   docblock reads "generated request models implement this" — and no generated model did. A union body
   renders as `Object`, so the target had no model type to call `toJson()` on and passed the value straight
   to the writer. Every record now declares the interface, which is what makes the runtime's promise true.
   Worth noting: the *runtime documented* the contract and the *target* never met it, which is a new
   variant of the drift §3.3.4 records — usually the runtime has an unreachable capability, here it had an
   unmet expectation.
2. **PHP's examples referenced classes they never imported.** A fatal error at run time in the one language
   of the six with no compiler to catch it. Invisible because `phpstan.neon` scoped to `src` — so the gate
   passed while every example was broken, and the example's own docblock claimed PHPStan checked it.
   `examples` is in scope now.
3. **PHP examples reached nested resources as properties.** `$client->orgs->invoices` does not exist; a
   nested resource is a lazily-constructed *method*. Caught the moment the examples entered PHPStan's
   scope, which is the same finding as (2) from the other direction.

**Two gates were wrong rather than the output being wrong**, and both are worth recording because the
symptom read as a generation bug:

- **Java's `javac` gate compiled `src` recursively**, which now includes `src/test` and its JUnit imports —
  so it failed with "package org.junit.jupiter.api does not exist". Scoped to `src/main`; the tests are
  compiled and run by `mvn test`, where the dependency resolves.
- **Maven ran under whatever JVM its own environment pointed at** and failed with "release version 21 not
  supported" against a pom that targets 21. The gate now sets `JAVA_HOME` to the JVM the launcher already
  chose for being new enough — a target knows where its own tools are and the core does not, which is what
  §3.5 asks for.
- **The Java conformance driver globbed the same directory** and broke for the same reason, one layer out.
  It compiles the generated SDK with a bare `javac` and no classpath, so `src/test` was unbuildable there
  too. Worth recording as its own instance rather than folding into the one above: **two independent
  consumers assumed "the SDK's sources" meant everything under `src`**, and adding a directory falsified
  that assumption in both. The fix is the same in both — `src/main`, the public surface — but nothing
  connected them, and the second surfaced only when the whole suite ran.

**A generated test must not trip its own framework's linter.** xUnit's analyser reports
`ConfigureAwait(false)` in a test as a defect (xUnit1030), because it bypasses the runner's parallelisation
limits — so the .NET tests omit it while the SDK and the examples keep it. A generated test that its
framework flags is a generated test someone deletes.

**Two more PHP decode bugs, found only at Twilio's scale.** An optional *map* field and an optional list of
*enums* both decoded to a raw array — declared `array<string, mixed>` and `list<EnumPermission>`
respectively, assigned `array<mixed, mixed>`. PHPStan level 9 rejects both, and both were wrong at run time
too: the elements were never converted, so a caller iterating `$permissions` got strings where enum cases
were promised.

Three shapes, three narrowings, and the distinction is load-bearing: a **map keeps its keys**
(`ARRAY_FILTER_USE_KEY`), a **list must discard them** to stay a list (`array_values(array_filter(…))`),
and a **list of enums** converts each element through `tryFrom` and drops unknown members. The scalar-list
case was fixed earlier in this session and the other two were not — because the kitchen-sink spec has
neither, and Twilio was not being generated in PHP at all until form encoding made it worth doing.

That is the same lesson as the earlier PHP and .NET Twilio bugs, one turn later: **a corpus entry only
exercises the targets it is generated in.** Worth acting on rather than recording again — generating every
corpus spec in every target would have surfaced all four of these at once.

**Three assertions about ordering, each read from the emitter that decides it rather than recomputed:**
PHP enum case names (uniquified by order), Java record component order (required first), and Python
attribute names. All three had the same failure available — recompute independently, disagree the moment
two names collide — and the Python one actually shipped before it was caught.

**One attribute-name map, not two.** The Python model emitter disambiguates attribute names by *order* —
two wire names can sanitise to one identifier, and which gets the suffix depends on which was seen first.
The example renderer recomputed the name instead of reading it and produced `id_=` where the model declared
`id`. The mapping is now recorded where it is decided and read where it is used, which is the same fix as
every other instance of this pattern in this document.

**~~Multipart request bodies exist in one target of six.~~** Resolved. All six encode
`multipart/form-data`, verified by generating and running the kitchen-sink upload operation in each.

**Two designs, decided by what each language's type system can express.** In TypeScript, Python, and Go the
*runtime* decides which field is a file, by value type — `Blob`, `bytes`, `[]byte`. In PHP, Java, and C# a
`format: binary` field is a `string`, indistinguishable from a name, so the **target passes the binary field
names** read from the IR.

That split is worth being precise about, because it looks like the thing this document keeps warning
against. It is not. "Which *type* means file" is the shared judgment, and it is answered identically in all
six — the binary type, whatever the language calls it. Three languages have no such type, so the answer has
to arrive from outside, and what arrives is *IR data*, not a second judgment. A target passing along what
the IR says is the target doing its job; a target deciding what a plausible value is (§3.11) would not be.

**The boundary and the body are returned together, always.** `Multipart::encode` returns both the payload
and the content type, in every language that needs it. The content type carries the boundary the encoder
generated, and a boundary invented separately from the body it delimits is the one multipart mistake that
cannot be recovered from — the request is simply unparseable, with nothing on the client side to indicate
it. In .NET this meant hand-rolling rather than using `MultipartFormDataContent`, which owns its boundary
internally and reveals it only once attached to a request.

**A multipart body is bytes, and three runtimes had no way to send bytes.** Java, .NET, and PHP all took a
pre-encoded `String` body. For PHP that is fine — a PHP string is a byte array — but Java and .NET would
have UTF-8 encoded the payload, corrupting any uploaded file that is not valid text, which is most of them.
Both gained an explicit byte-body path: `HttpRequestSpec.bodyBytes` in Java, an init-only `BodyBytes` in
.NET, chosen over a positional record component so a user-written transport keeps compiling.

Two smaller consequences worth recording:

- **`headersFor` decides whether to set a content type from whether there *is* a body**, so it had to be
  shown the byte form too. Missing that sent multipart requests with no content type at all — the header
  the boundary lives on.
- **A random boundary, not a fixed one.** A fixed boundary appearing inside an uploaded file truncates the
  request at that point, and a file is exactly the content most likely to contain arbitrary bytes.

**The brand guard was not scanning `.php`,** and had not been for as long as PHP has been a target. Found
when a boundary prefixed with the project name landed in four runtimes and only three were reported. Two
genuine offenders had been sitting in PHP the whole time: the namespace-identity literal, which is
legitimate and now exempted alongside Java's and Go's equivalents, and **the runtime's default user agent,
`besdk-php`** — the generator's name travelling in consumers' HTTP traffic, which §1.2 forbids outright. It
is `sdk-php` now, role-named like `SDKError`. A rule enforced in five languages of a six-language project is
not enforced, which is the third time this document has recorded that sentence about a different guard.

**~~OAuth2 is wired up in three targets of six.~~** Resolved. All six emit the constructor arguments that
reach their runtime's token source, verified by generating the kitchen-sink spec — which declares both the
client-credentials and refresh flows — in each.

The three that were missing needed no runtime work at all: `OAuth2Auth`, `TokenSource`, and `OAuth2Config`
were already there, tested, and unreachable. That is the shape §3.3.4 keeps recording, and this was its
fourth instance in a row. What it cost to fix was a constructor argument per credential and one expression —
which is the measure of how cheap the gap was and how long it sat there anyway.

**The token source is built into a local, before the auth expression, in every target.** Not a style
choice: the source needs *the caller's transport*. A token fetched over a different one bypasses a test's
injected transport and makes a real network call for authentication, which defeats the only reason transport
injection exists. Inlining the construction into a conditional expression is what makes that easy to get
wrong, so all six assign `tokenSource` first and the expression reads it.

**Both flows accept client credentials.** The refresh flow needs them whenever the token endpoint is
confidential, which plenty are — so `clientId` and `clientSecret` are offered for `refreshToken` too, and
only `refreshToken` itself is conditional on the flow.

**OAuth2 outranks a static credential in the auth expression.** A spec declaring both means "fetch a token,
or accept one I already have", and the fetched one is the fresher of the two. Same precedence in all six.

**`release --workflow` scaffolds three registries of six.** npm, PyPI, and Go modules. Packagist is
tag-driven and needs almost nothing; NuGet is a `dotnet nuget push`; Maven Central needs GPG signing plus
`sources` and `javadoc` jars, which vary enough per organisation that emitting a guess would be worse than
emitting nothing. The open question is whether the Java job is scaffolded with the signing left as a
`TODO` a user must fill in, or omitted — a workflow that fails on first run is a specific kind of bad.

**Streaming means three different things in the three targets that support it.** TypeScript decodes SSE
framing and yields the declared event type. Python yields raw lines. Go returns an `io.ReadCloser`. All
three declare the same `streaming` capability, so the capability name is currently the least informative
thing about it. Either the capability splits (`streaming-typed` versus `streaming-raw`), or Python and Go
grow SSE decoding — the second is the better answer and the framing logic already exists in the
TypeScript runtime to copy the semantics from.

- **Union representation per language** — the canonical taste decision needing an explicit
  documented answer rather than an ad-hoc one. Deferred until a corpus spec with real
  discriminated unions exists; Pixwel's 35 `oneOf`s are mostly artifacts (§3.1.2), so deciding
  from them would overfit.
- **Version-bump automation.** `besdk diff` (§3.8) reports the implied semver bump, but nothing
  applies it to the generated `package.json` yet. Open: whether besdk should write the version,
  or only report what it should be.
- **Corpus selection beyond Pixwel.** Which specs, prioritized by the coverage gaps listed in
  §7, and how they are vendored and pinned.
- **Capabilities are declared but never enforced.** Every target declares a `capabilities` list and
  `besdk targets` prints it, but nothing compares it against what the IR actually contains. A target
  that does not declare `streaming` still receives streaming operations and either handles them or drops
  them silently — the outcome §3.5 says the field exists to prevent. The open part is what enforcement
  should *do*: refuse to generate, generate and warn, or omit the affected methods and say so. Refusing
  is the safest and the most annoying; omitting silently is what happens today.

- **The verification gate in languages without a strict typechecker.** `AGENTS.md` makes
  "passes the language's own strict typechecker" non-negotiable, and that holds for PHP (PHPStan 9 /
  Psalm max), C#, Swift, and Rust. Ruby is the exception: Sorbet and RBS exist but are not universal, so
  a generated `.rbs` nobody consumes is not the same guarantee as a `mypy --strict`-clean package. Does
  Ruby's gate become RuboCop plus a conformance run, and does that meet the bar or visibly fall short of
  it? Needs answering before Ruby, not during (§3.3.6).

- **Runtime distribution.** Whether the hand-written runtime is vendored into generated output
  (`src/core/`, current plan — no dependency to trust) or published as a versioned package
  (patchable without regeneration). Tradeoff not yet resolved; vendoring is the initial choice
  because it keeps generated SDKs self-contained.
