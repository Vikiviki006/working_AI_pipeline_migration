# AI_Pipeline

Oracle → PostgreSQL migration pipeline. An Express 5 + TypeScript service that
turns Oracle table metadata plus a natural-language transformation request into
verified PostgreSQL DDL and paired data-migration query templates.

**Nothing is written to disk.** Every generated statement is returned tagged
with the path it *would* occupy inside a migration bundle, so a downstream
runner can materialise the project with exactly those names.

---

## The one invariant

> **The model proposes. Code disposes.**

Every AI stage in this repo produces *text* — a schema document, a DDL
statement, a SELECT. None of that text is ever trusted. Two deterministic
modules decide what is allowed:

- `src/lib/schemaVerifier.ts` — parses metadata, verifies structural
  soundness, computes the authoritative source→target diff, plans the build.
- `src/lib/sqlGuards.ts` — pure SQL text analysis. Proves a statement is
  exactly one statement of an allowed kind, touches only objects that really
  exist in the supplied metadata, and carries no row data.

The diff is computed **before** the model is called. The model's output is then
checked back against that same diff. Consequence: the model can never introduce
a table, column, or statement the diff did not call for.

**If you add an AI stage, add the corresponding guard.** An unguarded stage is
a bug, not an incomplete feature.

The one deliberate exception is **Jev routing** (§ *Provider chain*), whose
output is a *preference about which provider to call*, not an artifact. It can
only change latency and cost. Every guard downstream applies unchanged whichever
provider it names.

---

## Layout

```
src/
├── index.ts                 Express bootstrap, /health, /api/layout
├── config/env.ts            .env loading, fails fast on missing keys
├── types/types.ts           Shared request/response types, fallback order,
│                            OpenRouter model catalogue (models, limits, prices,
│                            tiers)
├── routes/
│   ├── schemadesignRoute.ts     POST /api/schema-design + jevRoute()
│   ├── dataMigrationRoute.ts    POST /api/data-migration
│   └── routeHelpers.ts          error → HTTP status mapping
├── ai/
│   ├── aiClient.ts          provider chain, in-code default, circuit breaker
│   ├── jevModel.ts          the OpenRouter model question, shared by the
│   │                         route and the provider; code-side catalogue sort
│   ├── providers/            groqProvider.ts, geminiProvider.ts,
│   │                         openrouterProvider.ts
│   ├── prompts/              one system prompt per stage
│   ├── schemas/              provider JSON Schema + response Zod validators
│   └── services/             one orchestrator per stage
└── lib/
    ├── sqlGuards.ts         pure SQL text guards
    ├── schemaVerifier.ts    metadata verification, digesting, diffing, planning
    ├── fileLayout.ts        canonical bundle paths, filename derivation
    └── errors.ts            typed failures that map to status codes
```

Source files are camelCase. The `.js` extensions in import specifiers are the
NodeNext requirement, not a leftover from a JavaScript layout.

There is no `jevRouter.ts`. Jev routing is a function in
`routes/schemadesignRoute.ts`, because it is one step of that route, not a
route of its own. It has no endpoint and never had one.

`ai/jevModel.ts` is the one exception, and it is not a stage and not a route.
It holds the **model** half of routing — the decisions endpoint, the model
question, the acceptance test, and the code-side sort — because the OpenRouter
provider has to be able to choose a model for itself when the route pinned
nothing, and two copies of a nine-option question with two different sets of
limits would drift. The provider decision, which only the route can make, stays
in the route.

---

## The four-file convention for a stage

Every AI stage is exactly four files. Do not merge them, do not add a fifth.

| File | Exports | Rule |
|---|---|---|
| `prompts/<stage>Prompt.ts` | `<STAGE>_SYSTEM_PROMPT: string` | The model's instructions. Domain rules, sentinels, output format. |
| `schemas/<stage>Schema.ts` | `<stage>JsonSchema: Record<string, unknown>` | **Plain JSON Schema**, not Zod. Sent to Groq as `json_schema.schema` and Gemini as `config.responseSchema`. Needs `additionalProperties: false` and every property in `required`, or Groq's `strict` mode rejects it. |
| `schemas/<stage>Zod.ts` | `<stage>Response` (Zod) | Validates what came *back*. Cross-field rules live here because JSON Schema cannot express them. |
| `services/<stage>Service.ts` | `generate<Stage>(input)` | Assembles `staticContext` + `dynamicPrompt`, calls `callAI`, validates, guards, returns. |

