import { z } from "zod";
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
