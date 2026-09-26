import {
    Router,
    type Request,
    type Response
} from "express";

import {
    runSchemaMigration
} from "../ai/services/schema_migration_service.js";

import {
    SchemaDesignRequest
} from "../ai/schemas/schemadesign_request_zod.js";

import { respondWithError } from "./route_helpers.js";

import {
    MANIFEST_PATH,
    ORACLE_SCHEMA_DIR,
    POSTGRES_DDL_DIR,
    POSTGRES_SCHEMA_DIR,
    ROOT
} from "../lib/file_layout.js";

export const schemaDesignRouter =
    Router();

/*
 * Stages 1 and 2 of the pipeline, chained.
 *
 * POST /api/schema-design
 *
 * Input:
 *   selected_schema  Oracle table metadata
 *   current_design   optional in-flight design from a UI
 *   user_query       natural-language split / merge request
 *
 * Stage 1 designs the final PostgreSQL target schema. If the design is applied
 * ("recommended" or "needs_change"), stage 2 verifies that schema, diffs it
 * against Oracle, and emits the CREATE / ALTER / DROP that applies it. A
 * rejected design ("not_recommended") applies nothing, so the design response
 * is returned on its own as a 422 and stage 2 never runs.
 *
 * Success:
 *   {
 *     "result": {
 *       "schema_design":    { "status", "summary", "issue_reason", "target_schema" },
 *       "table_management": { "source", "target", "table_management", "diff", "summary" },
 *       "files": [ ... ]
 *     }
 *   }
 */
schemaDesignRouter.post(
    "/schema-design",

    async (
        req: Request,
        res: Response
    ): Promise<void> => {

        const parsed =
            SchemaDesignRequest.safeParse(
                req.body
            );

        if (!parsed.success) {
            res.status(400).json({
                error:
                    "Invalid request body",

                details:
                    parsed.error.format()
            });

            return;
        }

        try {
            const result =
                await runSchemaMigration(
                    parsed.data
                );

            res.status(200).json({
                result,

                layout: {
                    bundle_root: ROOT,
                    source_schema:
                        `${ORACLE_SCHEMA_DIR}/source_schema.json`,
                    target_schema:
                        `${POSTGRES_SCHEMA_DIR}/target_schema.json`,
                    ddl: POSTGRES_DDL_DIR,
                    manifest: MANIFEST_PATH
                }
            });

        } catch (
            error: unknown
        ) {
            respondWithError(
                res,
                error,
                "Schema design failed"
            );
        }
    }
);
