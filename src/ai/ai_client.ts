import {
    generateWithGroq
} from "./providers/groq_provider.js";

import {
    generateWithGemini
} from "./providers/gemini_provider.js";

import type {
    AIProviderName,
    AIRequest,
    AIResponse
} from "../types/types.js";

export type AIProviderFailure = {
    provider: AIProviderName;
    error: unknown;
};

/*
 * Single entry point for every AI call. Groq is the primary provider because
 * its prefix cache makes the large static schema context cheap; Gemini is the
 * fallback. Both failures are reported so a caller can tell a total outage
 * apart from one provider being down.
 */
export async function callAI(
    request: AIRequest,
    taskLabel: string
): Promise<AIResponse> {

    console.log(
        `→ ${taskLabel}: trying Groq`
    );

    try {
        return await generateWithGemini(request);
    } catch (groqError: unknown) {
        console.error(
            `→ ${taskLabel}: Groq failed, falling back to Gemini`
        );
        console.error(groqError);
    }

    return await generateWithGroq(request);
}

export function describeFailures(
    failures: AIProviderFailure[]
): string {

    return failures
        .map(
            (
                failure: AIProviderFailure
            ): string =>
                `${failure.provider}: ${failure.error instanceof Error
                    ? failure.error.message
                    : String(failure.error)
                }`
        )
        .join(" | ");
}