The service builds two prompt halves:

- `staticContext` — the large, mostly-unchanging JSON (schemas, design state).
  Groq prompt-caches this; keep it stable across calls.
- `dynamicPrompt` — the per-request part. Always last.

Shared vocabularies (enum value lists) are declared **once** as `as const`
tuples in `<stage>Schema.ts` and imported by `<stage>Zod.ts`, so the contract
sent to the model and the contract enforced on the answer cannot drift.

---

## Request flow

### `POST /api/schema-design`

Input: `selected_schema`, optional `current_design`, `user_query`.

```
1. query_scope_intent   → gate + query builder. OUT_OF_SCOPE / UNCERTAIN ⇒ 422, stop.
2. jev routing          → one provider + OpenRouter model decision, pinned
                          onto steps 3 and 4.
3. schema_design        → the full target PostgreSQL schema.
4. design.status !== recommended|needs_change ⇒ 422 DesignRejectedError, stop.
5. table_management     → verify target, diff in code, then phrase the DDL.
```

### 1. The guard is intake, not a keyword filter

It answers three questions and produces no SQL, no DDL and no schema of its own:

- **scope** — `DATABASE_MIGRATION` / `OUT_OF_SCOPE` / `UNCERTAIN`. The
  cheapest call in the pipeline and it runs first, so an unrelated request never
  reaches the design or DDL stages.
- **intent** — the single primary intent, from the fixed vocabulary in
  `queryScopeIntentSchema.ts`.
- **resolved_user_query** + **operations** — the request rewritten as *one*
  unambiguous instruction, plus its discrete work breakdown.

`resolved_user_query` is the deliverable that earns the guard its keep. Every
pronoun and placeholder is resolved against the real Oracle metadata
("this table" → `EMPLOYEE`), every object is named concretely, and the user's
intent and constraints are preserved exactly — it is a clarification, never a
redesign. `operations[]` carries a verb from `QUERY_OPERATION_VERBS` and the
object it acts on.

The Zod layer enforces the pairing, and these are load-bearing:

- `OUT_OF_SCOPE` ⇒ intent `NONE`, empty `resolved_user_query`, no `operations`.
- `UNCERTAIN` ⇒ intent `UNKNOWN`, no `operations`.
- `DATABASE_MIGRATION` ⇒ a real intent, non-empty `resolved_user_query`, at
  least one operation.

A request that is in scope but unusable for planning is rejected here rather
than turned into a vague design three stages later.

### 2. Routing happens once, and is pinned

`jevRoute()` in `routes/schemadesignRoute.ts` returns one decision — provider
*and* OpenRouter model — and the route threads it down through `schema_design`
and `table_management` as `callAI(request, label, decision)`. Neither
downstream stage asks again.

That is the whole latency argument for doing it this way: a three-stage request
costs **one** routing round-trip, not one per stage.

### 5. `table_management` treats the target as a build

The PostgreSQL database starts empty, so every target table gets a
`CREATE TABLE` and keys arrive as separate
`ALTER TABLE ... ADD CONSTRAINT` statements. No `ALTER COLUMN`, `ADD COLUMN`,
`DROP COLUMN`, `RENAME` or `USING` cast is valid.

### `POST /api/data-migration`

Input: `source_schema`, `target_schema`, optional `user_query`.

Produces parallel `data_extraction[]` (Oracle SELECT) and `data_management[]`
(PostgreSQL INSERT template) arrays of **equal length**. Row values are never
emitted — the whole `VALUES` content is the literal `{VALUES_PLACEHOLDER}`
marker, resolved at runtime by the migration engine. The positional contract
matters: the INSERT column arity must match the matching projection's arity,
or rows land in the wrong columns. This is cross-checked in code.

---

## Provider chain

Three generation providers — `groq`, `gemini`, `openrouter` — all driven
through the same `AIRequest`; they differ only in transport.

