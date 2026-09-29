import {
    env
} from "../config/env.js";

import {
    OPENROUTER_MAX_COMPLETION_TOKENS,
    OPENROUTER_MODEL_CHOICES,
    OPENROUTER_MODEL_IDS,
    describeModelCost
} from "../types/types.js";

import type {
    AIRequest,
    ModelSource,
    ModelTier,
    OpenRouterModelChoice,
    RoutedOpenRouterModel
} from "../types/types.js";


/* ============================================================
 * Which OpenRouter model serves this workload
 * ==========================================================
 *
 * OpenRouter is a catalogue, so "call OpenRouter" is not a decision - it is
 * half of one. This file is the other half, and it exists as its own file
 * because two very different places need the same answer: the route, which
 * asks Jev once per request and pins the result, and the OpenRouter provider,
 * which must be able to answer for itself when nothing was pinned.
 *
 * The invariant is one line long: the model is derived from the size of the
 * work, never from a name in the environment. There is no default model. Every
 * path below ends at either Jev, which weighs price against capability, or at
 * the catalogue arithmetic in selectOpenRouterModel, which weighs the same
 * thing without a network call. `OPENROUTER_MODEL` is read on exactly one path
 * - an operator who has explicitly set OPENROUTER_MODEL_PINNED - because that
 * is a decision someone made on purpose rather than a fallback the pipeline
 * made on its own.
 *
 * In order, for any request that reaches OpenRouter:
 *
 *   1. pinned      the operator froze the model on purpose.
 *   2. routed      Jev already answered for this request and the answer was
 *                  decisive. This is the normal path for /api/schema-design.
 *   3. on demand   nothing was pinned, so Jev is asked now, against the load
 *                  measured on the request actually being sent. This is the
 *                  scope guard's path, /api/data-migration's path, and the path
 *                  of a request whose routing call failed.
 *   4. derived     Jev is unreachable or not decisive, so the catalogue is
 *                  sorted in code: the cheapest entry that can actually hold
 *                  this prompt and finish this answer.
 *
 * Only 4 is a code decision, and it is the same decision 1-3 make - cheapest
 * model that is still good enough for the measured work - with capability held
 * constant instead of judged. It exists because a model chosen by the pipeline
 * has to come from somewhere when the router is down, and "the dearest model on
 * the list" is the one answer guaranteed to be both expensive and wrong.
 */

/*
 * Transport.
 *
 * Jev is reached through OpenRouter, on the same OPENROUTER_API_KEY as the
 * generation providers, so routing introduces no second credential.
 *
 * It is deliberately NOT reached through /chat/completions. Jev is a decisions
 * model and that endpoint rejects it outright with a 400; the /api/alpha/decisions
 * endpoint takes the state-plus-questions payload and answers with a weighted
 * choice.
 */
export const JEV_ENDPOINT: string =
    "https://openrouter.ai/api/alpha/decisions";

/*
 * Routing is advisory, so it gets a hard budget. A call that has not answered in
 * this long has told us nothing useful, and holding a request open for it would
 * cost more than choosing in code - which is exactly what selectOpenRouterModel
 * then does, with no network at all.
 */
export const JEV_TIMEOUT_MS: number =
    10_000;

export const JEV_MODEL_QUESTION_NAME: string =
    "openrouter_model";

/*
 * A routing model asked to spend money is making a trade-off it can be wrong
 * about, so its answer is not taken at face value. What is checked is not the
 * winner's absolute probability but how far it sits above the runner-up.
 *
 * An absolute bar is the wrong test for a nine-way question. Spread evenly,
 * nine options put the leader somewhere near 0.11, so any bar above that
 * rejects almost every large-workload decision and quietly hands the request
 * back to the most expensive model on the list - the opposite of what this
 * question is for. A real preference just looks flatter than a majority: 0.22
 * against 0.15 is a decision, and 0.13 against 0.12 is a shrug.
 */
export const OPENROUTER_MODEL_MIN_MARGIN: number =
    0.10;

/*
 * How much of the prompt's context comes back as an answer, for the callers
 * that have a request but no Oracle digest to count.
 *
 * These stages restate what they are given rather than summarising it, so the
 * answer tracks the schema in the context and not the instructions around it.
 * The figure is a ratio rather than a model-specific guess because the caller
 * only has one number, and because being wrong here is not fatal: it moves the
 * choice between two adjacent models, and the router - which is told the real
 * digest-derived figure whenever the route has one - is what actually decides.
 */
