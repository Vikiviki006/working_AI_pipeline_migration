import { callAI } from "../aiClient.js";

import {
    DATA_MIGRATION_SYSTEM_PROMPT
} from "../prompts/dataMigrationPrompt.js";

import {
    dataMigrationJsonSchema,
    dataMigrationResponseSchema
} from "../schemas/dataMigrationSchema.js";

import {
    columnNames,
    indexTables,
    parseSchema
} from "../../lib/schemaVerifier.js";

import {
    buildFileManifest,
    insertStatementSlug,
    selectStatementSlug
} from "../../lib/fileLayout.js";

import type { AIRequest } from "../../types/types.js";

import {
    VALUES_PLACEHOLDER,
    bareName,
    extractInsertTarget,
    extractProjection,
    extractSelectSources,
    normalizeSql,
    splitSqlStatements
} from "../../lib/sqlGuards.js";

import type {
    ProjectedColumn,
    SelectSource
} from "../../lib/sqlGuards.js";

import {
    ProviderOutputError,
    RequestValidationError
} from "../../lib/errors.js";

import type {
    AIProviderName,
    SchemaMetadata,
    SourceDatabase,
    TableMetadata,
    TargetDatabase
} from "../../types/types.js";

import type {
    ArtifactFile
} from "../../lib/fileLayout.js";

import type {
    DataMigrationRequest
} from "../schemas/dataMigrationRequestSchema.js";

export type DataMigrationOutput = {
    source: SourceDatabase;
    target: TargetDatabase;
    data_extraction: string[];
    data_management: string[];
    files: ArtifactFile[];
    placeholder: string;
    summary: string;
};

export type DataMigrationResult = {
    provider: AIProviderName;
    result: DataMigrationOutput;
};

