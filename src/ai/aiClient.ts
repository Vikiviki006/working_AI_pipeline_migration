import {
    generateWithGemini
} from "./providers/geminiProvider.js";

import {
    generateWithGroq
} from "./providers/groqProvider.js";

import {
    generateWithOpenRouter
} from "./providers/openrouterProvider.js";

import {
    ProviderUnavailableError
} from "../lib/errors.js";

import {
    FALLBACK_ORDER
} from "../types/types.js";

import type {
    AIProviderName,
    AIRequest,
    AIResponse,
    RoutingDecision
} from "../types/types.js";


export type AIProviderFailure = {
    provider: AIProviderName;
    message: string;
};

/*
 * The provider chain.
 *
 * The caller may pin a decision, in which case it is tried first and the rest
 * of the chain is only reached if it fails. Pinning is what keeps the pipeline
 * to a single routing decision: Jev is asked once per request by
 * POST /api/schema-design, and the answer is threaded down through every stage
 * rather than being recomputed per stage.
 *
 * What is pinned is a RoutingDecision rather than a bare provider name, because
 * OpenRouter is a catalogue and not a model. The provider says which API to
 * call; the model says which model on it. Both travel together, so an
 * OpenRouter call reached by fallback - from Groq, from Gemini, or from the
 * in-code default - still generates on a model chosen for this workload rather
 * than on whatever the operator last configured.
 *
 * When nothing is pinned - the scope guard, which runs before routing has
 * happened, and /api/data-migration, which has no routing step - the provider
 * is chosen in code by pickDefaultProvider. That costs nothing and keeps the
 * hot path free of a network round-trip.
 */
