import {
    Router,
    type Request,
    type Response
} from "express";

import {
    env
} from "../config/env.js";

import {
    runSchemaMigration
} from "../ai/services/schemaMigrationService.js";

import {
    buildSchemaDesignRequest
} from "../ai/services/schemaDesignService.js";

import {
    OPENROUTER_MAX_COMPLETION_TOKENS
} from "../types/types.js";

import {
    JEV_ENDPOINT,
    JEV_MODEL_QUESTION_NAME,
    JEV_TIMEOUT_MS,
    buildModelQuestion,
    describeDistribution,
    evaluateChoice,
    readChoice,
    selectOpenRouterModel
} from "../ai/jevModel.js";

import {
    checkQueryScopeIntent
} from "../ai/services/queryScopeIntentService.js";

import {
    SchemaDesignRequest
} from "../ai/schemas/schemadesignRequestZod.js";

import {
    respondWithError
} from "./routeHelpers.js";

import {
    MANIFEST_PATH,
    ORACLE_SCHEMA_DIR,
    POSTGRES_DDL_DIR,
    POSTGRES_SCHEMA_DIR,
    ROOT
} from "../lib/fileLayout.js";

import type {
    AIProviderName,
    AIRequest,
    ModelSource,
    RoutingDecision,
    SchemaDesignInput,
    StageModelUsage
} from "../types/types.js";

import type {
    ChoiceAnswer,
    ModelDecision,
    ModelLoad
} from "../ai/jevModel.js";

import type {
    SchemaDigest
} from "../lib/schemaVerifier.js";

import type {
    QueryScopeIntent
} from "../ai/schemas/queryScopeIntentZod.js";


/* ============================================================
 * Jev routing
 * ==========================================================
 *
 * Jev is the one model in the pipeline whose output is a decision rather than an
 * artifact, so it carries no SQL guard. It is a preference, not a permission:
 * whichever provider it names, the guards, the verifier and the build-plan
 * cross-check apply unchanged.
 *
 * It is called ONCE per request, not once per stage. The decision is threaded
 * down through the design and DDL stages as a pinned provider, which is what
 * keeps a three-stage request to a single routing round-trip.
 *
 * That same call answers two questions, not one. "Which provider" and "which
 * model" belong together: a model id is meaningless until a provider is chosen,
 * and a provider choice is incomplete without one, because OpenRouter fronts a
 * catalogue rather than a single model. Asking both at once is what keeps the
 * model question free - a second round-trip would cost a full Jev call and
 * another 10s of worst-case latency for a decision the first call could have
 * carried.
 */

export type JevRoutingResult = RoutingDecision & {
    provider: AIProviderName;
    confidence: number;
    probabilities: {
        groq: number;
        gemini: number;
        openrouter: number;
    };
    workload: string;
    model: string;

    /*
     * How `model` was arrived at. "jev" is a model the router chose for this
     * measured workload, "derived" is the catalogue sorted in code because it
     * did not, and "pinned" is an operator override. Reported rather than
     * inferred, because a shrug and a decision produce the same shape of answer
     * and only the source tells them apart.
     */
    modelSource: ModelSource;

    modelConfidence: number;
    modelProbabilities: Readonly<Record<string, number>>;
    modelPinned: boolean;
    routed: boolean;
};

/*
 * How large the generation stages' input actually is, measured rather than
 * guessed.
 *
 * The digest answers how big the SCHEMA is. It does not answer how many tokens
 * the prompt carrying it will cost, which is a different number: the design
 * stage ships the full Oracle document, not the digest, plus a system prompt
 * and the user's query. Those are the tokens actually billed, and they are also
 * what decides whether a candidate with a 128k window is even usable.
 */
export type JevInputLoad = {
    systemPromptCharacters: number;
    staticContextCharacters: number;
    dynamicPromptCharacters: number;
    totalCharacters: number;
    estimatedInputTokens: number;
};

/*
 * Transport, the timeout, the model question and the acceptance test all live in
 * ai/jevModel.ts, because the OpenRouter provider needs the same three of them
 * to be able to choose a model for itself when this route pinned nothing. Only
 * the two-question call is here: that is this route's work, not the provider's.
 */