export async function generateDataMigrationQueries(
    input: DataMigrationRequest
): Promise<DataMigrationResult> {

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

    if (source.tables.length === 0) {
        throw new RequestValidationError(
            "source_schema contains no tables, so there is nothing to extract"
        );
    }

    if (target.tables.length === 0) {
        throw new RequestValidationError(
            "target_schema contains no tables, so there is nothing to load into"
        );
    }

    const staticContext: string =
        JSON.stringify(
            {
                source_database:
                    input.source_database,

                target_database:
                    input.target_database,

                oracle_schema: source,

                postgres_schema: target
            },
            null,
            2
        );

    const dynamicPrompt: string = [
        "Generate the paired Oracle SELECT and PostgreSQL INSERT templates that move every reachable table.",
        "",
        `Values must be supplied at runtime through the ${VALUES_PLACEHOLDER} marker. Never emit a literal value.`,
        "",
        input.user_query === undefined
            ? "No filter or scope instruction was supplied. Cover every table that can be mapped."
            : `Scope instruction from the user: ${input.user_query}`
    ].join("\n");

    const aiRequest: AIRequest = {
        systemPrompt:
            DATA_MIGRATION_SYSTEM_PROMPT,
        staticContext,
        dynamicPrompt,
        responseSchema:
            dataMigrationJsonSchema,
        responseSchemaName:
            "data_migration"
    };

    const response =
        await callAI(
            aiRequest,
            "Data Migration"
        );

    const validated =
        dataMigrationResponseSchema.safeParse(
            response.result
        );

    if (!validated.success) {
        console.error(
            "Data Migration: response validation failed"
        );
        console.error(
            validated.error.format()
        );

        throw new ProviderOutputError(
            `${response.provider} returned data migration output that failed SQL validation`,
            response.provider,
            validated.error.format()
        );
    }

    /* Canonicalise, then re-validate what will actually be returned. */
    const extraction: string[] =
        validated.data.data_extraction.map(
            normalizeSql
        );

    const management: string[] =
        validated.data.data_management.map(
            normalizeSql
        );

    const revalidated =
        dataMigrationResponseSchema.safeParse(
            {
                source: validated.data.source,
                target: validated.data.target,
                data_extraction: extraction,
                data_management: management,
                summary: validated.data.summary
            }
        );

    if (!revalidated.success) {
        throw new ProviderOutputError(
            "Normalised data migration statements failed SQL validation",
            response.provider,
            revalidated.error.format()
        );
    }

    const crossErrors: string[] =
        crossCheckStatements(
            extraction,
            management,
            source,
            target
        );

    if (crossErrors.length > 0) {
        console.error(
            "Data Migration: statements reference unknown objects",
            crossErrors
        );

        throw new ProviderOutputError(
            `${response.provider} returned data migration statements that reference objects absent from the supplied metadata`,
            response.provider,
            {
                problems: crossErrors,
                data_extraction: extraction,
                data_management: management
            }
        );
    }

    const extractionFiles = buildFileManifest(
        "data_extraction",
        extraction,
        (
            statement: string
        ): string => {

            const sources: SelectSource[] =
                extractSelectSources(statement);

            const object: string =
                sources.length > 0
                    ? bareName(sources[0].table)
                    : "select";

            return selectStatementSlug(
                object
            );
        }
    );

    const managementOffset: number =
        extractionFiles.length;

    const managementFiles = buildFileManifest(
        "data_management",
        management,
        (
            statement: string
        ): string => {

            const parsed =
                extractInsertTarget(statement);

            return insertStatementSlug(
                parsed === null
                    ? "target"
                    : bareName(parsed.table)
            );
        },
        managementOffset
    );

    return {
        provider: response.provider,
        result: {
            source: revalidated.data.source,
            target: revalidated.data.target,
            data_extraction: extraction,
            data_management: management,
            files: [
                ...extractionFiles,
                ...managementFiles
            ],
            placeholder: VALUES_PLACEHOLDER,
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

    const parsed = parseSchema(raw);

    if (!parsed.ok) {
        throw new RequestValidationError(
            `${label} is not a valid schema document`,
            parsed.errors
        );
    }

    return parsed.value;
}

/**
 * Checks both SQL halves against the supplied metadata and against each other.
 */
function crossCheckStatements(
    extraction: string[],
    management: string[],
    source: SchemaMetadata,
    target: SchemaMetadata
): string[] {

    const errors: string[] = [];

    const sourceTables =
        indexTables(source);
    const targetTables =
        indexTables(target);

    for (
        let position = 0;
        position < extraction.length;
        position += 1
    ) {
        const statement: string =
            extraction[position];

        const sql: string | null =
            singleStatement(statement);

        if (sql === null) {
            continue;
        }

        const sources: SelectSource[] =
            extractSelectSources(sql);

        if (sources.length === 0) {
            errors.push(
                `data_extraction[${position}] has no resolvable FROM source`,
                statement
            );
            continue;
        }

        /*
         * Map every alias a column may be qualified by to its table, so a
         * joined column is checked against the table it actually comes from
         * rather than against the driving table.
         */
        const byQualifier: Map<string, string> =
            new Map<string, string>();

        for (
            const source of sources
        ) {
            const bare: string =
                bareName(source.table);

            byQualifier.set(bare, bare);
            byQualifier.set(
                bare.split(".").pop() ?? bare,
                bare
            );

            if (source.alias !== null) {
                byQualifier.set(
                    source.alias.toLowerCase(),
                    bare
                );
            }
        }

        const allColumns: Set<string> =
            new Set<string>();

        for (
            const source of sources
        ) {
            const table: TableMetadata | undefined =
                sourceTables.get(
                    bareName(source.table)
                );

            if (table === undefined) {
                continue;
            }

            for (
                const name of columnNames(table)
            ) {
                allColumns.add(name);
            }
        }

        for (
            const item of extractProjection(sql)
        ) {
            if (
                item.expression ||
                item.column === null
            ) {
                continue;
            }

            if (
                item.qualifier !== null
            ) {
                const resolved: string | undefined =
                    byQualifier.get(
                        item.qualifier
                    );

                if (resolved === undefined) {
                    errors.push(
                        `data_extraction[${position}] qualifies ${item.column} with "${item.qualifier}", which is not a table or alias in this query`,
                        statement
                    );
                    continue;
                }

                if (
                    !allColumns.has(
                        item.column
                    )
                ) {
                    errors.push(
                        `data_extraction[${position}] selects ${item.column}, which exists on neither table in the join`,
                        statement
                    );
                }

                continue;
            }

            /*
             * Unqualified in a multi-table query is ambiguous, so only a
             * single-table query can be checked safely.
             */
            if (
                sources.length === 1 &&
                !allColumns.has(item.column)
            ) {
                const table: TableMetadata | undefined =
                    sourceTables.get(
                        bareName(
                            sources[0].table
                        )
                    );

                errors.push(
                    `data_extraction[${position}] selects ${item.column}, which does not exist on Oracle table ${table?.tableName ?? sources[0].table}`,
                    statement
                );
            }
        }
    }

    for (
        let position = 0;
        position < management.length;
        position += 1
    ) {
        const statement: string =
            management[position];

        const sql: string | null =
            singleStatement(statement);

        if (sql === null) {
            continue;
        }

        const parsed =
            extractInsertTarget(sql);

        if (parsed === null) {
            continue;
        }

        const bare: string =
            bareName(parsed.table);

        const table =
            targetTables.get(bare);

        if (table === undefined) {
            errors.push(
                `data_management[${position}] inserts into ${parsed.table}, which does not exist in the PostgreSQL schema`
            );
            continue;
        }

        if (
            !parsed.table
                .toLowerCase()
                .includes(".")
        ) {
            errors.push(
                `data_management[${position}] target ${parsed.table} is not schema-qualified with "public"`
            );
        }

        const available: Set<string> =
            columnNames(table);

        for (
            const column of parsed.columns
        ) {
            if (
                !available.has(
                    column.toLowerCase()
                )
            ) {
                errors.push(
                    `data_management[${position}] writes column ${column}, which does not exist on PostgreSQL table ${table.tableName}`
                );
            }
        }
    }

    /*
     * Positional binding: the INSERT column count is the arity the migration
     * engine will supply, and it comes from the matching projection. A
     * mismatch means the row would land in the wrong columns.
     */
    for (
        let position = 0;
        position < management.length;
        position += 1
    ) {
        const insertSql: string | null =
            singleStatement(
                management[position]
            );

        const extractSql: string | null =
            singleStatement(
                extraction[position] ??
                    ""
            );

        if (
            insertSql === null ||
            extractSql === null
        ) {
            continue;
        }

        const parsed =
            extractInsertTarget(insertSql);

        const projection: ProjectedColumn[] =
            extractProjection(extractSql);

        if (
            parsed === null ||
            projection.length === 0
        ) {
            continue;
        }

        if (
            parsed.columns.length !==
            projection.length
        ) {
            errors.push(
                `data_management[${position}] declares ${parsed.columns.length} column(s) but the matching data_extraction[${position}] projects ${projection.length}; the placeholder arity would not match`
            );
        }
    }

    return errors;
}

function singleStatement(
    statement: string
): string | null {

    const parts: string[] =
        splitSqlStatements(statement);

    return parts.length === 1
        ? parts[0]
        : null;
}