export const OUTPUT_TO_CONTEXT_RATIO: number =
    0.6;

/*
 * What a request costs to send and to answer, in tokens.
 *
 * `expectedOutputTokens` is not capped at the ceiling on purpose. A workload
 * whose answer cannot fit in one call is a fact about the request, and rounding
 * it down to make it fit would hide the one thing the operator needs to know.
 * What gets capped is the bill, in billedOutputTokens, because a truncated
 * answer is not billed for the tokens it never produced.
 */
export type ModelLoad = {
    stage: string;
    inputTokens: number;
    expectedOutputTokens: number;
    outputCeiling: number;
};

/*
 * A resolved model, and how it was arrived at.
 *
 * The source is reported rather than inferred, because the four paths are not
 * equally trustworthy and a caller that cannot tell them apart cannot audit
 * them: "jev" is a model someone reasoned about, "derived" is arithmetic on the
 * catalogue, and "pinned" is neither - it is an operator overriding both.
 */
export type ModelDecision = {
    model: string;
    source: ModelSource;
    probability: number;
    confidence: number;
    probabilities: Readonly<Record<string, number>>;

    /*
     * True only when a Jev answer was both offered and decisive. False for a
     * derived, pinned or missing answer, which is what separates "the router
     * chose this" from "the router was asked and did not have an answer".
     */
    routed: boolean;
};


/* ============================================================
 * Measuring the work
 * ==========================================================
 *
 * Measured from the request being sent, not inferred from configuration. The
 * prompt is the cost: it is what is billed, and it is the only input that
 * decides whether a context window is big enough.
 */

export function measureRequestLoad(
    request: AIRequest
): ModelLoad {

    const contextCharacters: number =
        (request.staticContext?.length ?? 0) +
        request.dynamicPrompt.length;

    const totalCharacters: number =
        request.systemPrompt.length +
        contextCharacters;

    /*
     * Four characters per token, the same conversion ai_client and the route's
     * own measurement both use. Three estimates of one request that disagree by
     * a factor would be worse than any of them being slightly wrong.
     */
    return {
        stage:
            request.responseSchemaName,

        inputTokens:
            Math.ceil(
                totalCharacters / 4
            ),

        expectedOutputTokens:
            Math.ceil(
                contextCharacters /
                    4 *
                    OUTPUT_TO_CONTEXT_RATIO
            ),

        outputCeiling:
            OPENROUTER_MAX_COMPLETION_TOKENS
    };
}


/*
 * The load as the router reads it: the same numbers in code, in words, so the
 * question is answered against figures rather than against a request to
 * estimate them.
 */
export function describeLoad(
    load: ModelLoad
): string {

    return [
        `about ${load.inputTokens} input tokens`,
        `about ${load.expectedOutputTokens} output tokens expected`,
        `the call is capped at ${load.outputCeiling} output tokens, so an answer above that cannot be completed in one call on any model`
    ].join(
        ", "
    );
}


/* ============================================================
 * Choosing in code
 * ==========================================================
 *
 * The same objective Jev is given - cheapest model that is still good enough -
 * with capability held constant, because there is no one here to judge it. Two
 * things are checked, and both are arithmetic on the published limits rather
 * than on anyone's opinion:
 *
 *   - the window has to hold the prompt AND the answer, since a model is
 *     billed for the whole exchange and cannot answer from a truncated prompt;
 *   - the model has to accept the output ceiling the provider sends with every
 *     call, because asking a model for more completion than it accepts is an
 *     error, not a smaller answer.
 *
 * Price is then the measured cost of THIS request - its input at the input
 * rate, its answer at the output rate - rather than the input rate alone. The
 * two are close for a short answer and far apart for a long one, and these
 * stages produce long ones.
 */

function billedOutputTokens(
    load: ModelLoad
): number {

    return Math.min(
        load.expectedOutputTokens,
        load.outputCeiling
    );
}


function requiredWindow(
    load: ModelLoad
): number {

    return load.inputTokens +
        billedOutputTokens(load);
}


