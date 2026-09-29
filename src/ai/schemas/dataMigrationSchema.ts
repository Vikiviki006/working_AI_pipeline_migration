import { z } from "zod";

import {
    VALUES_PLACEHOLDER,
    containsDml,
    extractInsertTarget,
    extractSelectTables,
    findBindParameters,
    splitSqlStatements,
    statementKind
} from "../../lib/sqlGuards.js";

import type {
    InsertTarget
} from "../../lib/sqlGuards.js";

const dataExtractionArraySchema = z
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
                const raw: string = statements[index];

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
                        `data_extraction[${index}] is empty`
                    );
                    continue;
                }

                const parts: string[] =
                    splitSqlStatements(raw);

                if (parts.length !== 1) {
                    at(
                        `data_extraction[${index}] must contain exactly one SQL statement, found ${parts.length}`
                    );
                    continue;
                }

                const sql: string = parts[0];
                const kind: string =
                    statementKind(sql);

                if (kind !== "SELECT") {
                    at(
                        `data_extraction[${index}] must be a SELECT statement, found "${kind}"`
                    );
                    continue;
                }

                if (containsDml(sql)) {
                    at(
                        `data_extraction[${index}] contains a data-manipulation keyword. Only SELECT is allowed on the Oracle side.`
                    );
                    continue;
                }

                if (
                    findBindParameters(sql).length > 0
                ) {
                    at(
                        `data_extraction[${index}] contains a bind parameter. Row values are resolved by the migration engine, not bound here.`
                    );
                    continue;
                }

                if (
                    extractSelectTables(sql).length === 0
                ) {
                    at(
                        `data_extraction[${index}] has no resolvable FROM or JOIN source table`
                    );
                    continue;
                }

                if (
                    new RegExp(
                        `^SELECT\\s+(?:DISTINCT\\s+|ALL\\s+)?\\*`,
                        "i"
                    ).test(sql)
                ) {
                    at(
                        `data_extraction[${index}] uses star expansion. Columns must be listed explicitly.`
                    );
                    continue;
                }

                if (
                    !raw.trimEnd().endsWith(";")
                ) {
                    at(
                        `data_extraction[${index}] must be terminated by a single semicolon`
                    );
                    continue;
                }
            }
        }
    );

/* ============================================================
 * data_management — PostgreSQL side
 * ========================================================== */

const dataManagementArraySchema = z
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
                const raw: string = statements[index];

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
                        `data_management[${index}] is empty`
                    );
                    continue;
                }

                const parts: string[] =
                    splitSqlStatements(raw);

                if (parts.length !== 1) {
                    at(
                        `data_management[${index}] must contain exactly one SQL statement, found ${parts.length}`
                    );
                    continue;
                }

                const sql: string = parts[0];
                const kind: string =
                    statementKind(sql);

                if (kind !== "INSERT") {
                    at(
                        `data_management[${index}] must be an INSERT statement, found "${kind}"`
                    );
                    continue;
                }

                if (
                    !sql.toUpperCase().includes(
                        "VALUES"
                    )
                ) {
                    at(
                        `data_management[${index}] is missing a VALUES clause`
                    );
                    continue;
                }

                const occurrences: number =
                    sql.split(
                        VALUES_PLACEHOLDER
                    ).length - 1;

                if (occurrences !== 1) {
                    at(
                        `data_management[${index}] must contain exactly one ${VALUES_PLACEHOLDER} marker, found ${occurrences}`
                    );
                    continue;
                }

                /*
                 * The marker must be the entire VALUES content, so a
                 * literal sneaking in beside it is rejected.
                 */
                const valuesClause: RegExpExecArray | null =
                    /VALUES\s+([\s\S]*?)\s*;?\s*$/i.exec(
                        sql
                    );

                if (
                    valuesClause === null ||
                    valuesClause[1].trim() !==
                        VALUES_PLACEHOLDER
                ) {
                    at(
                        `data_management[${index}] must use ${VALUES_PLACEHOLDER} as the entire VALUES content`
                    );
                    continue;
                }

                if (
                    findBindParameters(sql).length > 0
                ) {
                    at(
                        `data_management[${index}] contains a bind parameter. Use ${VALUES_PLACEHOLDER} instead.`
                    );
                    continue;
                }

                const target: InsertTarget | null =
                    extractInsertTarget(sql);

                if (target === null) {
                    at(
                        `data_management[${index}] does not name a resolvable target table`
                    );
                    continue;
                }

                if (
                    target.columns.length === 0
                ) {
                    at(
                        `data_management[${index}] must declare an explicit column list`
                    );
                    continue;
                }

                if (
                    !raw.trimEnd().endsWith(";")
                ) {
                    at(
                        `data_management[${index}] must be terminated by a single semicolon`
                    );
                    continue;
                }
            }
        }
    );

/* ============================================================
 * Response
 * ========================================================== */

export const dataMigrationResponseSchema = z
    .object({
        source: z.literal("oracle"),
        target: z.literal("postgresql"),
        data_extraction:
            dataExtractionArraySchema,
        data_management:
            dataManagementArraySchema,
        summary: z.string()
    })
    .superRefine(
        (
            value: {
                data_extraction: string[];
                data_management: string[];
            },
            context: z.RefinementCtx
        ): void => {

            /*
             * The two arrays are read as parallel lists, so their lengths
             * must agree. An unpaired half is unusable at runtime.
             */
            if (
                value.data_extraction.length !==
                value.data_management.length
            ) {
                context.addIssue({
                    code: "custom",
                    path: [
                        "data_management"
                    ],
                    message:
                        `data_extraction and data_management must be parallel arrays of equal length, got ${value.data_extraction.length} and ${value.data_management.length}`
                });
            }
        }
    );

export type DataMigrationResponse =
    z.infer<
        typeof dataMigrationResponseSchema
    >;

export const dataMigrationJsonSchema:
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

        data_extraction: {
            type: "array",

            description:
                "Parallel with data_management. Each element is a single reusable Oracle SELECT statement string terminated by exactly one semicolon. No DML, no DDL, no bind parameters, no row values.",

            items: {
                type: "string",

                description:
                    "A single Oracle SELECT statement, for example SELECT DEPARTMENT_ID, DEPARTMENT_NAME FROM HR.DEPARTMENTS;"
            }
        },

        data_management: {
            type: "array",

            description:
                "Parallel with data_extraction. Each element is a single reusable PostgreSQL INSERT template string terminated by exactly one semicolon, with {VALUES_PLACEHOLDER} as the entire VALUES content. Exactly one template per target table, never one per row.",

            items: {
                type: "string",

                description:
                    "A single PostgreSQL INSERT template, for example INSERT INTO public.departments (department_id, department_name) VALUES {VALUES_PLACEHOLDER};"
            }
        },

        summary: {
            type: "string",

            description:
                "One sentence naming how many table pairs were generated."
        }
    },

    required: [
        "source",
        "target",
        "data_extraction",
        "data_management",
        "summary"
    ],

    additionalProperties: false
};
