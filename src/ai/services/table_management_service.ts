import { callAI } from "../ai_client.js";

import {
    TABLE_MANAGEMENT_SYSTEM_PROMPT
} from "../prompts/table_management_prompt.js";

import {
    tableManagementJsonSchema,
    tableManagementResponseSchema
} from "../schemas/table_management_schema.js";

import {
    computeSchemaDiff,
    diffCounts,
    indexTables,
    isEmptyDiff,
    parseSchema,
    verifyTargetSchema
} from "../../lib/schema_verifier.js";

import {
    buildFileManifest,
    describeDdlStatement
} from "../../lib/file_layout.js";

import {
    ddlTargetTable,
    normalizeSql,
    splitSqlStatements,
    statementKind
} from "../../lib/sql_guards.js";

import {
    ProviderOutputError,
    RequestValidationError
} from "../../lib/errors.js";

import type {
    AIRequest,
    AIResponse,
    SchemaMetadata,
    TableMetadata
} from "../../types/types.js";

import type {
    SchemaDiff
} from "../../lib/schema_verifier.js";

import type {
    TableManagementRequest
} from "../schemas/table_management_request_schema.js";

/*
 * Route 2.
 *
 * The Oracle schema and the designed PostgreSQL schema are verified and diffed
 * in code FIRST. Only then is the model asked to phrase the resulting DDL, and
 * its output is then checked back against that same diff. The model can
 * therefore never introduce a table, column or statement the diff did not
 * call for.
 */
export async function generateTableManagement(
    input: TableManagementRequest
): Promise<AIResponse> {

    const source: SchemaMetadata =
        requireSchema(
            input.source_schema,
            "source_schema"
        );

    const target: SchemaMetadata =
        requireSchema(
            input.target_schema,
            "target_schema"
        );

    /*
     * Step 1: refuse to continue if the designed schema is not structurally
     * sound. Generating DDL from a broken design only produces broken DDL.
     */
    const verificationErrors: string[] =
        verifyTargetSchema(target);

    if (verificationErrors.length > 0) {
        throw new RequestValidationError(
            "target_schema failed structural verification",
            verificationErrors
        );
    }

    /* Step 2: the authoritative diff. */
    const diff: SchemaDiff =
        computeSchemaDiff(
            source,
            target
        );

    const staticContext: string =
        JSON.stringify(
            {
                source_database:
                    input.source_database,

                target_database:
                    input.target_database,

                target_schema:
                    target,

                verified_diff:
                    diff
            },
            null,
            2
        );

    const counts = diffCounts(diff);

    const dynamicPrompt: string = [
        "Generate the PostgreSQL DDL that applies verified_diff.",
        "",
        `Expected totals: ${counts.create} created, ${counts.alter} altered, ${counts.drop} dropped.`,
        isEmptyDiff(diff)
            ? "verified_diff is empty. Return an empty table_management array."
            : "Every entry in verified_diff must be reflected exactly once, except unchanged_tables which produces nothing.",
        "",
        "ORACLE SOURCE SCHEMA (for traceability only — never emit Oracle SQL):",
        "",
        JSON.stringify(source, null, 2),
        "",
        input.user_query === undefined
            ? "No design intent was supplied."
            : `Design intent behind target_schema: ${input.user_query}`
    ].join("\n");

    const aiRequest: AIRequest = {
        systemPrompt:
            TABLE_MANAGEMENT_SYSTEM_PROMPT,
        staticContext,
        dynamicPrompt,
        responseSchema:
            tableManagementJsonSchema,
        responseSchemaName:
            "table_management"
    };

    const response: AIResponse =
        await callAI(
            aiRequest,
            "Table Management"
        );

    const validated =
        tableManagementResponseSchema.safeParse(
            response.result
        );

    if (!validated.success) {
        console.error(
            "Table Management: response validation failed"
        );
        console.error(
            validated.error.format()
        );

        throw new ProviderOutputError(
            `${response.provider} returned table management output that failed SQL validation`,
            response.provider,
            validated.error.format()
        );
    }

    /*
     * Step 3: canonicalise whitespace and semicolons, then re-validate. The
     * parser accepted the model's raw text; the normalised text is what gets
     * returned, so it must be the text that passes.
     */
    const statements: string[] =
        validated.data.table_management.map(
            (
                statement: string
            ): string =>
                normalizeSql(statement)
        );

    const revalidated =
        tableManagementResponseSchema.safeParse(
            {
                ...validated.data,
                table_management: statements
            }
        );

    if (!revalidated.success) {
        throw new ProviderOutputError(
            "Normalised table management statements failed SQL validation",
            response.provider,
            revalidated.error.format()
        );
    }

    /*
     * Step 4: check the statements against the verified diff. This is the
     * step the model cannot talk its way past.
     */
    const crossErrors: string[] =
        crossCheckStatements(
            statements,
            source,
            target,
            diff
        );

    if (crossErrors.length > 0) {
        console.error(
            "Table Management: statements disagree with the verified diff",
            crossErrors
        );

        throw new ProviderOutputError(
            `${response.provider} returned table management statements that do not match the verified schema diff`,
            response.provider,
            {
                problems: crossErrors,
                statements
            }
        );
    }

    const files = buildFileManifest(
        "table_management",
        statements,
        describeDdlStatement
    );

    return {
        provider: response.provider,
        result: {
            source: revalidated.data.source,
            target: revalidated.data.target,
            table_management: statements,
            files,
            diff,
            summary: revalidated.data.summary
        }
    };
}

