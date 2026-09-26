import "./config/env.js";

import express from "express";

import {
    schemaDesignRouter
} from "./routes/schemadesign_route.js";

import {
    tableManagementRouter
} from "./routes/table_management_route.js";

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

/*
 * Three-stage Oracle -> PostgreSQL migration pipeline.
 *
 *   1  POST /api/schema-design     Oracle metadata + split/merge request
 *                                  -> final PostgreSQL target schema
 *   2  POST /api/table-management  verified schema diff
 *                                  -> CREATE / ALTER / DROP
 *   3  POST /api/data-migration    paired Oracle SELECT + PostgreSQL INSERT
 *
 * Each stage returns its validated JSON plus the file path every statement
 * would occupy in the migration bundle.
 */
app.use(
    "/api",
    schemaDesignRouter,
    tableManagementRouter,
    dataMigrationRouter
);

app.get(
    "/health",
    (
        _req,
        res
    ): void => {

        res.status(200).json({
            success: true,
            message: "Server is running",
            stages: [
                "POST /api/schema-design",
                "POST /api/table-management",
                "POST /api/data-migration"
            ]
        });
    }
);

/*
 * Describes the bundle layout and the artifact contract, so a consumer does
 * not have to read the source to discover the folder names.
 */
app.get(
    "/api/layout",
    (
        _req,
        res
    ): void => {

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
                output: [
                    "status",
                    "summary",
                    "issue_reason",
                    "target_schema"
                ]
            },

            table_management: {
                route: "POST /api/table-management",
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
                    "diff",
                    "summary"
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

            console.log("");
            console.log("==============================");
            console.log(
                "ORACLE -> POSTGRES MIGRATION AI"
            );
            console.log("==============================");
            console.log(
                `Server running on http://localhost:${PORT}`
            );
            console.log("");
            console.log(
                "  1  POST /api/schema-design     design the target schema"
            );
            console.log(
                "  2  POST /api/table-management  CREATE / ALTER / DROP"
            );
            console.log(
                "  3  POST /api/data-migration    SELECT / INSERT templates"
            );
            console.log("");
            console.log(
                "      GET  /api/layout            artifact contract"
            );
            console.log(
                "      GET  /health"
            );
            console.log("");
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

        /*
         * "listening" is emitted asynchronously, so a bind failure surfaces
         * here after the startup banner has already printed. Exiting
         * non-zero keeps a failed bind from looking like a healthy server.
         */
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
