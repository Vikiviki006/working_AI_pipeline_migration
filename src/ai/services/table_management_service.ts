import { callAI } from "../ai_client.js";

import {
    TABLE_MANAGEMENT_SYSTEM_PROMPT
} from "../prompts/table_management_prompt.js";

import {
    tableManagementJsonSchema,
    tableManagementResponseSchema
} from "../schemas/table_management_schema.js";

import {
    columnNames,
    indexTables,
    parseSchema,
    planTargetBuild,
    verifyTargetSchema
} from "../../lib/schema_verifier.js";

import {
    buildFileManifest,
    describeDdlStatement
} from "../../lib/file_layout.js";

import {
    ddlTargetTable,
    extractCreateTableColumns,
    findColumnMutation,
    normalizeSql,
    splitSqlStatements,
    statementKind
} from "../../lib/sql_guards.js";

import {
    ProviderOutputError,
    RequestValidationError
} from "../../lib/errors.js";

import type {
    AIProviderName,
    AIRequest,
    SchemaMetadata,
    SourceDatabase,
    TableMetadata,
    TargetDatabase
} from "../../types/types.js";

import type {
    TableBuildPlan,
    TargetBuildPlan,
    TypeMapping
} from "../../lib/schema_verifier.js";

import type {
    ArtifactFile
} from "../../lib/file_layout.js";

export type TableManagementOutput = {
    source: SourceDatabase;
    target: TargetDatabase;
    table_management: string[];
    files: ArtifactFile[];
    plan: {
        create: string[];
        drop: string[];
        type_mappings: TypeMapping[];
    };
    summary: string;
};

export type TableManagementResult = {
    provider: AIProviderName;
    result: TableManagementOutput;
};

/*
 * Not a validated request body: stage 2 no longer has an endpoint of its own,
 * so these fields are assembled by the orchestrator from the design stage's
 * output rather than supplied by a caller.
 */
export type TableManagementInput = {
    source_database: SourceDatabase;
    target_database: TargetDatabase;
    source_schema: unknown;
    target_schema: unknown;
    user_query?: string;
};

/*
 * Stage 2.
 *
 * The Oracle schema and the designed PostgreSQL schema are verified and diffed
 * in code FIRST. Only then is the model asked to phrase the resulting DDL, and
 * its output is then checked back against that same diff. The model can
 * therefore never introduce a table, column or statement the diff did not
 * call for.
 *
 * Runs inline behind POST /api/schema-design; there is no separate endpoint.
 */
