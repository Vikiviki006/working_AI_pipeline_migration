import "dotenv/config";

/*
 * Fail fast on a missing key rather than on the first request that needs it.
 *
 * These are the keys the pipeline cannot run without: two generation providers
 * plus the one that also carries Jev routing. Anything optional - a model id,
 * the port - keeps a default and is not checked here.
 */
const REQUIRED_KEYS: readonly string[] = [
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY"
];

for (
    const name of REQUIRED_KEYS
) {

    const value: string | undefined =
        process.env[name];

    if (
        value === undefined ||
        value.trim().length === 0
    ) {
        throw new Error(
            `Missing environment variable: ${name}`
        );
    }
}

export const env = {
    groqApiKey:
        process.env.GROQ_API_KEY ?? "",

    geminiApiKey:
        process.env.GEMINI_API_KEY ?? "",

    openrouterApiKey:
        process.env.OPENROUTER_API_KEY ?? "",

    groqModel:
        process.env.GROQ_MODEL ??
            "openai/gpt-oss-120b",

    geminiModel:
        process.env.GEMINI_MODEL ?? "",

    openrouterModel:
        process.env.OPENROUTER_MODEL ??
            "openai/gpt-4.1-mini",

    /*
     * The Jev routing model. It is reached through the same OpenRouter
     * endpoint and the same OPENROUTER_API_KEY as the generation providers, so
     * routing needs no credential of its own.
     */
    jevModel:
        process.env.JEV_MODEL ??
            "typesafe/jev-1.13",

    port:
        Number(
            process.env.PORT ?? 3000
        )
};
