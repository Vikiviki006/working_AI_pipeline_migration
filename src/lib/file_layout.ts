/*
 * Canonical migration artifact layout.
 *
 * Nothing is written to disk. Every generated statement is tagged with the
 * path it *would* occupy inside the migration bundle, so a downstream runner
 * can materialise the project with exactly these names.
 *
 *   migration/
 *   |-- manifest.json
 *   |-- oracle/
 *   |   |-- schema/
 *   |   |   `-- source_schema.json
 *   |   `-- data/
 *   |       |-- 001_select_departments.sql
 *   |       `-- ...
 *   `-- postgres/
 *       |-- schema/
 *       |   `-- target_schema.json
 *       |-- ddl/
 *       |   |-- 001_create_table_departments.sql
 *       |   |-- 002_alter_table_add_constraint_departments_pkey.sql
 *       |   `-- 009_drop_table_legacy_employee_details.sql
 *       `-- dml/
 *           |-- 001_insert_departments.sql
 *           `-- ...
 */

import {
    bareName,
    ddlTargetTable,
    indexName,
    objectName,
    sequencePrefix,
    slugify,
    statementKind
} from "./sql_guards.js";

export const ROOT = "migration";

export const ORACLE_SCHEMA_DIR = `${ROOT}/oracle/schema`;
export const ORACLE_DATA_DIR = `${ROOT}/oracle/data`;
export const POSTGRES_SCHEMA_DIR = `${ROOT}/postgres/schema`;
export const POSTGRES_DDL_DIR = `${ROOT}/postgres/ddl`;
export const POSTGRES_DML_DIR = `${ROOT}/postgres/dml`;
export const MANIFEST_PATH = `${ROOT}/manifest.json`;

export const TARGET_SCHEMA_PATH =
    `${POSTGRES_SCHEMA_DIR}/target_schema.json`;

export type ArtifactFile = {
    path: string;
    group:
        | "table_management"
        | "data_extraction"
        | "data_management";
    index: number;
    statement: string;
};

function groupDirectory(
    group: ArtifactFile["group"]
): string {

    switch (group) {
        case "table_management":
            return POSTGRES_DDL_DIR;
        case "data_extraction":
            return ORACLE_DATA_DIR;
        case "data_management":
            return POSTGRES_DML_DIR;
    }
}

/**
 * Builds the file manifest for a validated statement group.
 *
 * `describe` returns the object a statement is about, used for the filename.
 * `startAt` offsets the sequence prefix so two groups written into different
 * directories still receive stable, non-colliding numbering.
 */
export function buildFileManifest(
    group: ArtifactFile["group"],
    statements: string[],
    describe: (
        statement: string,
        position: number
    ) => string,
    startAt: number = 0
): ArtifactFile[] {

    return statements.map(
        (
            statement: string,
            position: number
        ): ArtifactFile => {

            const objectName: string =
                describe(statement, position);

            const prefix: string =
                sequencePrefix(
                    startAt + position
                );

            return {
                path: `${groupDirectory(group)}/${prefix}_${slugify(objectName)}.sql`,
                group,
                index: position,
                statement
            };
        }
    );
}

/* ============================================================
 * Filename derivation
 * ========================================================== */

const ALTER_ACTIONS: ReadonlyArray<{
    pattern: RegExp;
    build: (name: string) => string;
}> = [
    {
        pattern:
            /\bADD\s+CONSTRAINT\s+([A-Za-z_][A-Za-z0-9_$]*)/i,
        build: (name: string): string =>
            `alter_table_add_constraint_${name}`
    },
    {
        pattern:
            /\bDROP\s+CONSTRAINT\s+([A-Za-z_][A-Za-z0-9_$]*)/i,
        build: (name: string): string =>
            `alter_table_drop_constraint_${name}`
    },
    {
        pattern:
            /\bADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_$]*)/i,
        build: (name: string): string =>
            `alter_table_add_column_${name}`
    },
    {
        pattern:
            /\bDROP\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_$]*)/i,
        build: (name: string): string =>
            `alter_table_drop_column_${name}`
    },
    {
        pattern:
            /\bALTER\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_$]*)\s+TYPE/i,
        build: (name: string): string =>
            `alter_table_alter_column_${name}_type`
    },
    {
        pattern:
            /\bALTER\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_$]*)\s+SET\s+NOT\s+NULL/i,
        build: (name: string): string =>
            `alter_table_set_not_null_${name}`
    },
    {
        pattern:
            /\bALTER\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_$]*)\s+DROP\s+NOT\s+NULL/i,
        build: (name: string): string =>
            `alter_table_drop_not_null_${name}`
    }
];

/**
 * A descriptive, collision-resistant name for a DDL statement.
 *
 * The bare table name is not enough on its own: three different statements can
 * all target the same table (create it, add its primary key, add a foreign
 * key), and they must not share a filename. The discriminator is the specific
 * object or action the statement performs.
 */
export function describeDdlStatement(
    statement: string
): string {

    const kind: string =
        statementKind(statement);

    const table: string | null =
        ddlTargetTable(statement);

    const bare: string =
        table === null
            ? ""
            : bareName(table);

    switch (kind) {
        case "CREATE TABLE":
            return `create_table_${bare}`;

        case "DROP TABLE":
            return `drop_table_${bare}`;

        case "ALTER TABLE":
            return describeAlterTable(
                statement,
                bare
            );

        case "CREATE INDEX":
        case "CREATE UNIQUE INDEX": {
            const named: string | null =
                indexName(statement);

            return `${slugify(
                kind.toLowerCase().replace(/\s+/g, "_")
            )}_${bareName(
                named ?? bare
            )}`;
        }

        case "DROP INDEX": {
            const named: string | null =
                indexName(statement);

            return `drop_index_${bareName(
                named ?? bare
            )}`;
        }

        case "CREATE SEQUENCE":
            return `create_sequence_${bareName(
                objectName(statement) ??
                    "sequence"
            )}`;

        case "CREATE TYPE":
            return `create_type_${bareName(
                objectName(statement) ??
                    "type"
            )}`;

        case "CREATE SCHEMA":
            return `create_schema_${bareName(
                objectName(statement) ??
                    "schema"
            )}`;

        default:
            return `ddl_${bare.length > 0 ? bare : "object"}`;
    }
}

function describeAlterTable(
    statement: string,
    bare: string
): string {

    for (
        const action of ALTER_ACTIONS
    ) {
        const match: RegExpExecArray | null =
            action.pattern.exec(statement);

        if (match !== null) {
            return action.build(
                bareName(match[1])
            );
        }
    }

    return `alter_table_${
        bare.length > 0 ? bare : "object"
    }`;
}

export function selectStatementSlug(
    objectName: string
): string {

    return `select_${slugify(objectName)}`;
}

export function insertStatementSlug(
    objectName: string
): string {

    return `insert_${slugify(objectName)}`;
}