const JEV_QUESTION_NAME: string =
    "provider";

const PROVIDER_NAMES: readonly AIProviderName[] = [
    "groq",
    "gemini",
    "openrouter"
];

/*
 * A routing model asked to spend money is making a trade-off it can be wrong
 * about, so its answer is not taken at face value. What is checked is not the
 * winner's absolute probability but how far it sits above the runner-up, and
 * the test itself lives in ai/jevModel.ts with the rest of the model question -
 * see OPENROUTER_MODEL_MIN_MARGIN there.
 *
 * A rejected model answer does NOT hand the request to a configured model. The
 * catalogue is sorted in code against the same measured load, which is the same
 * decision - cheapest entry that is still good enough - minus the part that
 * needed someone to judge quality. That is the only way a model is ever named
 * without something having been measured.
 */

/**
 * Asks Jev which provider should serve the rest of this request, and which
 * OpenRouter model that provider should call.
 *
 * The state it is given is the guard's output - the resolved user query and the
 * operation breakdown - plus the Oracle metadata digest, never the raw schema.
 * That is deliberate: Jev is choosing a provider for an already-measured amount
 * of work, and shipping the document would cost a large prompt to answer a
 * question four numbers already answer.
 *
 * The document is not shipped, but its SIZE is: inputLoad carries the measured
 * cost of the prompt the design stage is about to send, so the model question
 * can weigh a 128k window against a 1M one on a real number rather than on the
 * table count it can see in the digest.
 *
 * The model question is asked even when the provider answer is not OpenRouter,
 * and even when it might be. The fallback chain reaches OpenRouter from every
 * provider, so a request that was routed to Groq can still end up generating on
 * OpenRouter if Groq is down - and when it does, a model chosen for this
 * workload beats the configured default, which knows nothing about the request.
 *
 * Routing is best-effort by design. A Jev failure degrades to the in-code
 * default inside callAI rather than failing a request that is otherwise ready
 * to run, so nothing here throws to the route.
 */
