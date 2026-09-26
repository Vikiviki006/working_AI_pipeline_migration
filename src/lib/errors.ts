/*
 * Typed failures so a route can distinguish "the caller sent something invalid"
 * (400) from "the model misbehaved" (502) and "the providers are down" (503),
 * instead of collapsing everything into a 500.
 */

export class RequestValidationError extends Error {
    public readonly details: string[];

    constructor(
        message: string,
        details: string[] = []
    ) {
        super(message);
        this.name = "RequestValidationError";
        this.details = details;
    }
}

export class ProviderOutputError extends Error {
    public readonly provider: string;
    public readonly details: unknown;

    constructor(
        message: string,
        provider: string,
        details: unknown = null
    ) {
        super(message);
        this.name = "ProviderOutputError";
        this.provider = provider;
        this.details = details;
    }
}

export class ProviderUnavailableError extends Error {
    public readonly failures: unknown;

    constructor(
        message: string,
        failures: unknown = null
    ) {
        super(message);
        this.name = "ProviderUnavailableError";
        this.failures = failures;
    }
}