export async function callAI(
    request: AIRequest,
    taskLabel: string,
    decision?: RoutingDecision
): Promise<AIResponse> {

    const routing: RoutingDecision =
        decision ??
            {
                provider:
                    pickDefaultProvider(request)
            };

    const selectedProvider: AIProviderName =
        routing.provider;

    console.log(
        `→ ${taskLabel}: provider=${selectedProvider}` +
            (
                decision === undefined
                    ? " (in-code default)"
                    : " (pinned by Jev)"
            ) +
            (
                routing.openrouterModel === undefined
                    ? ""
                    : ` openrouterModel=${routing.openrouterModel}` +
                        (
                            routing.openrouterModelSource === undefined
                                ? ""
                                : ` via ${routing.openrouterModelSource}`
                        ) +
                        (
                            routing.openrouterModelProbability === undefined
                                ? ""
                                : ` p=${routing.openrouterModelProbability.toFixed(3)}`
                        )
            )
    );

    const candidates: AIProviderName[] = [
        selectedProvider,
        ...FALLBACK_ORDER[selectedProvider]
    ];

    /*
     * ============================================================
     * Drop providers whose circuit is open.
     *
     * Without this, a provider that is down - an expired key, a model that is
     * out of capacity - is retried on every single call and every stage pays
     * for the round-trip that fails. That is the largest avoidable latency in
     * the pipeline, and skipping a known-dead provider costs nothing.
     * ============================================================
     */

    const available: AIProviderName[] =
        candidates.filter(
            (
                provider: AIProviderName
            ): boolean => {

                if (
                    isCircuitOpen(provider)
                ) {
                    console.warn(
                        `→ ${taskLabel}: skipping ${provider}, its circuit is open`
                    );

                    return false;
                }

                return true;
            }
        );

    /*
     * Every circuit open would otherwise mean no request could run at all, so
     * a total lockout is treated as a reason to probe rather than to fail.
     */
    if (
        available.length === 0
    ) {
        console.warn(
            `→ ${taskLabel}: every provider circuit is open, probing all of them`
        );

        available.push(
            ...candidates
        );
    }

    const failures:
        AIProviderFailure[] = [];

    for (
        const provider
        of available
    ) {

        if (
            provider !==
                selectedProvider
        ) {
            console.log(
                `→ ${taskLabel}: trying fallback ${provider}`
            );
        }

        try {

            const response: AIResponse =
                await generateWithProvider(
                    provider,
                    request,
                    routing
                );

            recordProviderSuccess(
                provider
            );

            return response;

        } catch (
            error: unknown
        ) {

            console.error(
                `→ ${taskLabel}: ${provider} failed`
            );

            console.error(
                error
            );

            recordProviderFailure(
                provider,
                error
            );

            failures.push(
                describeFailure(
                    provider,
                    error
                )
            );
        }
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


/* ============================================================
 * Provider circuit breaker
 * ============================================================
 *
 * Per-provider, in-process, and deliberately simple: count consecutive
 * failures, and while a provider is over its threshold stop calling it for a
 * cooldown. A single success closes the circuit.
 *
 * An authentication failure is not a blip - a bad key stays bad - so it opens
 * the circuit immediately and for far longer than a transient error.
 *
 * This is a latency mechanism, not a correctness one. It can only ever remove
 * a provider from consideration for a while; it can never let a bad answer
 * through, and if every circuit happens to be open the chain probes anyway.
 */

const CIRCUIT_FAILURE_THRESHOLD: number =
    2;

const CIRCUIT_COOLDOWN_MS: number =
    60_000;

const AUTH_COOLDOWN_MS: number =
    600_000;

type ProviderHealth = {
    consecutiveFailures: number;
    openUntil: number;
};

const providerHealth: Map<
    AIProviderName,
    ProviderHealth
> = new Map<
    AIProviderName,
    ProviderHealth
>();


function isCircuitOpen(
    provider: AIProviderName
): boolean {

    const health: ProviderHealth | undefined =
        providerHealth.get(provider);

    if (
        health === undefined
    ) {
        return false;
    }

    if (
        health.openUntil >
            Date.now()
    ) {
        return true;
    }

    /*
     * The cooldown has elapsed. Clear it so the next failure is counted from
     * zero again, and let this call through as the probe.
     */
    if (
        health.openUntil > 0
    ) {
        health.openUntil = 0;
        health.consecutiveFailures = 0;
    }

    return false;
}


function recordProviderSuccess(
    provider: AIProviderName
): void {

    providerHealth.delete(provider);
}


function recordProviderFailure(
    provider: AIProviderName,
    error: unknown
): void {

    const existing: ProviderHealth | undefined =
        providerHealth.get(provider);

    const health: ProviderHealth =
        existing ?? {
            consecutiveFailures: 0,
            openUntil: 0
        };

    health.consecutiveFailures += 1;

    if (
        isAuthFailure(error)
    ) {
        health.openUntil =
            Date.now() + AUTH_COOLDOWN_MS;

        console.error(
            `→ ${provider} rejected its credentials, skipping it for ${AUTH_COOLDOWN_MS / 1000}s`
        );

    } else if (
        health.consecutiveFailures >=
            CIRCUIT_FAILURE_THRESHOLD
    ) {
        health.openUntil =
            Date.now() + CIRCUIT_COOLDOWN_MS;

        console.warn(
            `→ ${provider} failed ${health.consecutiveFailures} times in a row, skipping it for ${CIRCUIT_COOLDOWN_MS / 1000}s`
        );
    }

    providerHealth.set(
        provider,
        health
    );
}


/*
 * The three provider SDKs report HTTP status differently in shape but
 * identically in substance: an auth rejection carries a 401 or 403.
 */
function isAuthFailure(
    error: unknown
): boolean {

    if (
        error === null ||
        typeof error !== "object"
    ) {
        return false;
    }

    const status: unknown =
        (error as { status?: unknown })
            .status;

    return status === 401 ||
        status === 403;
}


async function generateWithProvider(
    provider: AIProviderName,
    request: AIRequest,
    routing: RoutingDecision
): Promise<AIResponse> {

    switch (provider) {

        case "gemini":

            return await generateWithGemini(
                request
            );


        case "groq":

            return await generateWithGroq(
                request
            );


        case "openrouter":

            /*
             * The only provider with a choice to make, and the only one that has
             * to make it for itself when the route pinned nothing. The model and
             * where it came from travel together, so a call that arrives without
             * a decision is resolved against the request in front of it rather
             * than against configuration - see ai/jevModel.ts for the order.
             */
            return await generateWithOpenRouter(
                request,
                routing.openrouterModel === undefined
                    ? undefined
                    : {
                        model:
                            routing.openrouterModel,

                        source:
                            routing.openrouterModelSource ??
                            "jev"
                    }
            );
    }
}

/* ============================================================
 * In-code provider default
 * ============================================================ */

/*
 * A deterministic estimate of how much work a request is, derived from the
 * shape of the prompt rather than from a model. It is deliberately the same
 * three-way split Jev is asked to make - small goes to the fastest provider,
 * medium to the balanced one, large to the model with the most headroom - so
 * an unpinned call and a pinned call would agree in the common case.
 *
 * The split is a plain if/else ladder over the two cheap providers, and that
 * shape is the point. The thresholds are a monotone partition of the same
 * workload estimate: the first branch is the cheapest way to answer a small
 * request, the second is the cheapest way to answer a medium one, and anything
 * that fails both has outgrown both and falls through to OpenRouter. Nesting
 * the tests instead would make "medium" a function of "not small AND not
 * large", which is the same three buckets expressed so that changing one
 * threshold silently reclassifies the other.
 *
 * Only the PROVIDER is decided here. The OpenRouter model is not: it depends on
 * which model the workload justifies, and that is a question about price
 * against capability rather than about prompt length, so it belongs to the
 * routing call. An unpinned request therefore reaches OpenRouter on the
 * configured default model, which is the known one.
 *
 * This is a default, not a router. When the answer actually matters, ask Jev.
 */
function pickDefaultProvider(
    request: AIRequest
): AIProviderName {

    const totalCharacters: number =
        request.systemPrompt.length +
        (request.staticContext?.length ?? 0) +
        request.dynamicPrompt.length;

    const estimatedInputTokens: number =
        Math.ceil(
            totalCharacters / 4
        );

    const searchable: string =
        (request.staticContext ?? "") +
        request.dynamicPrompt;

    const schemaComplexity: number =
        countOccurrences(
            searchable,
            "tableName"
        ) +
        Math.ceil(
            countOccurrences(
                searchable,
                "columnName"
            ) / 5
        ) +
        countOccurrences(
            searchable,
            "foreignKey"
        ) * 2 +
        countOccurrences(
            searchable,
            "primaryKey"
        );

    /*
     * SMALL: a short prompt over a shallow schema. Groq is the fastest of the
     * three and its model is the cheapest, and a request this size does not
     * need anything it does not have.
     */
    if (
        estimatedInputTokens <= 2000 &&
        schemaComplexity <= 20
    ) {
        return "groq";
    }

    /*
     * MEDIUM: past what Groq is for, but still within reach of a mid-priced
     * model. Note this is a ceiling on the SMALL branch, not a floor on the
     * next one - anything that misses SMALL is measured again here, so a large
     * schema with a short prompt is judged on its complexity rather than on its
     * token count alone.
     */
    if (
        estimatedInputTokens <= 6000 &&
        schemaComplexity <= 60
    ) {
        return "gemini";
    }

    /*
     * LARGE: failed both ceilings. OpenRouter, and the routing step picks which
     * model on it the size of the work justifies.
     */
    return "openrouter";
}


/*
 * Count a substring without using
 * regular expressions.
 */
function countOccurrences(
    text: string,
    search: string
): number {

    if (
        search.length === 0
    ) {
        return 0;
    }

    let count: number = 0;
    let position: number = 0;

    while (true) {

        const index: number =
            text.indexOf(
                search,
                position
            );

        if (index === -1) {
            break;
        }

        count += 1;

        position =
            index + search.length;
    }

    return count;
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