import assert from "node:assert/strict";
import { test } from "node:test";

import {
    PROCEEDING_DESIGN_STATUSES,
    shouldGenerateTableManagement
} from "../ai/services/schema_migration_service.js";

import {
    DesignRejectedError,
    ProviderOutputError,
    RequestValidationError
} from "./errors.js";

/*
 * The gate between the two chained stages.
 *
 * "recommended" and "needs_change" both carry a complete, valid target_schema,
 * so stage 2 must run for either. "not_recommended" applies nothing, so there
 * is nothing to verify or diff and the call must short-circuit.
 */
test("stage 2 runs for recommended and needs_change", () => {
    assert.equal(
        shouldGenerateTableManagement("recommended"),
        true
    );

    assert.equal(
        shouldGenerateTableManagement("needs_change"),
        true
    );
});

test("stage 2 does not run for not_recommended", () => {
    assert.equal(
        shouldGenerateTableManagement("not_recommended"),
        false
    );
});

test("the proceeding set contains exactly the applied statuses", () => {
    assert.deepEqual(
        [...PROCEEDING_DESIGN_STATUSES].sort(),
        ["needs_change", "recommended"]
    );
});

test("error types stay distinguishable so status codes cannot collide", () => {
    const client = new RequestValidationError("bad", [
        "detail"
    ]);
    const rejected = new DesignRejectedError(
        "refused",
        { status: "not_recommended" }
    );
    const provider = new ProviderOutputError(
        "bad output",
        "groq"
    );

    assert.ok(
        client instanceof Error &&
            !(client instanceof DesignRejectedError) &&
            !(client instanceof ProviderOutputError)
    );

    assert.ok(
        rejected instanceof DesignRejectedError &&
            !(rejected instanceof RequestValidationError)
    );

    assert.ok(
        provider instanceof ProviderOutputError &&
            !(provider instanceof DesignRejectedError)
    );
});
