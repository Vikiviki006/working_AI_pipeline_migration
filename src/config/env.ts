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

    /*
     * The model a PINNED OpenRouter deployment generates on, and nothing else.
     *
     * There is no default model. The model for a request is derived from the size
     * of the work: Jev chooses it while the router is up, and ai/jevModel.ts
     * sorts the catalogue in code when it is not. This value is read on exactly
     * one path - an operator who has set OPENROUTER_MODEL_PINNED below - because
     * that is a decision made on purpose, and reading it as a silent fallback
     * would put a fixed $0.40/$1.60 model in front of workloads a $0.10/$0.32
     * one would have served.
     *
     * To pin: set both variables. To let the workload decide, set neither.
     */
    openrouterModel:
        process.env.OPENROUTER_MODEL ??
            "openai/gpt-4.1-mini",

    /*
     * Opt-in escape hatch. When true, the model above is used whatever the
     * routing step decided, whatever the catalogue would have sorted to, and
     * whatever the provider would have asked on its own - the model question is
     * not even asked, so an operator can freeze generation on one model without
     * a code change.
     *
     * Off by default, and the only way a model is ever named without something
     * having been measured first.
     */
    openrouterModelPinned:
        (
            process.env.OPENROUTER_MODEL_PINNED ??
                ""
        ).trim().toLowerCase() === "true",

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