function canServe(
    choice: OpenRouterModelChoice,
    load: ModelLoad
): boolean {

    return choice.contextWindow >=
            requiredWindow(load) &&
        choice.maxOutputTokens >=
            load.outputCeiling;
}


function costFor(
    choice: OpenRouterModelChoice,
    load: ModelLoad
): number {

    return load.inputTokens / 1_000_000 *
            choice.inputPricePerMillion +
        billedOutputTokens(load) / 1_000_000 *
            choice.outputPricePerMillion;
}


/*
 * The tier a load belongs to, on the same SMALL / MEDIUM / LARGE ladder the
 * provider decision uses and the catalogue prose already describes.
 *
 * Both halves of the load are checked, because a request can be small in one and
 * not the other: a short prompt over a large design still has a large document
 * to emit, and a long prompt with a short answer is a read, not a write. The
 * answer is the larger of the two, which is also the one that decides whether a
 * model runs out of room.
 *
 * The thresholds are the input side of pickDefaultProvider's in-code ladder,
 * raised by the fact that a model tier has to hold a whole document rather than
 * classify a sentence.
 */
function tierForLoad(
    load: ModelLoad
): ModelTier {

    const read: number =
        load.inputTokens;

    const write: number =
        load.expectedOutputTokens;

    if (
        read <= 4_000 &&
        write <= 2_000
    ) {
        return "small";
    }

    if (
        read <= 24_000 &&
        write <= 8_000
    ) {
        return "medium";
    }

    return "large";
}


/*
 * The cheapest catalogue entry that can serve this load, or - if the load is
 * larger than every window in the catalogue - the entry with the most room,
 * which is the only honest answer to a request that will not fit anywhere.
 *
 * A model is named here only after the catalogue has been sorted for this
 * specific request, so the id that comes out is a consequence of the work rather
 * than a constant in the code.
 *
 * Two filters, in this order, and the order is the point. Tier first: the
 * cheapest entry in the catalogue is also the smallest model on it, so a price
 * sort alone would send the largest schemas in the pipeline - the ones where a
 * wrong mapping costs the most downstream - to flash-lite, which is the exact
 * failure the router exists to prevent. Fit second: a model in the right tier
 * that cannot hold the prompt is not a candidate whatever its price, and if
 * that leaves nothing, every fitting model is back in play because a bigger
 * model is strictly better than a truncated answer.
 */
export function selectOpenRouterModel(
    load: ModelLoad
): string {

    if (
        load.expectedOutputTokens >
        load.outputCeiling
    ) {

        console.warn(
            `→ OpenRouter: ~${load.expectedOutputTokens} output tokens will not fit inside the ${load.outputCeiling} token ceiling, so this answer cannot complete in one call on any model in the catalogue`
        );
    }

    const requiredTier: ModelTier =
        tierForLoad(load);

    const order: readonly ModelTier[] =
        [
            "small",
            "medium",
            "large"
        ];

    const floor: number =
        order.indexOf(
            requiredTier
        );

    /*
     * Relaxed one tier at a time. A LARGE load with no large entry that fits is
     * still better served by a small model that fits than by a large one that
     * truncates, so the tier filter is a preference and the fit filter is the
     * rule.
     */
    for (
        let depth: number = floor;
        depth <= order.length - 1;
        depth += 1
    ) {

        const candidates: OpenRouterModelChoice[] =
            OPENROUTER_MODEL_CHOICES.filter(
                (
                    choice: OpenRouterModelChoice
                ): boolean =>
                    order.indexOf(
                        choice.tier
                    ) >= depth &&
                    canServe(
                        choice,
                        load
                    )
            );

        if (
            candidates.length === 0
        ) {
            continue;
        }

        let cheapest: OpenRouterModelChoice =
            candidates[0];

        for (
            const choice
            of candidates
        ) {

            if (
                costFor(
                    choice,
                    load
                ) <
                costFor(
                    cheapest,
                    load
                )
            ) {

                cheapest =
                    choice;
            }
        }

        return cheapest.model;
    }

    const widest: OpenRouterModelChoice =
        OPENROUTER_MODEL_CHOICES.reduce(
            (
                best: OpenRouterModelChoice,
                choice: OpenRouterModelChoice
            ): OpenRouterModelChoice =>
                choice.contextWindow >
                        best.contextWindow
                    ? choice
                    : best
        );

    console.warn(
        `→ OpenRouter: the ${load.stage} prompt needs ~${requiredWindow(load)} tokens of window and the widest entry is ${widest.model} at ${widest.contextWindow}, falling back to it as the only candidate that comes closest`
    );

    return widest.model;
}


