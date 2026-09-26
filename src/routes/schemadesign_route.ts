import {
    Router,
    type Request,
    type Response
} from "express";

import {
    generateSchemaDesign
} from "../ai/services/schema_design_service.js";

import {
    SchemaDesignRequest
} from "../ai/schemas/schemadesign_request_zod.js";

import { respondWithError } from "./route_helpers.js";

import {
    MANIFEST_PATH,
    POSTGRES_SCHEMA_DIR,
    ROOT
} from "../lib/file_layout.js";

export const schemaDesignRouter =
    Router();

/*
 * Stage 1 of 3.
 *
 * POST /api/schema-design
 *
 * Input:
 *   selected_schema  Oracle table metadata
 *   current_design   optional in-flight design from a UI
 *   user_query       natural-language split / merge request
 *
 * Output: the final PostgreSQL target_schema, which stage 2 diffs.
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
            const response =
                await generateSchemaDesign(
                    parsed.data
                );

            const result =
                response.result as {
                    status: string;
                    summary: string;
                    issue_reason: string;
                    target_schema: unknown;
                };

            /*
             * A rejected design has no target schema, so there is nothing
             * to diff downstream. Surface that explicitly instead of
             * returning an empty artifact bundle.
             */
            res.status(200).json({
                provider:
                    response.provider,

                result,

                layout: {
                    target_schema:
                        `${POSTGRES_SCHEMA_DIR}/target_schema.json`,
                    manifest: MANIFEST_PATH
                },

                next:
                    result.status ===
                        "not_recommended"
                        ? null
                        : {
                            step: "table-management",
                            method: "POST",
                            path: `${ROOT}/table-management`,
                            body: {
                                source_database:
                                    "oracle",
                                target_database:
                                    "postgresql",
                                source_schema:
                                    parsed.data.selected_schema,
                                target_schema:
                                    result.target_schema,
                                user_query:
                                    parsed.data.user_query
                            }
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
