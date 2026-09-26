import {
    Router,
    type Request,
    type Response
} from "express";

import {
    generateTableManagement
} from "../ai/services/table_management_service.js";

import {
    tableManagementRequestSchema
} from "../ai/schemas/table_management_request_schema.js";

import { respondWithError } from "./route_helpers.js";

import {
    MANIFEST_PATH,
    POSTGRES_DDL_DIR,
    POSTGRES_SCHEMA_DIR
} from "../lib/file_layout.js";

export const tableManagementRouter =
    Router();

/*
 * Stage 2 of 3.
 *
 * POST /api/table-management
 *
 * Input:
 *   source_schema  Oracle metadata
 *   target_schema  the target_schema produced by /api/schema-design
 *   user_query     the design intent, optional
 *
 * Both schemas are verified and diffed in code first. The model only phrases
 * the DDL for that verified diff, and the statements are then re-checked
 * against it.
 *
 * Output:
 *   {
 *     "source": "oracle",
 *     "target": "postgresql",
 *     "table_management": [ "CREATE TABLE ...;", "ALTER TABLE ...;", "DROP TABLE ...;" ],
 *     "files": [ { "path": "migration/postgres/ddl/001_create_table_departments.sql", ... } ],
 *     "diff": { "created_tables": [], "altered_tables": [], "dropped_tables": [], "unchanged_tables": [] },
 *     "summary": "..."
 *   }
 */
tableManagementRouter.post(
    "/table-management",

    async (
        req: Request,
        res: Response
    ): Promise<void> => {

        const parsed =
            tableManagementRequestSchema.safeParse(
                req.body
            );

        if (!parsed.success) {
            res.status(400).json({
                error:
                    "Invalid table-management request",

                details:
                    parsed.error.format()
            });

            return;
        }

        try {
            const response =
                await generateTableManagement(
                    parsed.data
                );

            res.status(200).json({
                provider:
                    response.provider,

                result:
                    response.result,

                layout: {
                    ddl: POSTGRES_DDL_DIR,
                    target_schema:
                        `${POSTGRES_SCHEMA_DIR}/target_schema.json`,
                    manifest: MANIFEST_PATH
                }
            });

        } catch (
            error: unknown
        ) {
            respondWithError(
                res,
                error,
                "Table management failed"
            );
        }
    }
);
