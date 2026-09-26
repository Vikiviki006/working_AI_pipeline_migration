import type {
    Response
} from "express";

import {
    ProviderOutputError,
    ProviderUnavailableError,
    RequestValidationError
} from "../lib/errors.js";

/*
 * Maps a thrown error onto the right status code.
 *
 *   RequestValidationError   -> 400  caller sent something invalid
 *   ProviderOutputError      -> 502  the model produced unusable output
 *   ProviderUnavailableError -> 503  both providers are down
 *   anything else            -> 500
 */
export function respondWithError(
    res: Response,
    error: unknown,
    fallbackMessage: string
): void {

    if (
        error instanceof RequestValidationError
    ) {
        res.status(400).json({
            error: error.message,
            details: error.details
        });

        return;
    }

    if (
        error instanceof ProviderOutputError
    ) {
        console.error(
            `${fallbackMessage}: provider output was rejected`,
            error.details
        );

        res.status(502).json({
            error: error.message,
            provider: error.provider,
            details: error.details
        });

        return;
    }

    if (
        error instanceof ProviderUnavailableError
    ) {
        res.status(503).json({
            error: error.message,
            details: error.failures
        });

        return;
    }

    const message: string =
        error instanceof Error
            ? error.message
            : fallbackMessage;

    console.error(
        `${fallbackMessage}:`,
        error
    );

    res.status(500).json({
        error: fallbackMessage,
        message
    });
}