- Groq: `response_format: json_schema` with `strict: true`.
- Gemini: `responseMimeType: application/json` + `responseSchema`.
- OpenRouter: OpenAI-compatible `chat/completions` + `json_schema`.

`callAI(request, taskLabel, decision?)` tries the pinned provider first and
falls back through the rest in the order held in `FALLBACK_ORDER` in
`types/types.ts`. It throws `ProviderUnavailableError` only if all of them fail.

The third argument is a `RoutingDecision`, not a bare provider name. That is
because **OpenRouter is a catalogue, not a model**: the provider says which API
to call, the model says which model on it. Both travel down together, so a call
that reaches OpenRouter *by fallback* — from Groq, from Gemini, or from the
in-code default — still generates on a model chosen for that workload rather
than on whatever was last configured.

### Jev routing

Jev is reached **through OpenRouter, on the same `OPENROUTER_API_KEY` as the
generation providers**, so routing introduces no second credential.

It is **not** reached through OpenRouter's `/chat/completions`. Jev is a
*decisions* model and that endpoint rejects it with a 400:

> `typesafe/jev-1.13 is a decisions model and cannot be used with the
> chat/completions endpoint. Use the /api/alpha/decisions endpoint instead.`

So `jevRoute()` POSTs to `https://openrouter.ai/api/alpha/decisions` with the
`state`-plus-`questions` payload, and reads a weighted choice back:

```jsonc
{
  "model": "typesafe/jev-1.13-20260917",
  "answers": {
    "provider": {
      "type": "choice",
      "choice": "gemini",
      "confidence": 0.43,
      "probabilities": { "gemini": 0.62, "groq": 0.38, "openrouter": 0 }
    },
    "openrouter_model": {
      "type": "choice",
      "choice": "google/gemini-2.5-flash-lite",
      "confidence": 0.56,
      "probabilities": { "google/gemini-2.5-flash-lite": 0.6, "meta-llama/llama-3.3-70b-instruct": 0.19, "...": 0 }
    }
  }
}
```

The state it receives is the guard's output — `resolved_user_query`,
`operations` — plus the Oracle **digest**, never the raw schema, plus two
measured load figures:

- **`input_load`** — the measured size of the `schema_design` prompt, taken by
  building that stage's own request with `buildSchemaDesignRequest` and measuring
  it, at four characters per token (the same conversion `pickDefaultProvider`
  uses, so the two never disagree about one request). This is what lets a 128k
  candidate be ruled out on a number rather than on a guess. The DDL stage is
  deliberately not measured: it runs after the design comes back and is the
  smaller of the two.
- **`output_load`** — how much has to come back, since these stages do not
  summarise.

Jev is choosing for an already-measured amount of work; shipping the document
would cost a large prompt to answer a question the digest and the two load
figures already answer.

Its answers are parsed and checked, not trusted: an unknown provider, a missing
answer or a non-finite probability is a *failed routing attempt*, not a choice.

### Two questions, one round-trip

The same call answers **which provider** and **which OpenRouter model**. A model
id is meaningless until a provider is chosen, and a provider choice is
incomplete without one, so a second round-trip would buy nothing.

The model question asks for **the cheapest catalogue entry that is still good
enough for the measured workload**, judged on three numbers from the state:
`oracle_schema` for the size of the work, `input_load` for what the prompt
costs to send, and `output_load` for what the answer has to fit in. It is told
the output ceiling so it does not pick a model that cannot finish the answer.
That matters more than it sounds: these stages do not summarise. `schema_design`
returns the entire target schema and `table_management` returns a
`CREATE TABLE` per table plus a statement per key, so a truncated answer is a
*discarded* one — it fails the stage's Zod check and costs a fallback
round-trip.

The catalogue lives in `types/types.ts` as `OPENROUTER_MODEL_CHOICES`: the option
offered, the option validated and the option documented cannot drift apart. Every
entry must advertise strict JSON-schema output, and each carries its published
$/1M rate because the cost side has to be legible to the model making the choice,
not just to a human reading the file.

A choice is accepted only if it **leads the runner-up by ≥ 0.10**. An absolute
probability bar is the wrong test for a nine-way question — spread evenly, nine
options put the leader near 0.11, so any bar above that rejects nearly every
large-workload decision and hands the request straight back to the most expensive
model on the list. `0.22 vs 0.15` is a decision; `0.13 vs 0.12` is a shrug. A
choice that fails this test does not fall back to a configured model — see
*There is no default model* below.

