/*
 * The resolved environment, as config/env.ts exposes it. Listed here so the
 * shape a provider may rely on is visible in one place.
 */
export type EnvConfig = {
    groqApiKey: string;
    geminiApiKey: string;
    openrouterApiKey: string;
    groqModel: string;
    geminiModel: string;
    openrouterModel: string;
    openrouterModelPinned: boolean;
    jevModel: string;
    port: number;
};

export type AIProviderName =
    | "groq"
    | "gemini"
    | "openrouter";

/*
 * Providers in the order they are tried once the pinned provider has failed.
 * Indexed by the preferred provider so a fallback never repeats a provider
 * that has already been tried.
 */
export const FALLBACK_ORDER: Readonly<
    Record<
        AIProviderName,
        readonly AIProviderName[]
    >
> = {
    groq: [
        "gemini",
        "openrouter"
    ],

    gemini: [
        "groq",
        "openrouter"
    ],

    openrouter: [
        "gemini",
        "groq"
    ]
};

/*
 * The outcome of the single routing call a request makes.
 *
 * It is threaded down through every stage as one object rather than as a bare
 * provider name, because a decision about WHICH provider to call does not
 * determine WHICH MODEL that provider should call. Groq and Gemini each serve
 * exactly one model, but OpenRouter fronts a catalogue, so the routing step
 * also picks the model - the cheapest one that is still good enough for the
 * measured workload.
 *
 * The model fields are optional because a request that never pinned a decision
 * - the scope guard, and /api/data-migration - has no Jev answer to carry, and
 * an OpenRouter call on the fallback chain may land on a provider the pinned
 * decision never mentioned.
 */
export type RoutingDecision = {
    provider: AIProviderName;
    openrouterModel?: string;

    /*
     * How openrouterModel was arrived at, so the provider can report it instead
     * of guessing. "jev" is a model the routing model chose for this workload,
     * "derived" is the catalogue sorted in code because the router was not
     * decisive, and "pinned" is an operator override. Undefined only when
     * openrouterModel itself is.
     */
    openrouterModelSource?: ModelSource;
    openrouterModelProbability?: number;
    openrouterModelProbabilities?: Readonly<
        Record<string, number>
    >;
};

/*
 * Where an OpenRouter model came from. Carried rather than inferred because the
 * four routes to a model are not equally trustworthy: a model someone reasoned
 * about, a model picked by arithmetic, and a model an operator forced are three
 * different claims and a caller that cannot tell them apart cannot audit them.
 */
export type ModelSource =
    | "jev"
    | "jev-on-demand"
    | "derived"
    | "pinned";

/*
 * A model that has already been chosen for this request, travelling with the
 * provider name so an OpenRouter call reached by fallback still generates on a
 * model picked for the workload rather than on whatever was last configured.
 */
export type RoutedOpenRouterModel = {
    model: string;
    source: ModelSource;
};

/*
 * The output ceiling the OpenRouter provider sends with every call.
 *
 * It is declared here, beside the catalogue, because it decides which models
 * are usable at all. These stages do not summarise: schema_design returns the
 * whole target schema and table_management returns a CREATE TABLE per table
 * plus a statement per key, so the answer grows with the input and a truncated
 * answer is a discarded one - it fails the stage's Zod check and costs a
 * fallback round-trip.
 *
 * 4096 was enough for the small schemas this was written against and is not
 * enough for a real one. Past roughly 60 columns the design answer alone
 * approaches the old ceiling, which is why the ceiling is quoted to the routing
 * model in describeOutputLoad: a model that cannot finish inside the budget is
 * not a cheap model, it is a failed call.
 */
export const OPENROUTER_MAX_COMPLETION_TOKENS: number =
    16_384;

/*
 * The OpenRouter models the routing step is allowed to choose between.
 *
 * Two things constrain this list.
 *
 * 1. Every entry must advertise structured outputs. The OpenRouter provider
 *    sends response_format: json_schema with strict: true, and a model that
 *    cannot honour it answers with prose, which fails the stage's Zod check and
 *    costs a wasted round-trip. A model that cannot do this is not a candidate
 *    however cheap it is.
 *
 * 2. `cost` is the published per-million-token rate, input first. It is not
 *    decoration: the routing question is explicitly "cheapest model that is
 *    still good enough", so the cost side of every option has to be legible to
 *    the model making the choice, not just to a human reading this file.
 *
 * 3. The window and price numbers are the ones the CODE relies on, not just the
 *    ones the router reads. They were read from `GET https://openrouter.ai/api/v1/models`
 *    and are what `selectOpenRouterModel` sorts on when Jev cannot be reached, so
 *    a re-price or a retired model is now a code concern as well as a routing
 *    one. Staleness is cheap - it picks a slightly wrong model - but a retired
 *    id costs a 404 on every OpenRouter call, so re-read that endpoint when one
 *    of these names starts failing.
 *
 * The ids are OpenRouter's, and OpenRouter retires and re-prices models without
 * notice. An id that has gone away is not a crash: the choice is validated
 * against this list before it is used, and a stale entry simply stops being
 * selected. Re-pricing is likewise self-correcting, since the criteria are read
 * from the same entry that names the model.
 */
