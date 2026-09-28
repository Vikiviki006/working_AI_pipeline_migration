import OpenAI from "openai";

import { env } from "../../config/env.js";

import type {
    AIRequest,
    AIResponse
} from "../../types/types.js";


const client = new OpenAI({
    apiKey: env.openrouterApiKey,
    baseURL: "https://openrouter.ai/api/v1"
});


function buildUserPrompt(
    request: AIRequest
): string {

    const sections: string[] = [];

    if (
        request.systemPrompt.trim().length > 0
    ) {
        sections.push(
            "INSTRUCTIONS:\n" +
            request.systemPrompt.trim()
        );
    }

    if (
        request.staticContext !== undefined &&
        request.staticContext.trim().length > 0
    ) {
        sections.push(
            "STATIC CONTEXT:\n" +
            request.staticContext.trim()
        );
    }

    sections.push(
        "DYNAMIC REQUEST:\n" +
        request.dynamicPrompt.trim()
    );

    return sections.join(
        "\n\n"
    );
}


export async function generateWithOpenRouter(
    request: AIRequest
): Promise<AIResponse> {

    const userPrompt =
        buildUserPrompt(request);

    console.log(
        "→ OpenRouter model:",
        env.openrouterModel
    );

    console.log(
        "→ OpenRouter schema:",
        request.responseSchemaName
    );

    console.log(
        "→ OpenRouter prompt length:",
        userPrompt.length
    );


    const response =
        await client.chat.completions.create({

            model:
                env.openrouterModel,

            messages: [
                {
                    role: "user",
                    content: userPrompt
                }
            ],

            response_format: {
                type: "json_schema",

                json_schema: {
                    name:
                        request.responseSchemaName,

                    strict: true,

                    schema:
                        request.responseSchema
                }
            },

            max_completion_tokens: 4096
        });


    const content =
        response.choices[0]?.message?.content;


    if (
        content === null ||
        content === undefined ||
        content.trim().length === 0
    ) {
        throw new Error(
            "OpenRouter returned an empty response"
        );
    }


    let parsed: unknown;


    try {

        parsed =
            JSON.parse(content);

    } catch {

        throw new Error(
            "OpenRouter returned invalid JSON"
        );
    }


    return {
        provider: "openrouter",
        result: parsed
    };
}