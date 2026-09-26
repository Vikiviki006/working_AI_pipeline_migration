import Groq from "groq-sdk";

import { env } from "../../config/env.js";

import type {
    AIRequest,
    AIResponse
} from "../../types/types.js";

const client = new Groq({
    apiKey: env.groqApiKey
});

/*
 * Deterministic JSON.stringify: sorts object keys recursively so the same
 * logical schema always serializes to the exact same string, regardless of
 * property insertion order upstream. Required for Groq's prefix cache to
 * reliably match the static portion of the prompt across requests.
 */
export function stableStringify(
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

    /*
     * Static portion. Identical across requests for the same
     * schema/designed output, so it forms the reusable cacheable
     * prefix. Must stay ahead of the dynamic prompt.
     */
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

    const usage = response.usage;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheHitRate =
        promptTokens > 0
            ? (cachedTokens / promptTokens) * 100
            : 0;

    console.log("Groq usage:", {
        model: env.groqModel,
        prompt: request.responseSchemaName,
        promptTokens,
        cachedTokens,
        cacheHitRate: `${cacheHitRate.toFixed(2)}%`,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0
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