export async function jevRoute(
    intent: QueryScopeIntent,
    digest: SchemaDigest,
    inputLoad: JevInputLoad
): Promise<JevRoutingResult> {

    const workload: string =
        describeWorkload(
            digest,
            inputLoad
        );

    const body = {
        model:
            env.jevModel,

        state: {
            task:
                "oracle_to_postgresql_migration",

            primary_intent:
                intent.intent,

            resolved_user_query:
                intent.resolved_user_query,

            operations:
                intent.operations,

            oracle_schema:
                digest,

            /*
             * What the prompt will cost to send, measured from the design stage's
             * own assembled request rather than inferred from the digest.
             */
            input_load:
                describeInputLoad(
                    inputLoad
                ),

            /*
             * The model question is a price/capability trade-off, and a
             * capability the digest alone does not express is how much has to
             * come BACK. Every stage returns a document sized by the schema, so
             * this is the half of the workload that decides whether the cheap
             * end of the catalogue can finish at all.
             */
            output_load:
                describeOutputLoad(digest),

            stages: [
                "schema_design",
                "table_management"
            ]
        },

        questions: {
            [JEV_QUESTION_NAME]: {
                type:
                    "choice",

                instructions:
                    "Which AI generation provider should handle this Oracle-to-PostgreSQL migration request? Judge the measured workload, not the topic.",

                criteria: {
                    groq:
                        "Use Groq for SMALL workloads. Short or straightforward requests with a small context and low schema complexity.",

                    gemini:
                        "Use Gemini for MEDIUM workloads. Moderate context or schema complexity, and needing more semantic transformation than a mechanical rewrite.",

                    openrouter:
                        "Use OpenRouter for LARGE workloads. Very large context, many tables or relationships, or high schema complexity."
                }
            },

            /*
             * Omitted entirely when the operator has pinned a model, so a
             * deliberate pin costs no tokens and cannot be talked out of by the
             * router.
             */
            ...(
                env.openrouterModelPinned
                    ? {}
                    : {
                        [JEV_MODEL_QUESTION_NAME]: buildModelQuestion()
                    }
            )
        }
    };

    try {

        const response =
            await fetch(
                JEV_ENDPOINT,
                {
                    method:
                        "POST",

                    headers: {
                        Authorization:
                            `Bearer ${env.openrouterApiKey}`,

                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify(body),

                    signal:
                        AbortSignal.timeout(
                            JEV_TIMEOUT_MS
                        )
                }
            );

        const text: string =
            await response.text();

        if (!response.ok) {
            throw new Error(
                `Jev returned HTTP ${response.status}: ${text.substring(0, 300)}`
            );
        }

        const decision =
            readDecision(text);

        /*
         * The same load the model question was answered against, in the shape
         * the code-side fallback needs. Built here rather than left to the
         * provider so a rejected answer is settled in this round-trip: the
         * stages are pinned a model either way, and pinning "we don't know"
         * would only move the same question to a second call.
         */
        const modelLoad: ModelLoad =
            {
                stage:
                    "schema_design",

                inputTokens:
                    inputLoad.estimatedInputTokens,

                expectedOutputTokens:
                    estimateOutputTokens(
                        digest
                    ),

                outputCeiling:
                    OPENROUTER_MAX_COMPLETION_TOKENS
            };

        const model =
            readModelDecision(
                decision.answers,
                modelLoad
            );

        console.log(
            `→ Jev: provider=${decision.provider}` +
                ` confidence=${decision.confidence.toFixed(3)}` +
                ` workload="${workload}"` +
                ` probabilities=${JSON.stringify(decision.probabilities)}`
        );

        console.log(
            `→ Jev: openrouter model=${model.model}` +
                (
                    model.routed
                        ? ` p=${model.probability.toFixed(3)}`
                        : ` source=${model.source}`
                ) +
                ` pinned=${env.openrouterModelPinned}`
        );

        /*
         * The full distribution, ranked.
         *
         * Printed because the winner alone does not say whether the router chose
         * or shrugged - a 0.22 winner is a decision and a 0.13 one is a coin
         * toss, and that difference is exactly what the margin test acts on. It
         * is also the only record of what the cheaper alternatives were worth on
         * this particular request.
         */
        console.log(
            `→ Jev: openrouter model distribution: ` +
                describeDistribution(
                    model.probabilities
                )
        );

        return {
            provider:
                decision.provider,

            confidence:
                decision.confidence,

            probabilities:
                decision.probabilities,

            /*
             * Always set, and always with a source. "routed: the router chose
             * this" and "derived: the catalogue was sorted for this load" are
             * different claims and the difference is what makes a Jev shrug
             * visible instead of silent.
             */
            openrouterModel:
                model.model,

            openrouterModelSource:
                model.source,

            openrouterModelProbability:
                model.routed
                    ? model.probability
                    : undefined,

            openrouterModelProbabilities:
                model.probabilities,

            workload,

            model:
                model.model,

            modelSource:
                model.source,

            modelConfidence:
                model.confidence,

            modelProbabilities:
                model.probabilities,

            modelPinned:
                env.openrouterModelPinned,

            routed:
                true
        };

    } catch (
        error: unknown
    ) {

        /*
         * Not a ProviderUnavailableError. The generation work has not started
         * and may well succeed; only the preference is missing, and callAI
         * already knows how to choose one on its own.
         */
        console.error(
            "→ Jev routing failed, the in-code provider default applies:",
            error
        );

        return {
            /*
             * routed: false is the signal, not the provider field. It tells the
             * route to pin nothing, so callAI chooses the provider rather than
             * this function guessing on its behalf.
             *
             * The model reported here is what the OpenRouter provider would
             * derive from this same load if a stage lands on it, so the response
             * describes a request that is already in flight rather than naming a
             * configured model that nothing chose.
             */
            provider:
                "groq",

            confidence:
                0,

            probabilities: {
                groq: 0,
                gemini: 0,
                openrouter: 0
            },

            workload,

            model:
                selectOpenRouterModel(
                    {
                        stage:
                            "schema_design",

                        inputTokens:
                            inputLoad.estimatedInputTokens,

                        expectedOutputTokens:
                            estimateOutputTokens(
                                digest
                            ),

                        outputCeiling:
                            OPENROUTER_MAX_COMPLETION_TOKENS
                    }
                ),

            modelSource:
                "derived",

            modelConfidence:
                0,

            modelProbabilities:
                {},

            modelPinned:
                env.openrouterModelPinned,

            routed:
                false
        };
    }
}


/*
 * The model question itself, and the acceptance test that judges its answer, are
 * in ai/jevModel.ts. They are not here because this route did not need to keep
 * them to itself: the OpenRouter provider has to be able to ask the same
 * question when nothing was pinned, and two copies of a nine-option question
 * with two different sets of limits would drift.
 */


/*
 * The measured workload, in code, so the routing record shows the numbers the
 * decision was made against rather than a model's account of them.
 *
 * The input figure is here for the same reason as the schema counts: they are
 * the two things that decide whether a window is big enough, and a request that
 * lands on a 128k model has to be able to see how close it came.
 */
function describeWorkload(
    digest: SchemaDigest,
    inputLoad: JevInputLoad
): string {

    return [
        `${digest.table_count} table(s)`,
        `${digest.column_count} column(s)`,
        `${digest.primary_key_count} primary key(s)`,
        `${digest.foreign_key_count} foreign key(s)`,
        `~${inputLoad.estimatedInputTokens} input token(s)`,
        digest.truncated
            ? "digest truncated"
            : "full digest"
    ].join(
        ", "
    );
}


/*
 * How much the generation stages have to READ, so the model question is not
 * asked to guess it.
 *
 * Measured from the design stage's own assembled request, so the number is the
 * size of the prompt that is actually about to be sent rather than an
 * approximation inferred from a digest that only describes part of it. Four
 * characters per token is the same estimate callAI makes, kept identical so the
 * two never disagree about the same request.
 *
 * The DDL stage is deliberately not measured. It runs after the design comes
 * back, so its input cannot be known yet, and it is the smaller of the two:
 * the Oracle document, the design and the plan are the same objects the design
 * stage already carried.
 */
function describeInputLoad(
    inputLoad: JevInputLoad
): string {

    return [
        `the schema_design prompt is the largest input on this request: about ${inputLoad.estimatedInputTokens} input tokens, ${inputLoad.totalCharacters} characters in total`,
        `of which about ${inputLoad.staticContextCharacters} characters are the Oracle metadata and the current design, ${inputLoad.systemPromptCharacters} are its instructions, and ${inputLoad.dynamicPromptCharacters} are the user query`,
        `a candidate whose context window is below that input figure cannot serve this request at all, whatever its price`
    ].join(
        ". "
    ) + ".";
}


/*
 * Measures the design stage's input load by building the prompt that stage is
 * about to send and measuring it.
 *
 * Building the request costs a JSON serialisation of the Oracle document, which
 * is nothing next to a generation call, and it is the only way this number
 * cannot drift from the prompt: the same function produces both.
 */
export function measureInputLoad(
    input: SchemaDesignInput
): JevInputLoad {

    const request: AIRequest =
        buildSchemaDesignRequest(
            input
        );

    const systemPromptCharacters: number =
        request.systemPrompt.length;

    const staticContextCharacters: number =
        request.staticContext?.length ?? 0;

    const dynamicPromptCharacters: number =
        request.dynamicPrompt.length;

    const totalCharacters: number =
        systemPromptCharacters +
        staticContextCharacters +
        dynamicPromptCharacters;

    return {
        systemPromptCharacters,
        staticContextCharacters,
        dynamicPromptCharacters,
        totalCharacters,

        /*
         * Four characters per token, the same conversion ai_client uses for its
         * in-code provider default. Consistency matters more than precision
         * here: two estimates of one request that disagree by a factor would be
         * worse than either being slightly wrong.
         */
        estimatedInputTokens:
            Math.ceil(
                totalCharacters / 4
            )
    };
}


/* ============================================================
 * Model trace
 * ==========================================================
 *
 * The routing decision is only a decision. What a request was actually answered
 * by is whatever the providers returned, and those are the same only while
 * nothing failed - a stage that falls through the chain is served by a different
 * provider, and on OpenRouter by a different model than the one that failed.
 *
 * So the trace is printed from the answers, and the OpenRouter models that
 * served the request are called out on their own line: that is the number the
 * whole routing design exists to spend, and it is otherwise buried in three
 * per-stage log lines.
 */

function logModelsUsed(
    usage: readonly StageModelUsage[]
): void {

    for (
        const entry
        of usage
    ) {

        console.log(
            `→ ${entry.stage}: ` +
                `provider=${entry.provider} ` +
                `model=${
                    entry.model ??
                    "not reported by the provider"
                }`
        );
    }

    /*
     * A set, because a request that stayed on one decision generates on one
     * model twice and saying so twice reads like two choices were made.
     */
    const openRouterModels: Set<string> =
        new Set<string>();

    for (
        const entry
        of usage
    ) {

        if (
            entry.provider === "openrouter" &&
            entry.model !== null
        ) {

            openRouterModels.add(
                entry.model
            );
        }
    }

    if (
        openRouterModels.size === 0
    ) {

        console.log(
            "→ OpenRouter models used: none, this request stayed on the cheap providers"
        );

        return;
    }

    console.log(
        "→ OpenRouter models used: " +
            [
                ...openRouterModels
            ].join(
                ", "
            )
    );
}


/*
 * How much each stage has to return, so the model question is not asked to
 * guess it.
 *
 * The stages do not summarise. schema_design returns the entire target schema
 * and table_management returns one CREATE TABLE per table plus one statement
 * per key, so the answer grows with the input and an answer that is cut off is
 * not a smaller answer, it is a discarded one - the stage fails validation and
 * the chain pays for a fallback.
 *
 * The estimate is deliberately the same shape the verifier already uses: about
 * five columns per table, a constraint statement for every primary and foreign
 * key, and roughly four characters per token of emitted JSON. It is an estimate
 * for a model to reason against, not a number anything is checked against - and
 * the same number the code-side fallback is sorted on, so a rejected answer
 * degrades to a model chosen against the identical figure rather than a second,
 * looser guess.
 */
function describeOutputLoad(
    digest: SchemaDigest
): string {

    const tableCount: number =
        digest.table_count;

    const constraintCount: number =
        digest.primary_key_count +
        digest.foreign_key_count;

    return [
        `schema_design returns the full target schema as JSON: about ${tableCount} table definition(s) and ${digest.column_count} column(s)`,
        `table_management returns about ${tableCount} CREATE TABLE statement(s) plus ${constraintCount} key constraint statement(s)`,
        `estimated answer size: ~${estimateOutputTokens(digest)} output tokens`,
        `the generation call is capped at ${OPENROUTER_MAX_COMPLETION_TOKENS} output tokens, so a workload above roughly ${OPENROUTER_MAX_COMPLETION_TOKENS} tokens of answer cannot be completed in one call on any model`
    ].join(
        ". "
    ) + ".";
}


/*
 * The answer size, counted rather than guessed at.
 *
 * Separate from describeOutputLoad so the sentence Jev reads and the number the
 * catalogue is sorted on are the same value, produced once. Roughly 420
 * characters per table definition, 60 per key constraint, a fixed 400 for the
 * surrounding JSON, and four characters per token.
 */
export function estimateOutputTokens(
    digest: SchemaDigest
): number {

    return Math.ceil(
        (
            digest.table_count * 420 +
            (
                digest.primary_key_count +
                digest.foreign_key_count
            ) * 60 +
            400
        ) / 4
    );
}


/*
 * A single choice answer, as it comes back from the decisions endpoint, is
 * ChoiceAnswer from ai/jevModel.ts - the same shape the provider question is
 * read into, because it is the same endpoint and the same answer.
 */


/*
 * Jev's answer is a preference, but it still came back from a model, so it is
 * parsed and checked rather than trusted: an unrecognised provider, a missing
 * answer or a non-finite probability is treated as a failed routing attempt
 * rather than as a provider choice.
 */
function readDecision(
    content: string
): {
    provider: AIProviderName;
    confidence: number;
    probabilities: {
        groq: number;
        gemini: number;
        openrouter: number;
    };
    routingModel: string;
    answers: Record<string, unknown>;
} {

    const parsed: unknown =
        JSON.parse(content);

    const record: Record<string, unknown> =
        toRecord(
            parsed,
            "Jev response was not an object"
        );

    const rawAnswers: unknown =
        record.answers;

    if (
        rawAnswers === null ||
        typeof rawAnswers !== "object"
    ) {
        throw new Error(
            "Jev returned no answers"
        );
    }

    const answers: Record<string, unknown> =
        rawAnswers as Record<
            string,
            unknown
        >;

    const answer =
        readChoice(
            answers,
            JEV_QUESTION_NAME
        );

    const choice: string =
        answer.choice;

    if (
        !PROVIDER_NAMES.includes(
            choice as AIProviderName
        )
    ) {
        throw new Error(
            `Jev named an unknown provider: ${choice}`
        );
    }

    const probability = (
        name: AIProviderName
    ): number => {

        const value: number =
            answer.probabilities[name] ?? 0;

        return value;
    };

    const model: unknown =
        record.model;

    return {
        provider:
            choice as AIProviderName,

        confidence:
            answer.confidence,

        probabilities: {
            groq: probability("groq"),
            gemini: probability("gemini"),
            openrouter:
                probability("openrouter")
        },

        routingModel:
            typeof model === "string" &&
            model.length > 0
                ? model
                : env.jevModel,

        answers
    };
}


/*
 * Reads the model question out of the same response, and always comes back with
 * a model.
 *
 * This one is allowed to fail quietly, and the difference is deliberate. A
 * missing provider answer means the request has no routing at all, which callAI
 * handles by choosing in code. A missing or unusable MODEL answer only means the
 * model was not chosen by the router - the provider decision that was already
 * made is still perfectly good, and throwing it away over a model id would turn
 * a free degradation into a failed routing attempt.
 *
 * When the router does not decide, the catalogue is sorted for this exact load
 * and the cheapest entry that can hold the prompt and finish the answer is
 * taken. That is the same objective the router was given, with capability held
 * constant, and it is emphatically not a configured default: an operator can
 * freeze a model on purpose with OPENROUTER_MODEL_PINNED, and that is the only
 * way a name from the environment reaches a call.
 */
function readModelDecision(
    answers: Record<string, unknown>,
    load: ModelLoad
): ModelDecision {

    /*
     * Pinned by the operator: the question was not asked, so there is nothing to
     * read and nothing to validate.
     */
    if (
        env.openrouterModelPinned
    ) {

        console.log(
            "→ Jev: OPENROUTER_MODEL_PINNED is set, the model question was not asked and the pinned model overrides the router"
        );

        return {
            model:
                env.openrouterModel,

            source:
                "pinned",

            probability:
                0,

            confidence:
                0,

            probabilities:
                {},

            routed:
                false
        };
    }

    let answer: ChoiceAnswer;

    try {

        answer =
            readChoice(
                answers,
                JEV_MODEL_QUESTION_NAME
            );

    } catch (
        error: unknown
    ) {

        return derive(
            load,
            "the router returned no model answer",
            error
        );
    }

    const verdict =
        evaluateChoice(
            answer
        );

    if (
        !verdict.accepted
    ) {

        return derive(
            load,
            verdict.reason
        );
    }

    return {
        model:
            answer.choice,

        source:
            "jev",

        probability:
            verdict.probability,

        confidence:
            answer.confidence,

        probabilities:
            answer.probabilities,

        routed:
            true
    };
}


/*
 * The degraded path, in one place: no model from the router, so the catalogue is
 * sorted for this load. The reason is logged rather than swallowed, because
 * "the router shrugged and we picked the cheapest that fits" is a materially
 * different event from "the router chose this", and only one of them is a
 * decision anybody made.
 */
function derive(
    load: ModelLoad,
    reason: string,
    error?: unknown
): ModelDecision {

    const model: string =
        selectOpenRouterModel(
            load
        );

    console.warn(
        `→ Jev: ${reason}, so the catalogue was sorted for this ${load.stage} request instead: ${model}`,
        error
    );

    return {
        model,

        source:
            "derived",

        probability:
            0,

        confidence:
            0,

        probabilities:
            {},

        routed:
            false
    };
}

/*
 * readChoice, the margin test and the probability reader all live in
 * ai/jevModel.ts, shared with the provider's own model question. The provider
 * question has to survive a missing answer and the model question must not, and
 * that difference is decided at the call site rather than inside the parser -
 * which is why readChoice throws instead of returning a partial.
 */

function toRecord(
    value: unknown,
    message: string
): Record<string, unknown> {

    if (
        value === null ||
        typeof value !== "object"
    ) {
        throw new Error(
            message
        );
    }

    return value as Record<
        string,
        unknown
    >;
}


/* ============================================================
 * Route
 * ========================================================== */

export const schemaDesignRouter =
    Router();


schemaDesignRouter.post(
    "/schema-design",

    async (
        req: Request,
        res: Response
    ): Promise<void> => {

        /*
         * -----------------------------------------
         * 1. Validate request structure
         * -----------------------------------------
         */

        const parsed =
            SchemaDesignRequest.safeParse(
                req.body
            );

        if (!parsed.success) {

            res.status(400).json({

                error:
                    "Invalid request body",

                details:
                    parsed.error.format()
            });

            return;
        }


        try {

            /*
             * -----------------------------------------
             * 2. Query Scope + Intent Guard
             *
             * Classifies the request, resolves it into one
             * concrete instruction, and returns the Oracle
             * digest the routing step needs. OUT_OF_SCOPE
             * and UNCERTAIN stop here.
             * -----------------------------------------
             */

            const scopeCheck =
                await checkQueryScopeIntent(
                    {
                        selected_schema:
                            parsed.data.selected_schema,

                        current_design:
                            parsed.data.current_design,

                        user_query:
                            parsed.data.user_query
                    }
                );

            const scope: string =
                scopeCheck.result.scope;

            const intent: string =
                scopeCheck.result.intent;

            const reason: string =
                scopeCheck.result.reason;


            if (
                scope ===
                    "OUT_OF_SCOPE"
            ) {

                res.status(422).json({

                    success: false,

                    error:
                        "OUT_OF_SCOPE_REQUEST",

                    message:
                        "Only Oracle-to-PostgreSQL database migration and schema transformation requests are supported.",

                    scope,
                    intent,
                    reason
                });

                return;
            }


            if (
                scope ===
                    "UNCERTAIN"
            ) {

                res.status(422).json({

                    success: false,

                    error:
                        "UNCERTAIN_DATABASE_REQUEST",

                    message:
                        "The request may be related to database migration, but the intended database operation could not be determined.",

                    scope,
                    intent,
                    reason
                });

                return;
            }


            /*
             * -----------------------------------------
             * 3. Jev routing
             *
             * One decision for the rest of the request,
             * taken against the resolved query, the Oracle
             * digest and the measured prompt size. The
             * answer is pinned onto both downstream stages,
             * so neither spends another round-trip asking.
             * -----------------------------------------
             */

            /*
             * Measured from the design stage's own prompt, so the model question
             * is answered against the input that will really be sent rather than
             * against a figure derived from the digest.
             */
            const inputLoad: JevInputLoad =
                measureInputLoad(
                    parsed.data
                );

            const routing =
                await jevRoute(
                    scopeCheck.result,
                    scopeCheck.digest,
                    inputLoad
                );

            /*
             * undefined rather than a guess: when Jev did not answer at all,
             * callAI picks from the workload itself, and the OpenRouter provider
             * resolves its own model from the request it is about to send.
             *
             * The whole decision is pinned, not just the provider. Which provider
             * to call does not determine which model that provider calls, and
             * OpenRouter fronts a catalogue rather than a single model, so the
             * chosen model travels down alongside the name - with the source that
             * explains how it was chosen, because "the router picked this" and
             * "the catalogue was sorted for this load" are not the same claim.
             */
            const pinnedDecision:
                RoutingDecision | undefined =
                routing.routed
                    ? {
                        provider:
                            routing.provider,

                        openrouterModel:
                            routing.openrouterModel,

                        openrouterModelSource:
                            routing.modelSource,

                        openrouterModelProbability:
                            routing.openrouterModelProbability,

                        openrouterModelProbabilities:
                            routing.openrouterModelProbabilities
                    }
                    : undefined;

            console.log(
                `→ Schema design request: ` +
                    (
                        pinnedDecision === undefined
                            ? "no routing decision, stages will choose"
                            : `routed to ${pinnedDecision.provider}` +
                                (
                                    pinnedDecision.openrouterModel === undefined
                                        ? ""
                                        : ` on ${pinnedDecision.openrouterModel}`
                                )
                    )
            );


            /*
             * -----------------------------------------
             * 4. Design, then DDL, on the pinned decision
             * -----------------------------------------
             */

            const result =
                await runSchemaMigration(
                    parsed.data,
                    pinnedDecision
                );

            /*
             * -----------------------------------------
             * 5. What actually generated the answer
             *
             * Read from the providers' own answers, not
             * from the routing decision. The two agree only
             * while nothing failed: a stage that fell
             * through the chain ran on a different
             * provider, and possibly a different model, to
             * the one that was pinned for it.
             * -----------------------------------------
             */

            const modelsUsed: StageModelUsage[] =
                [
                    {
                        stage:
                            "query_scope_guard",

                        provider:
                            scopeCheck.provider,

                        model:
                            scopeCheck.model ?? null
                    },

                    {
                        stage:
                            "schema_design",

                        provider:
                            result.schema_design.provider,

                        model:
                            result.schema_design.model
                    },

                    {
                        stage:
                            "table_management",

                        provider:
                            result.table_management.provider,

                        model:
                            result.table_management.model
                    }
                ];

            logModelsUsed(
                modelsUsed
            );


            /*
             * -----------------------------------------
             * 6. Response
             * -----------------------------------------
             */

            res.status(200).json({

                success: true,

                result,

                /*
                 * One line per stage, provider and model together, so a caller
                 * can trace a request to the models that served it without
                 * reading the server log. The routing block below reports the
                 * decision; this reports the work.
                 */
                models:
                    modelsUsed,

                intake: {
                    scope,
                    intent,
                    reason,

                    resolved_user_query:
                        scopeCheck.result
                            .resolved_user_query,

                    operations:
                        scopeCheck.result
                            .operations
                },

                routing: {
                    provider:
                        pinnedDecision?.provider ??
                            null,

                    confidence:
                        routing.confidence,

                    workload:
                        routing.workload,

                    probabilities:
                        routing.probabilities,

                    /*
                     * The OpenRouter model, how it was arrived at, and the
                     * distribution behind it.
                     *
                     * `source` is the field that matters. "jev" is a model the
                     * router chose for this measured workload, "derived" is the
                     * catalogue sorted in code because the router was not
                     * decisive, and "pinned" is an operator override - three
                     * different claims that used to be indistinguishable, since
                     * a rejected answer and a routed one both left a model id
                     * sitting in the same field.
                     */
                    openrouter_model: {
                        model:
                            routing.model,

                        source:
                            routing.modelSource,

                        probability:
                            routing.openrouterModelProbability ??
                                0,

                        confidence:
                            routing.modelConfidence,

                        probabilities:
                            routing.modelProbabilities,

                        routed:
                            routing.routed &&
                            routing.modelSource === "jev",

                        pinned:
                            routing.modelPinned,

                        /*
                         * Not a configured model. This is what the same measured
                         * load would select with the router switched off, so the
                         * number is a consequence of the request and a caller can
                         * see exactly what the router was choosing between.
                         */
                        derived_for_this_load:
                            selectOpenRouterModel(
                                {
                                    stage:
                                        "schema_design",

                                    inputTokens:
                                        inputLoad.estimatedInputTokens,

                                    expectedOutputTokens:
                                        estimateOutputTokens(
                                            scopeCheck.digest
                                        ),

                                    outputCeiling:
                                        OPENROUTER_MAX_COMPLETION_TOKENS
                                }
                            )
                    },

                    model:
                        routing.model,

                    source:
                        routing.routed
                            ? "jev"
                            : "in-code default"
                },

                layout: {

                    bundle_root:
                        ROOT,

                    source_schema:
                        `${ORACLE_SCHEMA_DIR}/source_schema.json`,

                    target_schema:
                        `${POSTGRES_SCHEMA_DIR}/target_schema.json`,

                    ddl:
                        POSTGRES_DDL_DIR,

                    manifest:
                        MANIFEST_PATH
                }
            });

        } catch (
            error: unknown
        ) {

            respondWithError(
                res,
                error,
                "Schema design failed"
            );
        }
    }
);
