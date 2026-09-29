import { z } from "zod";

import {
    DDL_KINDS,
    ddlTargetTable,
    findBindParameters,
    findInlinedTableConstraints,
    findColumnMutation,
    indexName,
    containsDml,
    containsSelect,
    isDdlStatement,
    splitSqlStatements,
    statementKind
} from "../../lib/sqlGuards.js";

const DDL_KIND_VALUES: string[] = [
    ...DDL_KINDS
];

/*
 * Statement array with context-free SQL checks. Schema-aware checks
 * (object existence, diff coverage) run in the service, which owns the
 * verified metadata.
 */
function buildTableManagementArraySchema(
    label: string
): z.ZodType<string[]> {

    return z
        .array(z.string())
        .superRefine(
            (
                statements: string[],
                context: z.RefinementCtx
            ): void => {

                for (
                    let index = 0;
                    index < statements.length;
                    index += 1
                ) {
                    const raw: string =
                        statements[index];

                    const at = (
                        message: string
                    ): void => {
                        context.addIssue({
                            code: "custom",
                            path: [index],
                            message
                        });
                    };

                    if (raw.trim().length === 0) {
                        at(
                            `${label}[${index}] is empty`
                        );
                        continue;
                    }

                    /* Exactly one statement per element. */
                    const parts: string[] =
                        splitSqlStatements(raw);

                    if (parts.length !== 1) {
                        at(
                            `${label}[${index}] must contain exactly one SQL statement, found ${parts.length}`
                        );
                        continue;
                    }

                    const sql: string = parts[0];
                    const kind: string =
                        statementKind(sql);

                    if (!isDdlStatement(sql)) {
                        at(
                            `${label}[${index}] has unsupported statement kind "${kind}". Allowed: ${DDL_KIND_VALUES.join(", ")}`
                        );
                        continue;
                    }

                    if (containsDml(sql)) {
                        at(
                            `${label}[${index}] contains a data-manipulation keyword. DDL must be structural only.`
                        );
                        continue;
                    }

                    if (containsSelect(sql)) {
                        at(
                            `${label}[${index}] contains SELECT. DDL must be structural only.`
                        );
                        continue;
                    }

                    if (findBindParameters(sql).length > 0) {
                        at(
                            `${label}[${index}] contains a bind parameter. DDL must not carry runtime values.`
                        );
                        continue;
                    }

                    if (
                        !raw.trimEnd().endsWith(";")
                    ) {
                        at(
                            `${label}[${index}] must be terminated by a single semicolon`
                        );
                        continue;
                    }

                    if (
                        /;\s*;/.test(raw)
                    ) {
                        at(
                            `${label}[${index}] must not contain a doubled semicolon`
                        );
                        continue;
                    }

                    /*
                     * A CREATE TABLE may only declare columns. Keys are
                     * separate ALTER TABLE ... ADD CONSTRAINT statements so a
                     * foreign key can reference a table created later in the
                     * array.
                     */
                    if (
                        kind === "CREATE TABLE"
                    ) {
                        const inlined: string[] =
                            findInlinedTableConstraints(
                                sql
                            );

                        if (
                            inlined.length > 0
                        ) {
                            at(
                                `${label}[${index}] inlines a table constraint (${inlined.join(", ")}) in the CREATE TABLE body. Keys must be separate ALTER TABLE ... ADD CONSTRAINT statements.`
                            );
                            continue;
                        }
                    }

                    /*
                     * The target database is built from empty, so there is no
                     * existing column to retype, add, drop or rename. Those
                     * statements reference a relation that does not exist and
                     * would fail at execution.
                     */
                    if (
                        kind === "ALTER TABLE"
                    ) {
                        const mutation: string | null =
                            findColumnMutation(sql);

                        if (
                            mutation !== null
                        ) {
                            at(
                                `${label}[${index}] is a column mutation (${mutation}). The target database is created from empty, so columns are declared in CREATE TABLE and never altered.`
                            );
                            continue;
                        }
                    }

                    /*
                     * A table-level statement must name a resolvable
                     * object, otherwise the statement is unverifiable.
                     */
                    const target: string | null =
                        ddlTargetTable(sql);

                    const named: string | null =
                        target ?? indexName(sql);

                    if (
                        kind !== "CREATE SCHEMA" &&
                        named === null
                    ) {
                        at(
                            `${label}[${index}] does not name a resolvable object`
                        );
                    }
                }
            }
        );
}

const tableManagementArraySchema =
    buildTableManagementArraySchema(
        "table_management"
    );

export const tableManagementResponseSchema =
    z.object({
        source: z.literal("oracle"),
        target: z.literal("postgresql"),
        table_management:
            tableManagementArraySchema,
        summary: z.string()
    });

export type TableManagementResponse =
    z.infer<
        typeof tableManagementResponseSchema
    >;

export const tableManagementJsonSchema:
    Record<string, unknown> = {
    type: "object",

    properties: {
        source: {
            type: "string",
            enum: ["oracle"]
        },

        target: {
            type: "string",
            enum: ["postgresql"]
        },

        table_management: {
            type: "array",

            description:
                "One dependency-safe PostgreSQL DDL statement per element. Each element is a single statement string terminated by exactly one semicolon. Empty array is valid.",

            items: {
                type: "string",

                description:
                    "A single PostgreSQL DDL statement, for example CREATE TABLE public.departments (department_id INTEGER NOT NULL);"
            }
        },

        summary: {
            type: "string",

            description:
                "One sentence naming the counts of created, altered and dropped objects."
        }
    },

    required: [
        "source",
        "target",
        "table_management",
        "summary"
    ],

    additionalProperties: false
};
