import { callAI } from "../ai_client.js";

import {
    SCHEMA_DESIGN_PROMPT
} from "../prompts/schemadesign_prompt.js";

import {
    schemaDesignSchema
} from "../schemas/schemadesign_schema.js";

import {
    SchemaDesignResponse
} from "../schemas/schemadesign_zod.js";

import type {
    AIRequest,
    AIResponse,
    SchemaDesignInput
} from "../../types/types.js";

/*
 * Route 1. Turns Oracle metadata plus a split/merge request into the final
 * PostgreSQL target schema. This is the only stage that makes design
 * decisions; every later stage is a pure translation of its output.
 */
export async function generateSchemaDesign(
    input: SchemaDesignInput
): Promise<AIResponse> {

    const staticContext: string =
        JSON.stringify(
            {
                selected_schema:
                    input.selected_schema,

                current_design:
                    input.current_design ?? null
            },
            null,
            2
        );

    const dynamicPrompt: string =
        `## User Query\n\n${input.user_query}`;

    const aiRequest: AIRequest = {
        systemPrompt: SCHEMA_DESIGN_PROMPT,
        staticContext,
        dynamicPrompt,
        responseSchema: schemaDesignSchema,
        responseSchemaName: "schema_design"
    };

    const response: AIResponse =
        await callAI(
            aiRequest,
            "Schema Design"
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

        throw new Error(
            `${response.provider} returned a schema design that does not match the expected structure`
        );
    }

    return {
        provider: response.provider,
        result: validated.data
    };
}
