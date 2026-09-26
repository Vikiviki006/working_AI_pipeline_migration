import { z } from "zod";

/*
 * Route 3 request: Oracle metadata and PostgreSQL metadata, as captured from
 * both engines. user_query is an optional filter/scope instruction.
 */
export const dataMigrationRequestSchema = z.object({
    source_database: z.literal("oracle"),
    target_database: z.literal("postgresql"),

    source_schema: z.unknown(),

    target_schema: z.unknown(),

    user_query: z
        .string()
        .optional()
});

export type DataMigrationRequest =
    z.infer<
        typeof dataMigrationRequestSchema
    >;