/* ============================================================
 * Helpers
 * ========================================================== */

function requireSchema(
    raw: unknown,
    label: string
): SchemaMetadata {

    const parsed =
        parseSchema(raw);

    if (!parsed.ok) {
        throw new RequestValidationError(
            `${label} is not a valid schema document`,
            parsed.errors
        );
    }

    return parsed.value;
}

/**
 * Verifies that every emitted statement targets a real object and that the
 * created / dropped sets agree with the diff.
 */
function crossCheckStatements(
    statements: string[],
    source: SchemaMetadata,
    target: SchemaMetadata,
    diff: SchemaDiff
): string[] {

    const errors: string[] = [];

    const targetTables: Map<string, TableMetadata> =
        indexTables(target);
    const sourceTables: Map<string, TableMetadata> =
        indexTables(source);

    const seenStatements: string[] = [];

    for (
        const statement of statements
    ) {
        const parts: string[] =
            splitSqlStatements(statement);

        if (parts.length !== 1) {
            continue;
        }

        const sql: string = parts[0];
        const kind: string =
            statementKind(sql);

        seenStatements.push(sql);

        const table: string | null =
            ddlTargetTable(sql);

        if (table === null) {
            continue;
        }

        const bare: string =
            table
                .split(".")
                .pop()
                ?.toLowerCase() ?? "";

        const qualified: string =
            table.includes(".")
                ? table
                : `public.${table}`;

        if (kind === "DROP TABLE") {
            /*
             * A dropped table must exist on the Oracle side and must be gone
             * from the target: that is exactly a merge or split removal.
             */
            if (
                !sourceTables.has(bare) &&
                !targetTables.has(bare)
            ) {
                errors.push(
                    `DROP TABLE ${table} targets ${table}, which exists in neither the Oracle source schema nor the target schema`
                );
            }

            if (targetTables.has(bare)) {
                errors.push(
                    `DROP TABLE ${table} contradicts target_schema, which still declares ${table}`
                );
            }

            continue;
        }

        if (
            !targetTables.has(bare)
        ) {
            errors.push(
                `${kind} ${table} targets ${table}, which is not present in target_schema`
            );
            continue;
        }

        if (
            !qualified
                .toLowerCase()
                .startsWith("public.")
        ) {
            errors.push(
                `${kind} ${table} is not schema-qualified with "public"`
            );
        }
    }

    /* Every created table must actually be created. */
    for (
        const created of diff.created_tables
    ) {
        const bare: string =
            created.toLowerCase();

        const covered: boolean =
            seenStatements.some(
                (
                    sql: string
                ): boolean =>
                    statementKind(sql) ===
                        "CREATE TABLE" &&
                    (
                        ddlTargetTable(sql)
                            ?.split(".")
                            .pop()
                            ?.toLowerCase() ??
                        ""
                    ) === bare
            );

        if (!covered) {
            errors.push(
                `verified_diff requires CREATE TABLE for ${created}, but no such statement was returned`
            );
        }
    }

    /* Every dropped table must actually be dropped. */
    for (
        const dropped of diff.dropped_tables
    ) {
        const bare: string =
            dropped.toLowerCase();

        const covered: boolean =
            seenStatements.some(
                (
                    sql: string
                ): boolean =>
                    statementKind(sql) ===
                        "DROP TABLE" &&
                    (
                        ddlTargetTable(sql)
                            ?.split(".")
                            .pop()
                            ?.toLowerCase() ??
                        ""
                    ) === bare
            );

        if (!covered) {
            errors.push(
                `verified_diff requires DROP TABLE for ${dropped}, but no such statement was returned`
            );
        }
    }

    /* An empty diff must yield no statements at all. */
    if (
        isEmptyDiff(diff) &&
        statements.length > 0
    ) {
        errors.push(
            "verified_diff is empty, so table_management must be an empty array"
        );
    }

    return errors;
}