The model question is asked **even when the provider answer is not OpenRouter**,
because the fallback chain reaches OpenRouter from every provider. A model chosen
for this workload beats the configured default, which knows nothing about the
request.

### There is no default model

> The model is derived from the size of the work, never from a name in the
> environment.

`OPENROUTER_MODEL` is not a fallback. It is read on exactly one path — an
operator who has set `OPENROUTER_MODEL_PINNED` — because that is a decision made
on purpose. Every other OpenRouter call gets a model that was chosen against a
measured load, by one of two routes:

1. **Jev**, when the router answered and the answer was decisive. The normal
   path for `/api/schema-design`, and for every OpenRouter call reached *by
   fallback* from Groq or Gemini, because the decision travels down with the
   provider name.
2. **The catalogue, sorted in code** (`selectOpenRouterModel`), when Jev is
   unreachable or not decisive. Same objective — cheapest entry still good
   enough for the work — with capability held constant instead of judged.

Order of resolution, in `ai/jevModel.ts`:

| Source | When |
|---|---|
| `pinned` | `OPENROUTER_MODEL_PINNED=true`. The router is not consulted. |
| `jev` | The route pinned a decisive answer. |
| `jev-on-demand` | Nothing was pinned — the scope guard, `/api/data-migration`, or a request whose routing call failed. Jev is asked against the load measured on the request being sent. |
| `derived` | Jev could not be reached, or did not decide. The catalogue is sorted for this load. No network. |

A request costs **at most one** Jev call: the route always settles a model
(asked or derived) and pins it, so the provider's on-demand path only fires for
callers that never routed.

The code-side sort is tier first, then fit, then price:

- **tier** — `small` / `medium` / `large`, declared per entry and matching the
  criteria prose. Price alone would send the largest schemas to flash-lite, the
  smallest model on the list, which is the exact failure the router exists to
  prevent.
- **fit** — the window must hold prompt *and* answer, and the model must accept
  the output ceiling the provider sends. If nothing in the tier fits, the tier
  filter relaxes one step, because a bigger model that truncates is worse than a
  smaller one that does not.
- **price** — the cost of *this* request, input at the input rate and answer at
  the output rate. Input-only pricing would mis-rank these stages, which emit
  long answers.

Measured against the real catalogue, the derived path gives: guard/tiny →
`llama-3.3-70b`, 12 tables → `qwen3.8-flash`, 40 tables → `deepseek-chat-v3.1`,
80 tables → `deepseek-chat-v3.1`, 200k-token prompt → `gpt-4.1-mini` (deepseek's
window no longer fits), past every window → the widest entry plus a warning.

`routing.openrouter_model.source` and `derived_for_this_load` in the response
report which path produced the model, so a shrug and a decision are never
reported identically.

### Which models were used, not which were chosen

The decision and the work are reported separately, and they are the same only
while nothing fails. A stage that falls through the chain is served by a
different provider, so a request routed to `deepseek/deepseek-chat-v3.1` can
still have had its DDL generated by Groq.

Every provider therefore reports the model it served on — OpenRouter the routed
id, Groq and Gemini their single configured model — and the route prints and
returns one `StageModelUsage` per stage:

```
→ schema_design: provider=openrouter model=deepseek/deepseek-chat-v3.1
→ table_management: provider=openrouter model=deepseek/deepseek-chat-v3.1
→ OpenRouter models used: deepseek/deepseek-chat-v3.1
```

The same array travels to the caller as `models`, beside `routing`, which
reports the decision. The full model distribution is logged ranked at routing
time, because the winner alone does not say whether the router chose or shrugged
— and the margin test below acts on that difference.

### When there is no pinned provider

`decision?` is optional. Two callers leave it undefined:

- the **scope guard**, which runs before routing has happened and is the
  cheapest stage in the pipeline — spending a routing decision on itself would
  be backwards;
- **`/api/data-migration`**, which has no routing step.