/* ============================================================
 * Asking Jev
 * ==========================================================
 *
 * The model question, built from the catalogue in types.ts.
 *
 * The catalogue is the allowlist, the source of every price and limit, and the
 * thing Jev is choosing between - declared once, so the option offered, the
 * option validated, the option the code sorts on and the option documented
 * cannot drift apart.
 *
 * The instruction is where the cost/quality trade-off is set. "Cheapest" alone
 * would hand every request to flash-lite and quietly make the harder ones
 * worse, so the wording asks for the cheapest model that is still good enough
 * for the measured workload, and makes the price of being wrong explicit.
 */
export function buildModelQuestion(): {
    type: "choice";
    instructions: string;
    criteria: Record<string, string>;
} {

    const criteria: Record<string, string> = {};

    for (
        const choice
        of OPENROUTER_MODEL_CHOICES
    ) {

        criteria[choice.model] =
            `${describeModelCost(choice)}. ` +
                `For ${choice.tier.toUpperCase()} workloads. ` +
                `${formatTokens(choice.contextWindow)} token context window, ` +
                `accepts up to ${formatTokens(choice.maxOutputTokens)} output tokens. ` +
                choice.criteria;
    }

    return {
        type:
            "choice",

        instructions:
            "Which of these OpenRouter models should generate the answer for this request? Every option supports strict JSON-schema output, so judge on price against the measured workload only. Judge it on the numbers in the state: how many input tokens the prompt will actually cost, how many output tokens the answer has to fit in, and how large the schema involved is. Prefer the cheapest model that is still good enough for this much work. 'Good enough' has two parts, and failing either one makes the call a waste. The answer must be correct, and it must FIT: compare the expected answer against each model's output limit and the ceiling, because a model whose answer would be cut off has not saved anything, it has thrown away the whole call. A model whose context window is smaller than the prompt plus its answer cannot serve this request at all, whatever it costs. Escalate to a dearer model only when the workload genuinely needs it, and treat a rejected or malformed answer as more expensive than the call itself.",

        criteria
    };
}


/*
 * A single choice answer, as it comes back from the decisions endpoint.
 *
 * The endpoint types its own output, but the value still crossed a network and
 * came from a model, so it is read defensively rather than trusted. Every field
 * here is either a validated value or a zero, never an assumption.
 */
export type ChoiceAnswer = {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
};


/*
 * Reads the model question's answer, or throws. A missing or malformed answer
 * means this routing attempt produced nothing usable, which the caller decides
 * what to do about - the provider still has a catalogue to sort and a request
 * to serve.
 */
export function readChoice(
    answers: Record<string, unknown>,
    questionName: string
): ChoiceAnswer {

    const rawAnswer: unknown =
        answers[questionName];

    if (
        rawAnswer === null ||
        typeof rawAnswer !== "object"
    ) {
        throw new Error(
            `Jev returned no "${questionName}" answer`
        );
    }

    const answer: Record<string, unknown> =
        rawAnswer as Record<
            string,
            unknown
        >;

    const choice: unknown =
        answer.choice;

    if (
        typeof choice !== "string" ||
        choice.length === 0
    ) {
        throw new Error(
            `Jev returned an empty "${questionName}" choice`
        );
    }

    const rawConfidence: unknown =
        answer.confidence;

    const rawProbabilities: unknown =
        answer.probabilities;

    const probabilities: Record<
        string,
        number
    > =
        rawProbabilities !== null &&
        typeof rawProbabilities === "object"
            ? readProbabilities(
                rawProbabilities
            )
            : {};

    return {
        choice,

        confidence:
            typeof rawConfidence === "number" &&
            Number.isFinite(rawConfidence)
                ? Math.min(
                    1,
                    Math.max(
                        0,
                            rawConfidence
                        )
                    )
                : 0,

        probabilities
    };
}


