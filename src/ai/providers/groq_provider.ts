import Groq from "groq-sdk";

import { env } from "../../config/env.js";

import type {
    AIRequest,
    AIResponse
} from "../../types/types.js";

const client = new Groq({
    apiKey: env.groqApiKey
});
function stableStringify(
    value: unknown
): string {

    const sortKeys = (
        input: unknown
    ): unknown => {

        if (Array.isArray(input)) {
            return input.map(sortKeys);
        }

        if (
            input !== null &&
            typeof input === "object"
        ) {
            return Object
                .keys(input as Record<string, unknown>)
                .sort()
                .reduce<Record<string, unknown>>(
                    (
                        acc: Record<string, unknown>,
                        key: string
                    ): Record<string, unknown> => {

                        acc[key] = sortKeys(
                            (input as Record<string, unknown>)[key]
                        );

                        return acc;
                    },
                    {}
                );
        }

        return input;
    };

    return JSON.stringify(sortKeys(value));
}

export async function generateWithGroq(
    request: AIRequest
): Promise<AIResponse> {

    const messages: Array<{
        role: "system" | "user";
        content: string;
    }> = [];

    if (request.systemPrompt.trim().length > 0) {
        messages.push({
            role: "system",
            content: request.systemPrompt
        });
    }
    if (
        request.staticContext !== undefined &&
        request.staticContext.trim().length > 0
    ) {
        messages.push({
            role: "user",
            content: JSON.stringify(
                JSON.parse(
                    stableStringify(request.staticContext)
                ),
                null,
                2
            )
        });
    }

    /* Dynamic portion. Changes per request, must come last. */
    messages.push({
        role: "user",
        content: request.dynamicPrompt
    });

    const response = await client.chat.completions.create({
        model: env.groqModel,
        messages,
        response_format: {
            type: "json_schema",
            json_schema: {
                name: request.responseSchemaName,
                strict: true,
                schema: request.responseSchema
            }
        }
    });

    const content = response.choices[0]?.message?.content;

    if (!content) {
        throw new Error(
            "Groq returned an empty response"
        );
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error(
            "Groq returned invalid JSON"
        );
    }

    return {
        provider: "groq",
        result: parsed
    };
}