Both take `pickDefaultProvider()`, a deterministic in-code estimate of workload
size from the shape of the prompt. It is a plain if/else ladder over the two cheap
providers — small → Groq, medium → Gemini, anything past both ceilings →
OpenRouter — making the same three-way split Jev is asked to make, so an unpinned
and a pinned call would usually agree. It decides the **provider only**, because
it has no digest and no measured load; the moment a call reaches OpenRouter the
model is chosen against that load — by Jev on demand, or by the code-side sort
if Jev cannot be reached. It is a provider default, not a model default.

### Routing failure is not request failure

A Jev timeout or error returns `routed: false`, the route pins **nothing**, and
`callAI` picks the provider. If that provider is OpenRouter, the provider
resolves its own model from the request it is about to send. A request that is
otherwise ready to run is never failed because routing was unavailable, and it is
never handed to a model named in the environment either. Routing also has a hard
10s budget.

---

## Latency

Four mechanisms, in descending order of impact.

### 1. The schema digest (`schema_verifier.buildSchemaDigest`)

The Oracle metadata used to be pretty-printed with
`JSON.stringify(value, null, 2)` and shipped whole, to every stage, to classify
one sentence. It is now reduced first to a bounded digest:

```ts
{
  table_count, column_count, primary_key_count, foreign_key_count,
  referenced_tables: string[],
  tables: [{ name, columns, primary_key, foreign_keys }],
  truncated: boolean          // table list capped at DIGEST_MAX_TABLES (40)
}
```

Measured on a 12-table / 168-column schema: **51,545 → 2,442 characters, a 95%
reduction**, ~12,300 input tokens saved on the guard alone. Column *names* are
kept in full — truncating them would stop the guard resolving a name the user
actually typed — and `truncated` is reported rather than silent.

The digest is **advisory**. Nothing may treat it as authoritative: the verifier
and the SQL guards still read the full document.

### 2. One routing call per request, not one per stage

Pinning (§ *Routing happens once*) removes two Jev round-trips from a
three-stage request.

### 3. Provider circuit breaker (`aiClient.ts`)

Per-provider, in-process: count consecutive failures, and while a provider is
over threshold stop calling it for a cooldown. One success closes it.

This one is not theoretical. With `GROQ_API_KEY` returning 401 and the Gemini
model returning 503, every call was paying for two round-trips that could not
succeed — six wasted round-trips per three-stage request. Measured effect in
testing: request latency fell from ~20s to ~10s once the circuits opened.

An authentication failure is not a blip, so it opens the circuit immediately
and for far longer (10 min) than a transient error (60s).

It is a latency mechanism, not a correctness one: it can only ever remove a
provider from consideration for a while, it can never let a bad answer through,
and if *every* circuit happens to be open the chain probes them all anyway
rather than failing the request.

### 4. Compact JSON in prompts

`staticContext` is serialised with plain `JSON.stringify`, never with
indentation. Whitespace is billed as input tokens and buys the model nothing.

This matters most in `schema_design`, which is the one stage that ships the
**full** Oracle document rather than the digest: the guard only needs to know
which objects exist, the design stage needs every column. It is also the number
`measureInputLoad` reports to Jev, so the cost of that choice is visible rather
than assumed.

### Deliberately not done

Provider **hedging** (firing the top two in parallel, keeping the first valid
answer) would cut tail latency further, at roughly double the token spend. It is
not enabled. If tail latency matters more than cost, that is the next lever.

---

## Error → HTTP mapping

`routes/routeHelpers.ts` is the single place this happens.

| Error | Status | Meaning |
|---|---|---|
| `RequestValidationError` | 400 | Caller sent something invalid, or a designed target schema failed structural verification. |
| `DesignRejectedError` | 422 | Design stage refused the request. The full design travels with the error. |
| *(guard rejections)* | 422 | `OUT_OF_SCOPE_REQUEST` / `UNCERTAIN_DATABASE_REQUEST`. |
| `ProviderOutputError` | 502 | The model produced unusable output. |
| `ProviderUnavailableError` | 503 | Every provider failed. |
| anything else | 500 | Unexpected. |

**Never throw a bare `Error` from a service.** You lose the distinction between
"the caller is wrong" and "the model is wrong", and the route collapses to 500.
`ProviderOutputError` is the correct response to a provider answer that fails
validation.

