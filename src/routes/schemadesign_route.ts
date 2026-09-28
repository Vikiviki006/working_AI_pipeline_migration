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
} from "../ai/services/schema_migration_service.js";

import {
    checkQueryScopeIntent
} from "../ai/services/query_scope_intent_service.js";

import {
    SchemaDesignRequest
} from "../ai/schemas/schemadesign_request_zod.js";

import {
    respondWithError
} from "./route_helpers.js";

import {
    MANIFEST_PATH,
    ORACLE_SCHEMA_DIR,
    POSTGRES_DDL_DIR,
    POSTGRES_SCHEMA_DIR,
    ROOT
} from "../lib/file_layout.js";

import type {
    AIProviderName
} from "../types/types.js";

import type {
    SchemaDigest
} from "../lib/schema_verifier.js";

import type {
    QueryScopeIntent
} from "../ai/schemas/query_scope_intent_zod.js";


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
 */

export type JevRoutingResult = {
    provider: AIProviderName;
    confidence: number;
    probabilities: {
        groq: number;
        gemini: number;
        openrouter: number;
    };
    workload: string;
    model: string;
    routed: boolean;
};

/*
 * Transport.
 *
 * Jev is reached through OpenRouter, on the same OPENROUTER_API_KEY as the
 * generation providers, so routing introduces no second credential.
 *
 * It is deliberately NOT reached through OpenRouter's /chat/completions
 * endpoint. Jev is a decisions model and that endpoint rejects it outright with
 * a 400. The call goes to OpenRouter's /api/alpha/decisions endpoint, which
 * takes the same state-plus-questions payload the TypeSafe SDK used and answers
 * with a weighted choice.
 */
const JEV_ENDPOINT: string =
    "https://openrouter.ai/api/alpha/decisions";

/*
 * Routing is advisory, so it gets a hard budget. A routing call that has not
 * answered in this long has told us nothing useful, and holding a request open
 * for it would cost more than simply choosing in code.
 */
const JEV_TIMEOUT_MS: number =
    10_000;

const JEV_QUESTION_NAME: string =
    "provider";

const PROVIDER_NAMES: readonly AIProviderName[] = [
    "groq",
    "gemini",
    "openrouter"
];

/**
 * Asks Jev which provider should serve the rest of this request.
 *
 * The state it is given is the guard's output - the resolved user query and the
 * operation breakdown - plus the Oracle metadata digest, never the raw schema.
 * That is deliberate: Jev is choosing a provider for an already-measured amount
 * of work, and shipping the document would cost a large prompt to answer a
 * question four numbers already answer.
 *
 * Routing is best-effort by design. A Jev failure degrades to the in-code
 * default inside callAI rather than failing a request that is otherwise ready
 * to run, so nothing here throws to the route.
 */
export async function jevRoute(
    intent: QueryScopeIntent,
    digest: SchemaDigest
): Promise<JevRoutingResult> {

    const workload: string =
        describeWorkload(digest);

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
            }
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

        console.log(
            `→ Jev: provider=${decision.provider}` +
                ` confidence=${decision.confidence.toFixed(3)}` +
                ` workload="${workload}"` +
                ` probabilities=${JSON.stringify(decision.probabilities)}`
        );

        return {
            provider:
                decision.provider,

            confidence:
                decision.confidence,

            probabilities:
                decision.probabilities,

            workload,

            model:
                decision.model,

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
             * route to pin nothing, so callAI chooses rather than this function
             * guessing on its behalf.
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
                env.jevModel,

            routed:
                false
        };
    }
}


/*
 * The measured workload, in code, so the routing record shows the numbers the
 * decision was made against rather than a model's account of them.
 */
function describeWorkload(
    digest: SchemaDigest
): string {

    return [
        `${digest.table_count} table(s)`,
        `${digest.column_count} column(s)`,
        `${digest.primary_key_count} primary key(s)`,
        `${digest.foreign_key_count} foreign key(s)`,
        digest.truncated
            ? "digest truncated"
            : "full digest"
    ].join(
        ", "
    );
}


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
    model: string;
} {

    const parsed: unknown =
        JSON.parse(content);

    if (
        parsed === null ||
        typeof parsed !== "object"
    ) {
        throw new Error(
            "Jev response was not an object"
        );
    }

    const record: Record<string, unknown> =
        parsed as Record<string, unknown>;

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

    const rawAnswer: unknown =
        (
            rawAnswers as Record<
                string,
                unknown
            >
        )[JEV_QUESTION_NAME];

    if (
        rawAnswer === null ||
        typeof rawAnswer !== "object"
    ) {
        throw new Error(
            `Jev returned no "${JEV_QUESTION_NAME}" answer`
        );
    }

    const answer: Record<string, unknown> =
        rawAnswer as Record<string, unknown>;

    const choice: unknown =
        answer.choice;

    if (
        typeof choice !== "string" ||
        !PROVIDER_NAMES.includes(
            choice as AIProviderName
        )
    ) {
        throw new Error(
            `Jev named an unknown provider: ${String(choice)}`
        );
    }

    const rawConfidence: unknown =
        answer.confidence;

    const confidence: number =
        typeof rawConfidence === "number" &&
        Number.isFinite(rawConfidence)
            ? Math.min(
                1,
                Math.max(
                    0,
                    rawConfidence
                )
            )
            : 0;

    const rawProbabilities: unknown =
        answer.probabilities;

    const probabilities: Record<
        string,
        unknown
    > =
        rawProbabilities !== null &&
        typeof rawProbabilities === "object"
            ? rawProbabilities as Record<
                string,
                unknown
            >
            : {};

    const probability = (
        name: AIProviderName
    ): number => {

        const value: unknown =
            probabilities[name];

        return typeof value === "number" &&
            Number.isFinite(value)
                ? value
                : 0;
    };

    const model: unknown =
        record.model;

    return {
        provider:
            choice as AIProviderName,

        confidence,

        probabilities: {
            groq: probability("groq"),
            gemini: probability("gemini"),
            openrouter:
                probability("openrouter")
        },

        model:
            typeof model === "string" &&
            model.length > 0
                ? model
                : env.jevModel
    };
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
             * taken against the resolved query and the
             * Oracle digest. The answer is pinned onto both
             * downstream stages, so neither spends another
             * round-trip asking.
             * -----------------------------------------
             */

            const routing =
                await jevRoute(
                    scopeCheck.result,
                    scopeCheck.digest
                );

            /*
             * undefined rather than a guess: when Jev did not answer,
             * callAI picks from the workload itself.
             */
            const pinnedProvider:
                AIProviderName | undefined =
                    routing.routed
                        ? routing.provider
                        : undefined;

            console.log(
                `→ Schema design request: ` +
                    (
                        pinnedProvider === undefined
                            ? "no routing decision, stages will choose"
                            : `routed to ${pinnedProvider}`
                    )
            );


            /*
             * -----------------------------------------
             * 4. Design, then DDL, on the pinned provider
             * -----------------------------------------
             */

            const result =
                await runSchemaMigration(
                    parsed.data,
                    pinnedProvider
                );


            /*
             * -----------------------------------------
             * 5. Response
             * -----------------------------------------
             */

            res.status(200).json({

                success: true,

                result,

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
                        pinnedProvider ??
                            null,

                    confidence:
                        routing.confidence,

                    workload:
                        routing.workload,

                    probabilities:
                        routing.probabilities,

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
