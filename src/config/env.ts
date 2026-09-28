import "dotenv/config";
import { EnvConfig } from "../types/types.js";

function getEnv(name: string): string {
    const value: string | undefined =
        process.env[name];
    if (value === undefined ||value === "") {
        throw new Error(
            `Missing environment variable: ${name}`
        );
    }
    return value;
}
export const env = {
    groqApiKey:
        process.env.GROQ_API_KEY ?? "",

    geminiApiKey:
        process.env.GEMINI_API_KEY ?? "",

    openrouterApiKey:
        process.env.OPENROUTER_API_KEY ?? "",

    groqModel:
        process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",

    geminiModel:
        process.env.GEMINI_MODEL ?? "",

    openrouterModel:
        process.env.OPENROUTER_MODEL ??
        "openai/gpt-4.1-mini",

    typesafeApiKey:
        process.env.TYPESAFE_API_KEY ?? "",

    port:
        Number(
            process.env.PORT ?? 3000
        )
};