export type OpenRouterModelChoice = {
    model: string;

    /*
     * The published limits, not the marketing ones. `maxOutputTokens` is what
     * OpenRouter reports as the largest completion that model accepts, which is
     * not the same as the output ceiling this pipeline sends: a model that
     * cannot accept the whole ceiling cannot be asked for it.
     */
    contextWindow: number;
    maxOutputTokens: number;

    inputPricePerMillion: number;
    outputPricePerMillion: number;

    /*
     * The workload size this model is for, which the criteria prose below has
     * always said in words. Declared as data so the code-side fallback can hold
     * the same line the router is asked to hold: "cheapest that is still good
     * enough" needs a definition of good enough, and without one the cheapest
     * entry wins every time - which sends the largest schemas in the pipeline to
     * the smallest model on the list.
     */
    tier: ModelTier;

    criteria: string;
};

export type ModelTier =
    | "small"
    | "medium"
    | "large";

/*
 * The rate pair as the sentence the router reads.
 *
 * Built from the numbers rather than written out beside them so the price the
 * routing model reasons about and the price the code sorts on cannot be two
 * different prices.
 */
export function describeModelCost(
    choice: OpenRouterModelChoice
): string {

    return `$${choice.inputPricePerMillion.toFixed(2)} in / $${choice.outputPricePerMillion.toFixed(2)} out per 1M`;
}

export const OPENROUTER_MODEL_CHOICES: readonly OpenRouterModelChoice[] = [

    {
        model:
            "google/gemini-2.5-flash-lite",

        contextWindow:
            1_048_576,

        maxOutputTokens:
            65_535,

        inputPricePerMillion:
            0.10,

        outputPricePerMillion:
            0.40,

        tier:
            "small",

        criteria:
            "The cheapest candidate by a wide margin, with a 1M context window. A small, fast model: excellent at reading and rewriting schema text - Oracle type mapping, key translation, mechanical DDL - and the right answer for SMALL workloads whose output_load is far below the output ceiling. Do not choose it for a workload whose answer approaches that ceiling; a compact model is the first to run out of room part-way through a large document."
    },

    {
        model:
            "meta-llama/llama-3.3-70b-instruct",

        contextWindow:
            131_072,

        maxOutputTokens:
            16_384,

        inputPricePerMillion:
            0.10,

        outputPricePerMillion:
            0.32,

        tier:
            "small",

        criteria:
            "The cheapest output tokens of any candidate and effectively the same input price as flash-lite, but only a 131k context window and a small model. Take it for MEDIUM workloads that need a little more care than flash-lite and whose output_load is well clear of the output ceiling. Prefered over flash-lite when output volume is the larger half of the bill."
    },

    {
        model:
            "qwen/qwen3.8-flash",

        contextWindow:
            1_000_000,

        maxOutputTokens:
            131_072,

        inputPricePerMillion:
            0.15,

        outputPricePerMillion:
            0.47,

        tier:
            "medium",

        criteria:
            "Half the price of gpt-4o-mini with a 1M context window, and stronger on multi-step reasoning than the models below it. Take it for MEDIUM to LARGE workloads where a long schema has to be reasoned about rather than copied, and where the answer is large enough that a model able to sustain a long structured document is worth the difference."
    },

    {
        model:
            "openai/gpt-4o-mini",

        contextWindow:
            128_000,

        maxOutputTokens:
            16_384,

        inputPricePerMillion:
            0.15,

        outputPricePerMillion:
            0.60,

        tier:
            "medium",

        criteria:
            "Reliable structured output and 128k context at a low price. Take it for MEDIUM workloads where predictable JSON compliance matters more than raw capability, and the prompt fits 128k."
    },

    {
        model:
            "mistralai/mistral-small-2603",

        contextWindow:
            262_144,

        maxOutputTokens:
            209_715,

        inputPricePerMillion:
            0.15,

        outputPricePerMillion:
            0.60,

        tier:
            "medium",

        criteria:
            "Same price as gpt-4o-mini with a 262k context window. Take it when the prompt is too long for gpt-4o-mini but the work is not hard enough to justify spending more."
    },

    {
        model:
            "deepseek/deepseek-chat-v3.1",

        contextWindow:
            163_840,

        maxOutputTokens:
            32_768,

        inputPricePerMillion:
            0.25,

        outputPricePerMillion:
            0.95,

        tier:
            "large",

        criteria:
            "Noticeably stronger on schema reasoning than everything above it, for about twice the price. Take it for LARGE workloads - many tables, deep foreign-key chains, a full target schema to design - where a wrong mapping costs more downstream than the extra tokens."
    },

    {
        model:
            "google/gemini-2.5-flash",

        contextWindow:
            1_048_576,

        maxOutputTokens:
            65_535,

        inputPricePerMillion:
            0.30,

        outputPricePerMillion:
            2.50,

        tier:
            "medium",

        criteria:
            "A 1M context window and strong long-context behaviour, but by far the most expensive output of the mid-range models. Take it only when the prompt genuinely needs the window and the answer is short relative to the input."
    },

    {
        model:
            "openai/gpt-4.1-mini",

        contextWindow:
            1_047_576,

        maxOutputTokens:
            32_768,

        inputPricePerMillion:
            0.40,

        outputPricePerMillion:
            1.60,

        tier:
            "large",

        criteria:
            "A 1M context window and high structured-output reliability. Take it for LARGE workloads that are mostly about emitting an exactly-shaped, exactly-complete document rather than about reasoning, where a malformed or truncated answer would be discarded and retried."
    },

    {
        model:
            "anthropic/claude-haiku-4.5",

        contextWindow:
            200_000,

        maxOutputTokens:
            64_000,

        inputPricePerMillion:
            1.00,

        outputPricePerMillion:
            5.00,

        tier:
            "large",

        criteria:
            "Roughly twenty-five times the price of the cheapest candidate and the strongest of the set. Take it only for the hardest LARGE workloads, where a large schema has to be redesigned correctly in one pass and a second attempt would cost more than the model."
    }
];