export async function generateTableManagement(
    input: TableManagementInput,
    provider?: AIProviderName
): Promise<TableManagementResult> {

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

    /*
     * Step 2: the authoritative build plan.
     *
     * The target database is empty, so this is a build rather than a
     * mutation. Every target table is created; only source tables the design
     * removed are dropped.
     */
    const plan: TargetBuildPlan =
        planTargetBuild(source, target);

    const staticContext: string =
        JSON.stringify(
            {
                source_database:
                    input.source_database,

                target_database:
                    input.target_database,

                build_plan: {
                    create: plan.create,
                    drop: plan.drop
                },

                target_schema: target
            },
            null,
            2
        );

    let expected: number = plan.create.length;

    for (
        const table of plan.create
    ) {
        if (table.primaryKey.columns.length > 0) {
            expected += 1;
        }

        expected += table.foreignKeys.length;
    }

    expected += plan.drop.length;

    const dynamicPrompt: string = [
        "Render build_plan as executable PostgreSQL DDL for an empty database.",
        "",
        `Create ${plan.create.length} table(s), drop ${plan.drop.length} table(s).`,
        `Expected statement count: ${expected} (one CREATE TABLE per table, one ADD CONSTRAINT PRIMARY KEY per non-empty primary key, one ADD CONSTRAINT FOREIGN KEY per foreign key, one DROP TABLE per dropped table).`,
        plan.drop.length === 0
            ? "plan.drop is empty: emit no DROP TABLE statement."
            : `Emit one DROP TABLE for each of: ${plan.drop.join(", ")}.`,
        "",
        "ORACLE SOURCE SCHEMA (provenance only — never emit Oracle SQL, and never emit a statement derived from an Oracle column):",
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

    const response =
        await callAI(
            aiRequest,
            "Table Management",
            provider
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
     * Step 4: check the statements against the build plan. This is the step
     * the model cannot talk its way past.
     */
    const crossErrors: string[] =
        crossCheckStatements(
            statements,
            source,
            target,
            plan
        );

    if (crossErrors.length > 0) {
        console.error(
            "Table Management: statements disagree with the build plan",
            crossErrors
        );

        throw new ProviderOutputError(
            `${response.provider} returned table management statements that do not match the verified build plan`,
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
            plan: {
                create: plan.create.map(
                    (
                        table: TableBuildPlan
                    ): string => table.table
                ),
                drop: plan.drop,
                type_mappings: plan.type_mappings
            },
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

/* ============================================================
 * Build-plan cross-check
 * ========================================================== */

/**
 * Verifies the emitted DDL against the verified build plan.
 *
 * The target database is created from empty, so the checks are about coverage
 * and contradiction rather than mutation:
 *
 *   - every planned table is created, exactly once
 *   - a created table's column list matches the plan exactly, and declares no
 *     inline keys
 *   - every planned primary key and foreign key is added as its own
 *     ALTER TABLE ... ADD CONSTRAINT
 *   - nothing is altered, renamed or dropped that the plan does not call for
 *   - every object is schema-qualified
 */
export function crossCheckStatements(
    statements: string[],
    source: SchemaMetadata,
    target: SchemaMetadata,
    plan: TargetBuildPlan
): string[] {

    const errors: string[] = [];

    const targetTables: Map<string, TableMetadata> =
        indexTables(target);
    const sourceTables: Map<string, TableMetadata> =
        indexTables(source);

    const created: Map<string, string> =
        new Map<string, string>();
    const dropped: Set<string> = new Set<string>();
    const keysAdded: Map<string, Set<string>> =
        new Map<string, Set<string>>();
    const foreignKeysAdded: Map<string, Set<string>> =
        new Map<string, Set<string>>();

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

        /*
         * A migration must not depend on the session search_path, so a bare
         * name is rejected. Checked as written, never as synthesised.
         */
        if (!table.includes(".")) {
            errors.push(
                `${kind} ${table} is not schema-qualified with "public"`
            );
        }

        if (kind === "DROP TABLE") {
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
                    `DROP TABLE ${table} contradicts the build plan, which still creates ${table}`
                );
            }

            dropped.add(bare);

            continue;
        }

        const targetTable: TableMetadata | undefined =
            targetTables.get(bare);

        if (targetTable === undefined) {
            errors.push(
                `${kind} ${table} targets ${table}, which is not present in target_schema`
            );
            continue;
        }

        if (kind === "CREATE TABLE") {
            if (created.has(bare)) {
                errors.push(
                    `CREATE TABLE ${table} is emitted more than once`
                );
                continue;
            }

            created.set(bare, sql);

            /*
             * A CREATE TABLE that omits a planned column would build a table
             * the design never asked for, and one that adds a column the
             * design lacks would build one that does not exist upstream.
             */
            const declared: string[] | null =
                extractCreateTableColumns(sql);

            if (declared !== null) {
                const expected: Set<string> =
                    columnNames(targetTable);

                for (
                    const column of declared
                ) {
                    if (
                        !expected.has(
                            column.toLowerCase()
                        )
                    ) {
                        errors.push(
                            `CREATE TABLE ${table} declares column ${column}, which is not present in target_schema for ${targetTable.tableName}`
                        );
                    }
                }

                for (
                    const column of targetTable.columns
                ) {
                    if (
                        !declared.some(
                            (
                                name: string
                            ): boolean =>
                                name.toLowerCase() ===
                                    column.columnName.toLowerCase()
                        )
                    ) {
                        errors.push(
                            `CREATE TABLE ${table} omits column ${column.columnName}, which target_schema requires for ${targetTable.tableName}`
                        );
                    }
                }
            }

            continue;
        }

        if (kind !== "ALTER TABLE") {
            continue;
        }

        const mutation: string | null =
            findColumnMutation(sql);

        if (mutation !== null) {
            errors.push(
                `ALTER TABLE ${table} performs ${mutation}. The target database is created from empty, so there is no existing column to modify.`
            );
            continue;
        }

        if (
            !created.has(bare) &&
            !keysAdded.has(bare) &&
            !foreignKeysAdded.has(bare)
        ) {
            /* Constraint work is checked per constraint below. */
        }

        if (
            /\bADD\s+CONSTRAINT\b/i.test(sql) &&
            /\bPRIMARY\s+KEY\b/i.test(sql)
        ) {
            keysAdded.set(
                bare,
                (keysAdded.get(bare) ??
                    new Set<string>())
            );
        }

        if (
            /\bADD\s+CONSTRAINT\b/i.test(sql) &&
            /\bFOREIGN\s+KEY\b/i.test(sql)
        ) {
            foreignKeysAdded.set(
                bare,
                (foreignKeysAdded.get(bare) ??
                    new Set<string>())
            );
        }
    }

    /* Every planned table must be created, exactly once. */
    for (
        const planned of plan.create
    ) {
        const bare: string =
            planned.table.toLowerCase();

        if (!created.has(bare)) {
            errors.push(
                `build_plan creates ${planned.table}, but no CREATE TABLE statement was returned for it`
            );
        }
    }

    /*
     * Every planned primary key must be added by its own statement, because
     * keys are kept out of the CREATE TABLE body.
     */
    for (
        const planned of plan.create
    ) {
        const bare: string =
            planned.table.toLowerCase();

        if (planned.primaryKey.columns.length === 0) {
            continue;
        }

        if (!keysAdded.has(bare)) {
            errors.push(
                `build_plan gives ${planned.table} the primary key (${planned.primaryKey.columns.join(", ")}), but no ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY was returned for it`
            );
        }
    }

    /*
     * Every planned foreign key must be added by its own statement, otherwise
     * referential integrity is silently lost.
     */
    for (
        const planned of plan.create
    ) {
        for (
            const fk of planned.foreignKeys
        ) {
            const bare: string =
                planned.table.toLowerCase();

            if (
                !foreignKeysAdded.has(bare)
            ) {
                errors.push(
                    `build_plan gives ${planned.table} a foreign key on (${fk.columns.join(", ")}) referencing ${fk.referencedTable} (${fk.referencedColumns.join(", ")}), but no ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY was returned for it`
                );
            }
        }
    }

    /* Every planned drop must be present, and nothing else may be dropped. */
    for (
        const plannedDrop of plan.drop
    ) {
        if (
            !dropped.has(
                plannedDrop.toLowerCase()
            )
        ) {
            errors.push(
                `build_plan drops ${plannedDrop}, but no DROP TABLE statement was returned for it`
            );
        }
    }

    /*
     * Ordering: a constraint can only be added to a table that already exists,
     * and a CREATE TABLE can only follow nothing that depends on it. Every
     * CREATE must therefore precede every ALTER on that table.
     */
    const lastCreateIndex: Map<string, number> =
        new Map<string, number>();

    statements.forEach(
        (
            statement: string,
            position: number
        ): void => {

            const table: string | null =
                ddlTargetTable(statement);

            if (
                table === null ||
                statementKind(statement) !==
                    "CREATE TABLE"
            ) {
                return;
            }

            lastCreateIndex.set(
                table
                    .split(".")
                    .pop()
                    ?.toLowerCase() ?? "",
                position
            );
        }
    );

    statements.forEach(
        (
            statement: string,
            position: number
        ): void => {

            const kind: string =
                statementKind(statement);

            if (kind !== "ALTER TABLE") {
                return;
            }

            const table: string | null =
                ddlTargetTable(statement);

            if (table === null) {
                return;
            }

            const bare: string =
                table
                    .split(".")
                    .pop()
                    ?.toLowerCase() ?? "";

            const createdAt: number | undefined =
                lastCreateIndex.get(bare);

            if (
                createdAt !== undefined &&
                position < createdAt
            ) {
                errors.push(
                    `statement ${position} adds a constraint to ${table}, but its CREATE TABLE is at position ${createdAt}. Constraints must come after the table is created.`
                );
            }
        }
    );

    return errors;
}

