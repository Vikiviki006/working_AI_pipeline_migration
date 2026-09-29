import "./config/env.js";
import express from "express";
import { env } from "./config/env.js";
import {
    OPENROUTER_MAX_COMPLETION_TOKENS
} from "./types/types.js";
import {
    schemaDesignRouter
} from "./routes/schemadesignRoute.js";
import {
    dataMigrationRouter
} from "./routes/dataMigrationRoute.js";
const app =express();
app.use(express.json({limit: "10mb"})
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
                scope: "one decision per request, pinned across stages",
                decides: [
                    "which provider serves the request",
                    "which OpenRouter model that provider calls"
                ],
                trace:
                    "POST /api/schema-design returns a models array, one entry per stage, naming the provider and model that actually served it. These are the same as the decision only while nothing failed: a stage that falls through the chain is served by a different provider.",
                openrouter_model: {
                    selected_by:
                        "Jev, from the catalogue in types.ts",
                    pinned:
                        env.openrouterModelPinned,
                    pinned_model:
                        env.openrouterModel,
                    output_ceiling:
                        OPENROUTER_MAX_COMPLETION_TOKENS
                }
            }
        });
    }
);
app.use((_req,res): void => {
        res.status(404).json({
            success: false,
            message: "Route not found"
        });
    }
);

const PORT: number =Number(process.env.PORT ?? "3000");

if (!Number.isInteger(PORT) ||PORT <= 0 ||PORT > 65535) {
    throw new Error(
        "Invalid PORT configuration"
    );
}

const server =
    app.listen(
        PORT,
        (): void => {
            console.log(`Server running on http://localhost:${PORT}`);
            console.log("  POST /api/schema-design     design target schema, then");
            console.log("  POST /api/data-migration    SELECT / INSERT templates");
        }
    );

server.on(
    "error",
    (error: NodeJS.ErrnoException): void => {
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