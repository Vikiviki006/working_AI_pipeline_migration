import { z } from "zod";

export const SchemaDesignRequest = z.object({
    selected_schema: z.unknown().refine(
        (val) => val !== undefined && val !== null,
        { message: "selected_schema is required" }
    ),
    current_design: z.unknown().optional(),
    user_query: z.string().min(1, "user_query cannot be empty")
});

export type SchemaDesignRequest = z.infer<typeof SchemaDesignRequest>;