import {
    Router,
    type Request,
    type Response
} from "express";

import {
    generateDataMigrationQueries
} from "../ai/services/data_migration_service.js";

import {
    dataMigrationRequestSchema
} from "../ai/schemas/data_migration_request_schema.js";

import { respondWithError } from "./route_helpers.js";

import {
    MANIFEST_PATH,
    ORACLE_DATA_DIR,
    POSTGRES_DML_DIR
} from "../lib/file_layout.js";

export const dataMigrationRouter =
    Router();

dataMigrationRouter.post(
    "/data-migration",

    async (
        req: Request,
        res: Response
    ): Promise<void> => {

        const parsed =
            dataMigrationRequestSchema.safeParse(
                req.body
            );

        if (!parsed.success) {
            res.status(400).json({
                error:
                    "Invalid data-migration request",

                details:
                    parsed.error.format()
            });

            return;
        }

        try {
            const response =
                await generateDataMigrationQueries(
                    parsed.data
                );

            res.status(200).json({
                provider:
                    response.provider,

                result:
                    response.result,

                layout: {
                    extraction: ORACLE_DATA_DIR,
                    management: POSTGRES_DML_DIR,
                    manifest: MANIFEST_PATH
                }
            });

        } catch (
            error: unknown
        ) {
            respondWithError(
                res,
                error,
                "Data migration query generation failed"
            );
        }
    }
);