---

## Artifact layout

Defined in `src/lib/fileLayout.ts`, which also derives collision-resistant
filenames. The bare table name is not enough: three statements can target the
same table (create it, add its PK, add its FK), so the discriminator is the
specific object or action.

```
migration/
├── manifest.json
├── oracle/
│   ├── schema/source_schema.json
│   └── data/        001_select_departments.sql
└── postgres/
    ├── schema/target_schema.json
    ├── ddl/         001_create_table_departments.sql
    │                002_alter_table_add_constraint_departments_pkey.sql
    └── dml/         001_insert_departments.sql
```

---

## Code style

The formatting is unusual and deliberate. Match it exactly.

- 4-space indent. Braces on their own line for every function and block.
- **One call or declaration per line-group, callee on its own line.** No
  inline calls, ever:

  ```ts
  const response =
      await callAI(
          request,
          "Query Scope Guard"
      );
  ```

- Explicit type annotation on every `const`, even when inferable: `const x: string = ...`.
- `function (\n    arg: T\n): R {` — parameters and return type each on their own line.
- `import { X } from "..."` broken across lines, one identifier per line.
- Trailing commas on multi-line argument and array literals.
- Blank line immediately after `{` of a control-flow block that does work.
- Section banners: `/* ====...==== */`; explanations use block comments, short
  asides use `//`.
- Imports: runtime values first, then `import type` at the end, separated by a blank line.

---

## Running

```bash
npm install
npm run dev         # tsx watch
npm run typecheck   # tsc --noEmit — must be clean before you finish
npm run build
```

`config/env.ts` throws at import time if a key in `REQUIRED_KEYS` is missing, so
a misconfigured environment fails immediately rather than on first request.

| Variable | Required | Purpose |
|---|---|---|
| `GROQ_API_KEY` | yes | Groq provider |
| `GEMINI_API_KEY` | yes | Gemini provider |
| `OPENROUTER_API_KEY` | yes | OpenRouter provider **and Jev routing** |
| `JEV_MODEL` | no (default `typesafe/jev-1.13`) | Routing model |
| `GROQ_MODEL`, `GEMINI_MODEL` | no | Model ids |
| `OPENROUTER_MODEL` | no (default `openai/gpt-4.1-mini`) | The model to freeze on, **read only when `OPENROUTER_MODEL_PINNED=true`**. Never a fallback — there is no default model. |
| `OPENROUTER_MODEL_PINNED` | no (default `false`) | `true` freezes OpenRouter on `OPENROUTER_MODEL`, skips the model question, and overrides both the router and the code-side sort |
| `PORT` | no (default 3000) | Listen port |

`/health` reports the configured routing model and transport.

---

## Guarding against prompt injection

`user_query` is untrusted input. It is placed in its own labelled block in the
dynamic prompt, and every system prompt carries an explicit section instructing
the model to treat instructions inside the user query as data. Preserve that
section when editing a prompt. The scope guard's `reason` field is where the
injection-resistance is actually tested.

The guard's prompt extends the same rule to its new outputs. `resolved_user_query`
is the field an attacker would target, since it is the instruction the rest of
the request is planned against, so the prompt states that anything in the user
query — or in a column name — is an object to analyse, never an instruction to
obey, and that `resolved_user_query` is a clarification and not a redesign.

---

## Known gaps

- The scope guard runs on `/api/schema-design` only. `/api/data-migration` has
  no gate and no routing step, so it always takes the in-code default provider.
  Extending the guard needs a widened guard input, since that route supplies
  `source_schema` + `target_schema` rather than `selected_schema`.
- The guard's tightened contract (in-scope ⇒ non-empty `resolved_user_query`,
  ≥ 1 operation, intent not `UNKNOWN`) rejects answers the previous, looser
  prompt allowed. That is intended, but it makes a model-compliance failure a
  502 rather than a silently vague design.
- `resolved_user_query` is currently consumed by the routing step only. The
  design and DDL stages still receive the raw `user_query`. Feeding the
  resolved form to them is the obvious next latency and quality win, and is
  deliberately not done until it is asked for.
- There are no unit tests. The `npm test` script points at `src/**/*.test.ts`,
  which currently matches nothing.
