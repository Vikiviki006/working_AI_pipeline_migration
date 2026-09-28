import {
    generateWithGemini
} from "./providers/gemini_provider.js";

import {
    generateWithGroq
} from "./providers/groq_provider.js";

import {
    generateWithOpenRouter
} from "./providers/openrouter_provider.js";

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


export async function callAI(
    request: AIRequest,
    taskLabel: string
): Promise<AIResponse> {

    const failures:
        AIProviderFailure[] = [];

    console.log(
        `→ ${taskLabel}: trying Gemini`
    );

    try {

        return await generateWithGemini(
            request
        );

    } catch (
        geminiError: unknown
    ) {

        console.error(
            `→ ${taskLabel}: Gemini failed, falling back to Groq`
        );

        console.error(
            geminiError
        );

        failures.push(
            describeFailure(
                "gemini",
                geminiError
            )
        );
    }


    /*
     * ============================================================
     * 2. FIRST FALLBACK — GROQ
     * ============================================================
     */

    console.log(
        `→ ${taskLabel}: trying Groq`
    );

    try {

        return await generateWithGroq(
            request
        );

    } catch (
        groqError: unknown
    ) {

        console.error(
            `→ ${taskLabel}: Groq failed, falling back to OpenRouter`
        );

        console.error(
            groqError
        );

        failures.push(
            describeFailure(
                "groq",
                groqError
            )
        );
    }


    /*
     * ============================================================
     * 3. SECOND FALLBACK — OPENROUTER
     * ============================================================
     */

    console.log(
        `→ ${taskLabel}: trying OpenRouter`
    );

    try {

        return await generateWithOpenRouter(
            request
        );

    } catch (
        openRouterError: unknown
    ) {

        console.error(
            `→ ${taskLabel}: OpenRouter failed`
        );

        console.error(
            openRouterError
        );

        failures.push(
            describeFailure(
                "openrouter",
                openRouterError
            )
        );
    }


    /*
     * ============================================================
     * ALL PROVIDERS FAILED
     * ============================================================
     */

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