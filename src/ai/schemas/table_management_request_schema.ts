import { z } from "zod";

/*
 * Route 2 request: the Oracle source schema plus the PostgreSQL schema
 * designed by route 1. user_query is the design intent, carried through for
 * context and for the summary; it is optional because a design may be
 * accepted without one.
 */
export const tableManagementRequestSchema = z.object({
    source_database: z.literal("oracle"),
    target_database: z.literal("postgresql"),
    source_schema: z.unknown(),
    target_schema: z.unknown(),
    user_query: z
        .string()
        .optional()
});

export type TableManagementRequest =
    z.infer<
        typeof tableManagementRequestSchema
    >;
