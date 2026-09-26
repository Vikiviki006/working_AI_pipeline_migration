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
export const env: EnvConfig = {
    geminiApiKey:getEnv("GEMINI_API_KEY"),
    geminiModel:getEnv("GEMINI_MODEL"),
    groqApiKey:getEnv("GROQ_API_KEY"),
    groqModel:getEnv("GROQ_MODEL")
};
console.log("Gemini config:");
console.log({
    model: env.geminiModel,
    keyLoaded: Boolean(env.geminiApiKey),
    keyLength: env.geminiApiKey.length,
    keyPrefix:
        env.geminiApiKey.substring(0, 5) + "*****"
});