/*
 * Whether a Jev answer is allowed to name the model, and why not when it is not.
 *
 * Two things disqualify a choice, and each is checked in code rather than
 * argued about in the prompt:
 *
 *   - a name outside the catalogue. Jev was never offered it, so either it has
 *     been retired from OpenRouter or the answer is not the answer. Sending an
 *     unoffered id to OpenRouter would cost a 404 to learn what the allowlist
 *     already knows.
 *   - a winner that is not meaningfully ahead of the runner-up, which means the
 *     router could not separate the top of the list from itself.
 */
export function evaluateChoice(
    answer: ChoiceAnswer
): {
    accepted: boolean;
    reason: string;
    probability: number;
} {

    const probability: number =
        answer.probabilities[answer.choice] ?? 0;

    if (
        !OPENROUTER_MODEL_IDS.has(
            answer.choice
        )
    ) {

        return {
            accepted:
                false,

            reason:
                `${answer.choice} is not in the model catalogue`,

            probability
        };
    }

    const lead: number =
        margin(answer);

    if (
        lead <
        OPENROUTER_MODEL_MIN_MARGIN
    ) {

        return {
            accepted:
                false,

            reason:
                `${answer.choice} at p=${probability.toFixed(3)} is not clearly ahead of the next option (margin ${lead.toFixed(3)} < ${OPENROUTER_MODEL_MIN_MARGIN})`,

            probability
        };
    }

    return {
        accepted:
            true,

        reason:
            "",

        probability
    };
}


/*
 * How far the winning option sits above the best of the rest.
 *
 * The choice itself is the winner by construction, so the margin is that
 * winner's probability minus the highest probability among the others. Reading
 * it off the distribution rather than the choice means it stays correct even
 * if the endpoint ever answers with a `choice` that is not the argmax.
 */
function margin(
    answer: ChoiceAnswer
): number {

    let runnerUp: number =
        0;

    for (
        const [name, value]
        of Object.entries(
            answer.probabilities
        )
    ) {

        if (
            name === answer.choice
        ) {
            continue;
        }

        if (
            value > runnerUp
        ) {
            runnerUp =
                value;
        }
    }

    const best: number =
        answer.probabilities[answer.choice] ?? 0;

    return best - runnerUp;
}


/*
 * Asks Jev which catalogue entry should serve this load, and nothing else.
 *
 * Used when nothing was pinned: the scope guard, /api/data-migration, and any
 * request whose one routing call failed. The provider question is deliberately
 * NOT asked here - there is no call to attach it to, and re-deriving a provider
 * from a prompt in code would be guessing at a decision that was never made.
 * What is asked is only the question whose absence would otherwise leave a
 * named model to come from nowhere.
 *
 * Returns undefined for every failure, including a valid answer that was not
 * decisive. The caller falls back to the catalogue arithmetic, which needs no
 * network and cannot fail.
 */
