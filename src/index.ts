import "./config/env.js";

import express from "express";

import { env } from "./config/env.js";

import {
    schemaDesignRouter
} from "./routes/schemadesign_route.js";

import {
    dataMigrationRouter
} from "./routes/data_migration_route.js";

import {
    ROOT
} from "./lib/file_layout.js";

const app =
    express();

app.use(
    express.json({
        limit: "10mb"
    })
);
app.use(
    "/api",
    schemaDesignRouter,
    dataMigrationRouter
);

app.get(
    "/health",
    (_req,res): void => {

        res.status(200).json({
            success: true,
            message: "Server is running",
            stages: [
                "POST /api/schema-design",
                "POST /api/data-migration"
            ],
            guards: [
                "Query scope guard (POST /api/schema-design)",
                "Build-plan cross-check (POST /api/schema-design)",
                "SQL statement cross-check (both routes)"
            ],
            routing: {
                model: env.jevModel,
                transport: "openrouter /api/alpha/decisions",
                scope: "one decision per request, pinned across stages"
            }
        });
    }
);

app.get(
    "/api/layout",
    (_req,res): void => {

        res.status(200).json({
            bundle_root: ROOT,

            folders: {
                oracle: `${ROOT}/oracle`,
                postgres: `${ROOT}/postgres`
            },

            schema_design: {
                route: "POST /api/schema-design",
                input: [
                    "selected_schema",
                    "current_design",
                    "user_query"
                ],
                stages: [
                    {
                        name: "query_scope_intent",
                        prompt:
                            "query_scope_intent_prompt",
                        input: [
                            "oracle schema digest",
                            "current_design",
                            "user_query"
                        ],
                        output: [
                            "scope",
                            "intent",
                            "reason",
                            "resolved_user_query",
                            "operations"
                        ],
                        runs_before:
                            "jev routing",
                        short_circuits_when:
                            "scope is 'OUT_OF_SCOPE' (HTTP 422, OUT_OF_SCOPE_REQUEST) or 'UNCERTAIN' (HTTP 422, UNCERTAIN_DATABASE_REQUEST)",
                        notes: [
                            "resolved_user_query is the request rewritten as one unambiguous instruction, with every pronoun resolved against the Oracle metadata.",
                            "operations is the discrete work breakdown, used by the routing step.",
                            "The Oracle metadata reaches this stage as a digest, not as the raw document."
                        ]
                    },
                    {
                        name: "jev routing",
                        prompt:
                            "inline in routes/schemadesign_route.ts",
                        input: [
                            "resolved_user_query",
                            "operations",
                            "oracle schema digest"
                        ],
                        output: [
                            "provider",
                            "confidence",
                            "workload",
                            "probabilities"
                        ],
                        transport:
                            "OpenRouter /api/alpha/decisions on OPENROUTER_API_KEY, model JEV_MODEL. Not /chat/completions: Jev is a decisions model and that endpoint rejects it.",
                        runs_before:
                            "schema_design",
                        notes: [
                            "Called once per request, not once per stage. The chosen provider is pinned onto schema_design and table_management.",
                            "Bounded by a 10s timeout. A Jev failure is not a request failure: nothing is pinned and callAI chooses in code.",
                            "This output is a preference, not a permission. The guards apply unchanged."
                        ]
                    },
                    {
                        name: "schema_design",
                        prompt:
                            "schemadesign_prompt",
                        input: [
                            "selected_schema",
                            "current_design",
                            "user_query"
                        ],
                        output: [
                            "status",
                            "summary",
                            "issue_reason",
                            "target_schema"
                        ]
                    },
                    {
                        name: "table_management",
                        prompt:
                            "table_management_prompt",
                        input: [
                            "source_schema",
                            "target_schema",
                            "user_query"
                        ],
                        output: [
                            "source",
                            "target",
                            "table_management",
                            "files",
                            "plan",
                            "summary"
                        ],
                        build_mode:
                            "The PostgreSQL target is created from empty, so every target table gets a CREATE TABLE and keys are added as separate ALTER TABLE ... ADD CONSTRAINT statements. No ALTER COLUMN, ADD COLUMN, DROP COLUMN, RENAME or USING cast is valid.",
                        runs_when:
                            "schema_design.status is 'recommended' or 'needs_change'",
                        short_circuits_when:
                            "schema_design.status is 'not_recommended' (HTTP 422, design response only)"
                    }
                ],
                statement_kinds: [
                    "CREATE SCHEMA",
                    "CREATE TABLE",
                    "ALTER TABLE",
                    "CREATE INDEX",
                    "CREATE UNIQUE INDEX",
                    "CREATE SEQUENCE",
                    "CREATE TYPE",
                    "DROP INDEX",
                    "DROP TABLE"
                ]
            },

            data_migration: {
                route: "POST /api/data-migration",
                input: [
                    "source_schema",
                    "target_schema",
                    "user_query"
                ],
                output: [
                    "source",
                    "target",
                    "data_extraction",
                    "data_management",
                    "files",
                    "placeholder",
                    "summary"
                ],
                notes: [
                    "data_extraction holds Oracle SELECT statements.",
                    "data_management holds PostgreSQL INSERT templates.",
                    "The two arrays are parallel and equal in length.",
                    `Row values are injected at runtime through ${"${VALUES_PLACEHOLDER}"}.`
                ]
            }
        });
    }
);

app.use(
    (
        _req,
        res
    ): void => {

        res.status(404).json({
            success: false,
            message: "Route not found"
        });
    }
);

const PORT: number =
    Number(
        process.env.PORT ?? "3000"
    );

if (
    !Number.isInteger(PORT) ||
    PORT <= 0 ||
    PORT > 65535
) {
    throw new Error(
        "Invalid PORT configuration"
    );
}

const server =
    app.listen(
        PORT,
        (): void => {
            console.log(
                `Server running on http://localhost:${PORT}`
            );
            console.log(
                "  POST /api/schema-design     design target schema, then"
            );
            console.log(
                "  POST /api/data-migration    SELECT / INSERT templates"
            );
        }
    );

server.on(
    "error",
    (
        error: NodeJS.ErrnoException
    ): void => {

        console.error(
            "HTTP SERVER ERROR:",
            error.message
        );

        if (error.code === "EADDRINUSE") {
            console.error(
                `Port ${PORT} is already in use. Stop the other process or set PORT to a free port.`
            );
        }
        process.exit(1);
    }
);

server.on(
    "close",
    (): void => {

        console.log(
            "HTTP SERVER CLOSED"
        );
    }
);
