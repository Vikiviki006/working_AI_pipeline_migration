import { GoogleGenAI } from "@google/genai";

import { env } from "../../config/env.js";

import type {
    AIRequest,
    AIResponse
} from "../../types/types.js";

const client = new GoogleGenAI({
    apiKey: env.geminiApiKey
});

export async function generateWithGemini(
    request: AIRequest
): Promise<AIResponse> {

    const userPrompt: string = [

        request.staticContext ?? "",

        request.dynamicPrompt

    ]
        .filter(
            (
                value: string
            ): boolean =>
                value.trim().length > 0
        )
        .join("\n\n");

    console.log(
        "→ Gemini model:",
        env.geminiModel
    );

    console.log(
        "→ Gemini schema:",
        request.responseSchemaName
    );

    console.log(
        "→ Gemini prompt length:",
        userPrompt.length
    );

    const response = await client.models.generateContent({
        model: env.geminiModel,
        contents: userPrompt,
        config: {
            systemInstruction: request.systemPrompt,
            responseMimeType: "application/json",
            responseSchema: request.responseSchema
        }
    });

    if (!response.text) {
        throw new Error(
            "Gemini returned an empty response"
        );
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(response.text);
    } catch {
        throw new Error(
            "Gemini returned invalid JSON"
        );
    }

    return {
        provider: "gemini",
        model: env.geminiModel,
        result: parsed
    };
}
