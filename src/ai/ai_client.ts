import {
    generateWithGroq
} from "./providers/groq_provider.js";

import {
    generateWithGemini
} from "./providers/gemini_provider.js";

import {
    ProviderUnavailableError
} from "../lib/errors.js";

import type {
    AIProviderName,
    AIRequest,
    AIResponse
} from "../types/types.js";

export type AIProviderFailure = {
    provider: AIProviderName;
    message: string;
};

/*
 * Single entry point for every AI call.
 *
 * Groq is primary: its prefix cache makes the large static schema context
 * cheap, so the same schema reuses cached tokens. Gemini is the fallback.
 *
 * A total outage raises ProviderUnavailableError carrying both failures, so
 * the route can answer 503 and tell the caller which providers were tried
 * instead of collapsing it into an opaque 500.
 */
export async function callAI(
    request: AIRequest,
    taskLabel: string
): Promise<AIResponse> {

    const failures: AIProviderFailure[] = [];

    console.log(
        `→ ${taskLabel}: trying Groq`
    );

    try {
        return await generateWithGroq(request);
    } catch (groqError: unknown) {
        console.error(
            `→ ${taskLabel}: Groq failed, falling back to Gemini`
        );
        console.error(groqError);

        failures.push(
            describeFailure(
                "groq",
                groqError
            )
        );
    }

    try {
        return await generateWithGemini(request);
    } catch (geminiError: unknown) {
        console.error(
            `→ ${taskLabel}: Gemini failed`
        );
        console.error(geminiError);

        failures.push(
            describeFailure(
                "gemini",
                geminiError
            )
        );
    }

    throw new ProviderUnavailableError(
        `${taskLabel}: every AI provider failed`,
        failures
    );
}

function describeFailure(
    provider: AIProviderName,
    error: unknown
): AIProviderFailure {

    return {
        provider,
        message:
            error instanceof Error
                ? error.message
                : String(error)
    };
}
