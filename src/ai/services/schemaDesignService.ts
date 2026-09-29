import { callAI } from "../aiClient.js";

import {
    SCHEMA_DESIGN_PROMPT
} from "../prompts/schemadesignPrompt.js";

import {
    schemaDesignSchema
} from "../schemas/schemadesignSchema.js";

import {
    SchemaDesignResponse
} from "../schemas/schemadesignZod.js";

import {
    ProviderOutputError
} from "../../lib/errors.js";

import type {
    AIRequest,
    AIResponse,
    RoutingDecision,
    SchemaDesignInput
} from "../../types/types.js";

/*
 * Route 1. Turns Oracle metadata plus a split/merge request into the final
 * PostgreSQL target schema. This is the only stage that makes design
 * decisions; every later stage is a pure translation of its output.
 */

/*
 * The design stage's prompt, assembled and nothing else.
 *
 * Exported because the routing step has to state how large this stage's input
 * will be before the stage runs, and an estimate of a prompt that is assembled
 * somewhere else is an estimate of a guess. Measuring the object that is about
 * to be sent is the only version of this number that cannot drift.
 */
export function buildSchemaDesignRequest(
    input: SchemaDesignInput
): AIRequest {

    /*
     * Compact, not pretty-printed. Whitespace is billed as input tokens on
     * every call and buys the model nothing: the Oracle document is the single
     * largest thing in this prompt, and indenting it is the difference between
     * paying for the schema once and paying for it twice.
     */
    const staticContext: string =
        JSON.stringify(
            {
                selected_schema:
                    input.selected_schema,

                current_design:
                    input.current_design ?? null
            }
        );

    const dynamicPrompt: string =
        `## User Query\n\n${input.user_query}`;

    return {
        systemPrompt:
            SCHEMA_DESIGN_PROMPT,

        staticContext,

        dynamicPrompt,

        responseSchema:
            schemaDesignSchema,

        responseSchemaName:
            "schema_design"
    };
}


export async function generateSchemaDesign(
    input: SchemaDesignInput,
    decision?: RoutingDecision
): Promise<AIResponse> {

    const aiRequest: AIRequest =
        buildSchemaDesignRequest(
            input
        );

    const response: AIResponse =
        await callAI(
            aiRequest,
            "Schema Design",
            decision
        );

    const validated =
        SchemaDesignResponse.safeParse(
            response.result
        );

    if (!validated.success) {
        console.error(
            "Schema Design: response validation failed"
        );
        console.error(
            validated.error.format()
        );

        /*
         * The model misbehaved, not the caller, so this is a provider failure.
         * A bare Error here would collapse into a 500 and hide which side of
         * the pipeline went wrong.
         */
        throw new ProviderOutputError(
            `${response.provider} returned a schema design that does not match the expected structure`,
            response.provider,
            validated.error.format()
        );
    }

    return {

        provider:
            response.provider,

        /*
         * Carried up so the route can report what this stage actually generated
         * on. On OpenRouter that is the model Jev chose for this workload, which
         * is the one number in a routing design that a caller cannot otherwise
         * see.
         */
        model:
            response.model,

        result:
            validated.data
    };
}
