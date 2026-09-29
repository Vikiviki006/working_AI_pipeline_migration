import Groq from "groq-sdk";

import { env } from "../../config/env.js";

import type {
    AIRequest,
    AIResponse
} from "../../types/types.js";


const client = new Groq({
    apiKey: env.groqApiKey
});


function buildUserPrompt(
    request: AIRequest
): string {

    const sections: string[] = [];

    /*
     * GPT-OSS guidance:
     * Keep instructions in the user message rather than
     * sending a separate system message.
     */
    if (
        request.systemPrompt.trim().length > 0
    ) {
        sections.push(
            "INSTRUCTIONS:\n" +
            request.systemPrompt.trim()
        );
    }


    /*
     * Static schema/context.
     * Keep this before the dynamic request so the stable
     * prefix remains cache-friendly.
     */
    if (
        request.staticContext !== undefined &&
        request.staticContext.trim().length > 0
    ) {
        sections.push(
            "STATIC CONTEXT:\n" +
            request.staticContext.trim()
        );
    }


    /*
     * Dynamic user request must come last.
     */
    sections.push(
        "DYNAMIC REQUEST:\n" +
        request.dynamicPrompt.trim()
    );


    return sections.join(
        "\n\n"
    );
}


export async function generateWithGroq(
    request: AIRequest
): Promise<AIResponse> {

    const userPrompt =
        buildUserPrompt(request);


    console.log(
        "→ Groq model:",
        env.groqModel
    );

    console.log(
        "→ Groq schema:",
        request.responseSchemaName
    );

    console.log(
        "→ Groq prompt length:",
        userPrompt.length
    );


    const response =
        await client.chat.completions.create({

            model:
                env.groqModel,

            messages: [
                {
                    role: "user",
                    content: userPrompt
                }
            ],

            /*
             * Strict Structured Outputs.
             * GPT-OSS 120B supports strict JSON Schema mode.
             */
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

            /*
             * Lower reasoning effort keeps this
             * schema-generation task more efficient.
             */
            reasoning_effort: "low",

            /*
             * Your schema-design response can contain
             * multiple tables and many columns.
             *
             * 1024 is often too small for this type of
             * structured response.
             */
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
            "Groq returned an empty response"
        );
    }


    let parsed: unknown;


    try {

        parsed =
            JSON.parse(content);

    } catch {

        throw new Error(
            "Groq returned invalid JSON"
        );
    }


    return {
        provider: "groq",
        model:
            env.groqModel,

        result: parsed
    };
}