export async function askJevForModel(
    load: ModelLoad
): Promise<ModelDecision | undefined> {

    const body = {
        model:
            env.jevModel,

        state: {
            task:
                "openrouter_model_selection",

            stage:
                load.stage,

            input_load:
                describeLoad(load),

            expected_output_tokens:
                load.expectedOutputTokens,

            output_ceiling:
                load.outputCeiling
        },

        questions: {
            [JEV_MODEL_QUESTION_NAME]:
                buildModelQuestion()
        }
    };

    try {

        const response =
            await fetch(
                JEV_ENDPOINT,
                {
                    method:
                        "POST",

                    headers: {
                        Authorization:
                            `Bearer ${env.openrouterApiKey}`,

                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify(body),

                    signal:
                        AbortSignal.timeout(
                            JEV_TIMEOUT_MS
                        )
                }
            );

        const text: string =
            await response.text();

        if (
            !response.ok
        ) {
            throw new Error(
                `Jev returned HTTP ${response.status}: ${text.substring(0, 300)}`
            );
        }

        const parsed: unknown =
            JSON.parse(text);

        const record: Record<string, unknown> =
            toRecord(
                parsed,
                "Jev response was not an object"
            );

        const answers: Record<string, unknown> =
            toRecord(
                record.answers,
                "Jev returned no answers"
            );

        const answer: ChoiceAnswer =
            readChoice(
                answers,
                JEV_MODEL_QUESTION_NAME
            );

        const verdict =
            evaluateChoice(
                answer
            );

        if (
            !verdict.accepted
        ) {

            console.warn(
                `→ Jev: no usable model for the ${load.stage} request, ${verdict.reason}`
            );

            return undefined;
        }

        return {
            model:
                answer.choice,

            source:
                "jev-on-demand",

            probability:
                verdict.probability,

            confidence:
                answer.confidence,

            probabilities:
                answer.probabilities,

            routed:
                true
        };

    } catch (
        error: unknown
    ) {

        console.error(
            "→ Jev could not be reached for a model choice, the catalogue is sorted in code instead:",
            error
        );

        return undefined;
    }
}


/*
 * Resolves the model for a request that is reaching OpenRouter right now.
 *
 * This is the provider's entry point, and the order is the whole point: a model
 * already chosen for this request is used, and only a request with no choice at
 * all costs a routing round-trip. An OpenRouter call reached by fallback from
 * Groq or Gemini already carries its model's decision down with it, so the
 * common case spends nothing here.
 */
export async function resolveOpenRouterModel(
    request: AIRequest,
    routedModel?: RoutedOpenRouterModel
): Promise<ModelDecision> {

    if (
        env.openrouterModelPinned
    ) {

        console.log(
            "→ OpenRouter: OPENROUTER_MODEL_PINNED is set, generation is frozen on the configured model and the router is not consulted"
        );

        return {
            model:
                env.openrouterModel,

            source:
                "pinned",

            probability:
                0,

            confidence:
                0,

            probabilities:
                {},

            routed:
                false
        };
    }

    if (
        routedModel !== undefined
    ) {

        return {
            model:
                routedModel.model,

            source:
                routedModel.source,

            probability:
                0,

            confidence:
                0,

            probabilities:
                {},

            routed:
                routedModel.source ===
                    "jev"
        };
    }

    const load: ModelLoad =
        measureRequestLoad(
            request
        );

    const asked =
        await askJevForModel(
            load
        );

    if (
        asked !== undefined
    ) {

        return asked;
    }

    return {
        model:
            selectOpenRouterModel(
                load
            ),

        source:
            "derived",

        probability:
            0,

        confidence:
            0,

        probabilities:
            {},

        routed:
            false
    };
}


/* ============================================================
 * Helpers
 * ==========================================================
 */

/*
 * A probability map as one ranked line, so the whole catalogue is readable at a
 * glance in the server log. Empty when the answer carried no distribution,
 * which is the case for a pinned model and for a derived one.
 */
export function describeDistribution(
    probabilities: Readonly<Record<string, number>>
): string {

    const entries: [string, number][] =
        Object.entries(
            probabilities
        );

    if (
        entries.length === 0
    ) {

        return "none reported";
    }

    entries.sort(
        (
            left: [string, number],
            right: [string, number]
        ): number =>
            right[1] - left[1]
    );

    return entries
        .map(
            (
                entry: [string, number]
            ): string =>
                `${entry[0]}=${entry[1].toFixed(3)}`
        )
        .join(
            ", "
        );
}


/*
 * Window sizes as the router reads them. Pinned to one locale because the same
 * number formatted two ways in one payload is a distraction, and this is the
 * only place a locale is chosen.
 */
function formatTokens(
    value: number
): string {

    return value.toLocaleString(
        "en-US"
    );
}


/*
 * Probabilities that are not numbers are not probabilities. A missing or
 * non-finite one is zeroed rather than dropped, so every option in the map
 * still has a value and the map can be logged and compared without a guard at
 * each use.
 */
function readProbabilities(
    raw: object
): Record<string, number> {

    const probabilities: Record<
        string,
        number
    > = {};

    for (
        const [name, value]
        of Object.entries(
            raw
        )
    ) {

        if (
            typeof value === "number" &&
            Number.isFinite(value)
        ) {
            probabilities[name] = value;
        } else {
            probabilities[name] = 0;
        }
    }

    return probabilities;
}


function toRecord(
    value: unknown,
    message: string
): Record<string, unknown> {

    if (
        value === null ||
        typeof value !== "object"
    ) {
        throw new Error(
            message
        );
    }

    return value as Record<
        string,
        unknown
    >;
}
