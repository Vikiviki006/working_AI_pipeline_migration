import OpenAI from "openai";

import {
    env
} from "../../config/env.js";

import {
    OPENROUTER_MAX_COMPLETION_TOKENS
} from "../../types/types.js";

import {
    resolveOpenRouterModel
} from "../jevModel.js";

import type {
    AIRequest,
    AIResponse,
    RoutedOpenRouterModel
} from "../../types/types.js";

import type {
    ModelDecision
} from "../jevModel.js";


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


/*
 * OpenRouter is a catalogue, not a model, so this provider does not decide
 * which model serves the request - and it is not allowed to fall back on a name
 * from the environment either, which is the line that would quietly undo every
 * decision Jev makes.
 *
 * The model is resolved in ai/jevModel.ts, in this order:
 *
 *   - a model already chosen for this request, which arrives as `routedModel`.
 *     That covers the whole of /api/schema-design and every OpenRouter call
 *     reached by fallback from Groq or Gemini, because the decision travels
 *     down with the provider name.
 *   - otherwise Jev is asked now, against the load measured on the request
 *     being sent. This is the scope guard, /api/data-migration, and any request
 *     whose one routing call failed.
 *   - otherwise the catalogue is sorted in code for this load: the cheapest
 *     entry that can hold the prompt and finish the answer.
 *
 * `env.openrouterModel` is read on none of those paths. It exists for an
 * operator who sets OPENROUTER_MODEL_PINNED, which is a decision made on
 * purpose, and it is the only way a model can be named without anything having
 * been measured.
 */
export async function generateWithOpenRouter(
    request: AIRequest,
    routedModel?: RoutedOpenRouterModel
): Promise<AIResponse> {

    const userPrompt =
        buildUserPrompt(request);

    const decision: ModelDecision =
        await resolveOpenRouterModel(
            request,
            routedModel
        );

    const model: string =
        decision.model;

    console.log(
        "→ OpenRouter model:",
        model,
        `(${describeSource(decision)})`
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

            model,

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

            /*
             * Declared in types.ts beside the model catalogue, because the
             * routing model is told this number and is expected to avoid
             * choosing a model that cannot finish the answer inside it.
             */
            max_completion_tokens:
                OPENROUTER_MAX_COMPLETION_TOKENS
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

        /*
         * Reported so a response can be traced to the model that produced it.
         * The id echoed back is the one the request named, not one read off the
         * completion: OpenRouter may serve the call from a different upstream
         * provider, but it answers with the model that was asked for.
         */
        model,

        result: parsed
    };
}


/*
 * How the model was chosen, in words rather than as an enum value, because this
 * line is read by a person deciding whether to trust the request or the router.
 */
function describeSource(
    decision: ModelDecision
): string {

    switch (decision.source) {

        case "jev":
            return "chosen by Jev for this request";

        case "jev-on-demand":
            return "chosen by Jev for this prompt, no request-level routing";

        case "derived":
            return "cheapest catalogue entry that fits this prompt, Jev was not decisive";

        case "pinned":
            return "frozen by OPENROUTER_MODEL_PINNED";
    }
}