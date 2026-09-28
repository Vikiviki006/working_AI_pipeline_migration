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

- `src/lib/schema_verifier.ts` — parses metadata, verifies structural
  soundness, computes the authoritative source→target diff, plans the build.
- `src/lib/sql_guards.ts` — pure SQL text analysis. Proves a statement is
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
├── types/types.ts           Shared request/response types, fallback order
├── routes/
│   ├── schemadesign_route.ts      POST /api/schema-design + jevRoute()
│   ├── data_migration_route.ts    POST /api/data-migration
│   └── route_helpers.ts           error → HTTP status mapping
├── ai/
│   ├── ai_client.ts          provider chain, in-code default, circuit breaker
│   ├── providers/            groq_provider.ts, gemini_provider.ts,
│   │                         openrouter_provider.ts
│   ├── prompts/              one system prompt per stage
│   ├── schemas/              provider JSON Schema + response Zod validators
│   └── services/             one orchestrator per stage
└── lib/
    ├── sql_guards.ts         pure SQL text guards
    ├── schema_verifier.ts    metadata verification, digesting, diffing, planning
    ├── file_layout.ts        canonical bundle paths, filename derivation
    └── errors.ts             typed failures that map to status codes
```

There is no `jev_router.ts`. Jev routing is a function in
`routes/schemadesign_route.ts`, because it is one step of that route, not a
route of its own. It has no endpoint and never had one.

---

## The four-file convention for a stage

Every AI stage is exactly four files. Do not merge them, do not add a fifth.

| File | Exports | Rule |
|---|---|---|
| `prompts/<stage>_prompt.ts` | `<STAGE>_SYSTEM_PROMPT: string` | The model's instructions. Domain rules, sentinels, output format. |
| `schemas/<stage>_schema.ts` | `<stage>JsonSchema: Record<string, unknown>` | **Plain JSON Schema**, not Zod. Sent to Groq as `json_schema.schema` and Gemini as `config.responseSchema`. Needs `additionalProperties: false` and every property in `required`, or Groq's `strict` mode rejects it. |
| `schemas/<stage>_zod.ts` | `<stage>Response` (Zod) | Validates what came *back*. Cross-field rules live here because JSON Schema cannot express them. |
| `services/<stage>_service.ts` | `generate<Stage>(input)` | Assembles `staticContext` + `dynamicPrompt`, calls `callAI`, validates, guards, returns. |

The service builds two prompt halves:

- `staticContext` — the large, mostly-unchanging JSON (schemas, design state).
  Groq prompt-caches this; keep it stable across calls.
- `dynamicPrompt` — the per-request part. Always last.

Shared vocabularies (enum value lists) are declared **once** as `as const`
tuples in `<stage>_schema.ts` and imported by `<stage>_zod.ts`, so the contract
sent to the model and the contract enforced on the answer cannot drift.

---

## Request flow

### `POST /api/schema-design`

Input: `selected_schema`, optional `current_design`, `user_query`.

```
1. query_scope_intent   → gate + query builder. OUT_OF_SCOPE / UNCERTAIN ⇒ 422, stop.
2. jev routing          → one provider decision, pinned onto steps 3 and 4.
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
  `query_scope_intent_schema.ts`.
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

`jevRoute()` in `routes/schemadesign_route.ts` returns one provider, and the
route threads it down through `schema_design` and `table_management` as
`callAI(request, label, provider)`. Neither downstream stage asks again.

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

`callAI(request, taskLabel, provider?)` tries the pinned provider first and
falls back through the rest in the order held in `FALLBACK_ORDER` in
`types/types.ts`. It throws `ProviderUnavailableError` only if all of them fail.

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
    }
  }
}
```

The state it receives is the guard's output — `resolved_user_query`,
`operations` — plus the Oracle **digest**, never the raw schema. Jev is choosing
a provider for an already-measured amount of work; shipping the document would
cost a large prompt to answer a question four numbers already answer.

Its answer is parsed and checked, not trusted: an unknown provider, a missing
answer or a non-finite probability is a *failed routing attempt*, not a choice.

### When there is no pinned provider

`provider?` is optional. Two callers leave it undefined:

- the **scope guard**, which runs before routing has happened and is the
  cheapest stage in the pipeline — spending a routing decision on itself would
  be backwards;
- **`/api/data-migration`**, which has no routing step.

Both take `pickDefaultProvider()`, a deterministic in-code estimate of workload
size from the shape of the prompt. It makes the same three-way split Jev is
asked to make, so an unpinned and a pinned call would usually agree. It is a
default, not a router. When the answer actually matters, ask Jev.

### Routing failure is not request failure

A Jev timeout or error returns `routed: false`, the route pins **nothing**, and
`callAI` picks. A request that is otherwise ready to run is never failed
because routing was unavailable. Routing also has a hard 10s budget.

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

### 3. Provider circuit breaker (`ai_client.ts`)

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

### Deliberately not done

Provider **hedging** (firing the top two in parallel, keeping the first valid
answer) would cut tail latency further, at roughly double the token spend. It is
not enabled. If tail latency matters more than cost, that is the next lever.

---

## Error → HTTP mapping

`routes/route_helpers.ts` is the single place this happens.

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

Defined in `src/lib/file_layout.ts`, which also derives collision-resistant
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
| `GROQ_MODEL`, `GEMINI_MODEL`, `OPENROUTER_MODEL` | no | Model ids |
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
