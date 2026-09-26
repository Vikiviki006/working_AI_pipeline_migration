import { z } from "zod";

const ColumnSchema = z.object({
    columnName: z.string(),
    dataType: z.string(),
    dataLength: z.number().int(),
    dataPrecision: z.number().int(),
    dataScale: z.number().int(),
    nullable: z.enum(["Y", "N"]),
    dataDefault: z.string(),
    columnId: z.number().int()
}).strict();

const PrimaryKeySchema = z.object({
    constraintName: z.string(),
    columns: z.array(z.string())
}).strict();

const ForeignKeySchema = z.object({
    constraintName: z.string(),
    columns: z.array(z.string()),
    referencedTable: z.string(),
    referencedColumns: z.array(z.string())
}).strict();

const TableSchema = z.union([
    z.object({
        tableName: z.string(),
        columns: z.array(ColumnSchema),
        primaryKey: PrimaryKeySchema,
        foreignKeys: z.array(ForeignKeySchema)
    }).strict(),
    // If Groq ever stringifies a table object again, this catches and
    // surfaces it clearly instead of crashing deep in .strict() parsing.
    z.string().transform((_val, ctx) => {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Table entry was returned as a JSON string instead of an object — provider output was malformed."
        });
        return z.NEVER;
    })
]);

export const SchemaDesignResponse = z.object({
    status: z.enum(["recommended", "needs_change", "not_recommended"]),
    summary: z.string(),
    issue_reason: z.string(),

    target_schema: z.object({
        tables: z.array(TableSchema)
    }).strict()
}).strict();

export type SchemaDesignResponse = z.infer<typeof SchemaDesignResponse>;