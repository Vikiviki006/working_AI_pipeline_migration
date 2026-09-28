import {
    callAI
} from "../ai_client.js";

import {
    QUERY_SCOPE_INTENT_SYSTEM_PROMPT
} from "../prompts/query_scope_intent_prompt.js";

import {
    QueryScopeIntentSchema
} from "../schemas/query_scope_intent_zod.js";

import {
    QUERY_SCOPE_INTENT_SCHEMA_NAME,
    queryScopeIntentJsonSchema
} from "../schemas/query_scope_intent_schema.js";

import {
    buildSchemaDigest
} from "../../lib/schema_verifier.js";

import {
    ProviderOutputError
} from "../../lib/errors.js";

import type {
    AIProviderName,
    AIRequest
} from "../../types/types.js";

import type {
    QueryScopeIntent
} from "../schemas/query_scope_intent_zod.js";

import type {
    SchemaDigest
} from "../../lib/schema_verifier.js";

export type QueryScopeGuardInput = {
    selected_schema: unknown;
    current_design?: unknown;
    user_query: string;
};

export type QueryScopeGuardResult = {
    provider: AIProviderName;
    result: QueryScopeIntent;
    digest: SchemaDigest;
};

/*
 * The scope guard.
 *
 * The intake stage. It answers three questions - is this request in the
 * supported database-migration domain, what is its primary intent, and what is
 * it actually asking for in unambiguous terms - and produces no SQL, no DDL
 * and no schema of its own.
 *
 * The third answer is what makes the guard worth more than a keyword filter:
 * resolved_user_query is the single concrete instruction the rest of the
 * request is planned around, and operations is the work breakdown the Jev
 * router reads when it picks a provider.
 *
 * The Oracle metadata reaches this stage as a digest rather than as the raw
 * document. Classification and query-building need to know which objects
 * exist, not Oracle data lengths, precision, scale, defaults or column ids, and
 * this is the first of three prompts the metadata would otherwise be shipped
 * through on every request.
 */
export async function checkQueryScopeIntent(
    input: QueryScopeGuardInput
): Promise<QueryScopeGuardResult> {

    const digest: SchemaDigest =
        buildSchemaDigest(
            input.selected_schema
        );

    /*
     * Compact, not pretty-printed. Whitespace is a real cost here: it is
     * billed as input tokens on every call and buys the model nothing.
     */
    const staticContext: string =
        JSON.stringify(
            {
                oracle_schema: digest,

                current_design:
                    input.current_design ?? null
            }
        );

    /*
     * The user query is untrusted input and is quoted in its own block so
     * the system prompt can treat anything inside it as data rather than as
     * instructions.
     */
    const dynamicPrompt: string =
        `## User Query\n\n${input.user_query}`;

    const request: AIRequest = {
        systemPrompt:
            QUERY_SCOPE_INTENT_SYSTEM_PROMPT,

        staticContext,
        dynamicPrompt,

        responseSchema:
            queryScopeIntentJsonSchema,

        responseSchemaName:
            QUERY_SCOPE_INTENT_SCHEMA_NAME
    };

    /*
     * No provider is pinned here. The guard is the cheapest stage in the
     * pipeline and it runs before routing has happened, so it takes the
     * in-code default rather than spending a decision on itself.
     */
    const response =
        await callAI(
            request,
            "Query Scope Guard"
        );

    const validated =
        QueryScopeIntentSchema.safeParse(
            response.result
        );

    if (!validated.success) {

        console.error(
            "Query scope guard validation failed:",
            validated.error.format()
        );

        /*
         * The model misbehaved, not the caller, so this is a provider
         * failure. Letting it surface as a bare Error would collapse it into
         * a 500 and hide which side of the pipeline went wrong.
         */
        throw new ProviderOutputError(
            `${response.provider} returned a query scope classification that does not match the expected structure`,
            response.provider,
            validated.error.format()
        );
    }

    return {
        provider:
            response.provider,

        result:
            validated.data,

        digest
    };
}