/*
 * The allowlist as a set, for validating a name that came back from the routing
 * model. A model that is not in this list was never offered, so a name that is
 * not in it is rejected rather than sent to OpenRouter.
 */
export const OPENROUTER_MODEL_IDS: ReadonlySet<string> =
    new Set<string>(
        OPENROUTER_MODEL_CHOICES.map(
            (
                choice: OpenRouterModelChoice
            ): string => choice.model
        )
    );

export type SourceDatabase = "oracle";

export type TargetDatabase = "postgresql";

export type AIRequest = {
    systemPrompt: string;
    staticContext?: string;
    dynamicPrompt: string;
    responseSchema: Record<string, unknown>;
    responseSchemaName: string;
};

export type AIResponse = {
    provider: AIProviderName;

    /*
     * The model that actually produced the answer, when the provider has more
     * than one to choose from. Groq and Gemini serve a single configured model
     * each and leave this undefined; OpenRouter fills it in, so a response can
     * be traced to the model the routing step chose for it.
     */
    model?: string;
    result: unknown;
};

/*
 * What one stage actually generated on.
 *
 * Recorded per stage rather than once per request, because the answer is not
 * necessarily the same for every stage. The routing decision is pinned, so in
 * the normal case all stages agree - but a stage that fails falls through the
 * chain, and a call that lands on OpenRouter by fallback generates on the
 * routed model while one that lands on Groq generates on Groq's single
 * configured model. A single "model" for the whole pipeline would report the
 * decision rather than the work, and the two are only the same when nothing
 * failed.
 *
 * `model` is null when the provider answered but could not name a model, which
 * is a different thing from a provider that serves no model at all.
 */
export type StageModelUsage = {
    stage: string;
    provider: AIProviderName;
    model: string | null;
};

export type ColumnMetadata = {
    columnName: string;
    dataType: string;
    dataLength: number;
    dataPrecision: number;
    dataScale: number;
    nullable: "Y" | "N";
    dataDefault: string;
    columnId: number;
};

export type PrimaryKeyMetadata = {
    constraintName: string;
    columns: string[];
};

export type ForeignKeyMetadata = {
    constraintName: string;
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
};

export type TableMetadata = {
    tableName: string;
    columns: ColumnMetadata[];
    primaryKey: PrimaryKeyMetadata;
    foreignKeys: ForeignKeyMetadata[];
};

export type SchemaMetadata = {
    tables: TableMetadata[];
};

export type SchemaDesignInput = {
    selected_schema: unknown;
    current_design?: unknown;
    user_query: string;
};
