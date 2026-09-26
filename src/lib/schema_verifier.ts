/*
 * Deterministic schema verification and diffing.
 *
 * Route 2 must not trust the model to know what changed between the Oracle
 * schema and the designed PostgreSQL schema. The diff is computed here, in
 * code, from the two metadata documents. The model is only allowed to phrase
 * the resulting statements; the statements are then checked back against this
 * diff.
 */

import type {
    ColumnMetadata,
    ForeignKeyMetadata,
    SchemaMetadata,
    TableMetadata
} from "../types/types.js";

/* ============================================================
 * Parsing incoming metadata
 * ========================================================== */

export type ParseResult<T> = {
    ok: boolean;
    value: T;
    errors: string[];
};

function asRecord(
    value: unknown
): Record<string, unknown> | null {

    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value)
    ) {
        return null;
    }

    return value as Record<string, unknown>;
}

function asInt(
    value: unknown,
    fallback: number
): number {

    return typeof value === "number" &&
        Number.isFinite(value)
        ? Math.trunc(value)
        : fallback;
}

function asString(
    value: unknown,
    fallback: string
): string {

    return typeof value === "string"
        ? value
        : fallback;
}

function asNameList(
    value: unknown
): string[] {

    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter(
            (
                item: unknown
            ): boolean =>
                typeof item === "string"
        )
        .map(
            (
                item: string
            ): string =>
                item.trim()
        )
        .filter(
            (
                item: string
            ): boolean =>
                item.length > 0
        );
}

function parseColumn(
    raw: unknown
): ColumnMetadata | null {

    const record: Record<string, unknown> | null =
        asRecord(raw);

    if (record === null) {
        return null;
    }

    const columnName: string = asString(
        record.columnName,
        ""
    ).trim();

    if (columnName.length === 0) {
        return null;
    }

    const nullable: string = asString(
        record.nullable,
        "Y"
    ).toUpperCase();

    return {
        columnName,
        dataType: asString(
            record.dataType,
            "TEXT"
        ).toUpperCase(),
        /*
         * -1 is the documented "not applicable" sentinel used across the
         * pipeline. Anything else is coerced so a diff never trips over a
         * stray null coming from the Oracle metadata source.
         */
        dataLength: asInt(
            record.dataLength,
            -1
        ),
        dataPrecision: asInt(
            record.dataPrecision,
            -1
        ),
        dataScale: asInt(
            record.dataScale,
            -1
        ),
        nullable: nullable === "N" ? "N" : "Y",
        dataDefault: asString(
            record.dataDefault,
            ""
        ),
        columnId: asInt(
            record.columnId,
            0
        )
    };
}

function parsePrimaryKey(
    raw: unknown
): {
        constraintName: string;
        columns: string[];
    } {

    const record: Record<string, unknown> | null =
        asRecord(raw);

    if (record === null) {
        return {
            constraintName: "",
            columns: []
        };
    }

    return {
        constraintName: asString(
            record.constraintName,
            ""
        ),
        columns: asNameList(record.columns)
    };
}

function parseForeignKey(
    raw: unknown
): ForeignKeyMetadata | null {

    const record: Record<string, unknown> | null =
        asRecord(raw);

    if (record === null) {
        return null;
    }

    const columns: string[] = asNameList(record.columns);
    const referencedColumns: string[] = asNameList(
        record.referencedColumns
    );
    const referencedTable: string = asString(
        record.referencedTable,
        ""
    ).trim();

    if (
        columns.length === 0 ||
        referencedTable.length === 0 ||
        referencedColumns.length === 0
    ) {
        return null;
    }

    return {
        constraintName: asString(
            record.constraintName,
            ""
        ),
        columns,
        referencedTable,
        referencedColumns
    };
}

function parseTable(
    raw: unknown
): TableMetadata | null {

    const record: Record<string, unknown> | null =
        asRecord(raw);

    if (record === null) {
        return null;
    }

    const tableName: string = asString(
        record.tableName,
        ""
    ).trim();

    if (tableName.length === 0) {
        return null;
    }

    const rawColumns: unknown[] =
        Array.isArray(record.columns)
            ? record.columns
            : [];

    const columns: ColumnMetadata[] = rawColumns
        .map(parseColumn)
        .filter(
            (
                column: ColumnMetadata | null
            ): column is ColumnMetadata =>
                column !== null
        );

    const rawForeignKeys: unknown[] =
        Array.isArray(record.foreignKeys)
            ? record.foreignKeys
            : [];

    const foreignKeys: ForeignKeyMetadata[] = rawForeignKeys
        .map(parseForeignKey)
        .filter(
            (
                fk: ForeignKeyMetadata | null
            ): fk is ForeignKeyMetadata =>
                fk !== null
        );

    return {
        tableName,
        columns,
        primaryKey: parsePrimaryKey(record.primaryKey),
        foreignKeys
    };
}

export function parseSchema(
    raw: unknown
): ParseResult<SchemaMetadata> {

    const errors: string[] = [];

    const record: Record<string, unknown> | null =
        asRecord(raw);

    if (record === null) {
        return {
            ok: false,
            value: { tables: [] },
            errors: [
                "schema must be a JSON object with a \"tables\" array"
            ]
        };
    }

    if (!Array.isArray(record.tables)) {
        return {
            ok: false,
            value: { tables: [] },
            errors: [
                "schema.tables must be an array of table objects"
            ]
        };
    }

    const tables: TableMetadata[] = [];

    record.tables.forEach(
        (
            rawTable: unknown,
            index: number
        ): void => {

            const table: TableMetadata | null =
                parseTable(rawTable);

            if (table === null) {
                errors.push(
                    `tables[${index}] is not a valid table object (tableName is required)`
                );
                return;
            }

            tables.push(table);
        }
    );

    return {
        ok: errors.length === 0,
        value: { tables },
        errors
    };
}

/* ============================================================
 * Indexes
 * ========================================================== */

export function indexTables(
    schema: SchemaMetadata
): Map<string, TableMetadata> {

    const map: Map<string, TableMetadata> =
        new Map<string, TableMetadata>();

    for (
        const table of schema.tables
    ) {
        map.set(
            table.tableName.toLowerCase(),
            table
        );
    }

    return map;
}

export function columnNames(
    table: TableMetadata
): Set<string> {

    return new Set<string>(
        table.columns.map(
            (
                column: ColumnMetadata
            ): string =>
                column.columnName.toLowerCase()
        )
    );
}

/* ============================================================
 * Structural verification
 * ========================================================== */

const IDENTIFIER_PATTERN: RegExp =
    /^[A-Za-z_][A-Za-z0-9_$]*$/;

const POSTGRES_TYPES: ReadonlySet<string> = new Set([
    "bigint", "int8", "integer", "int", "int4", "smallint",
    "int2", "numeric", "decimal", "real", "double precision",
    "float8", "boolean", "bool", "char", "character",
    "varchar", "character varying", "text", "bytea",
    "date", "timestamp", "timestamptz", "time", "timetz",
    "interval", "uuid", "json", "jsonb", "xml", "money",
    "inet", "cidr", "macaddr", "bit", "varbit"
]);

/**
 * Verifies a designed PostgreSQL schema for internal consistency.
 *
 * Returns a list of human-readable problems; an empty list means the schema is
 * structurally sound and safe to diff against the Oracle source. Differences
 * between the two documents are not errors here — that is the diff's job.
 */
export function verifyTargetSchema(
    target: SchemaMetadata
): string[] {

    const errors: string[] = [];
    const seenTables: Set<string> = new Set<string>();

    for (
        const table of target.tables
    ) {
        const tableKey: string =
            table.tableName.toLowerCase();

        if (seenTables.has(tableKey)) {
            errors.push(
                `Duplicate table name in target_schema: ${table.tableName}`
            );
        }
        seenTables.add(tableKey);

        if (!IDENTIFIER_PATTERN.test(table.tableName)) {
            errors.push(
                `Invalid PostgreSQL table identifier: ${table.tableName}`
            );
        }

        if (table.columns.length === 0) {
            errors.push(
                `Table ${table.tableName} declares no columns`
            );
        }

        const seenColumns: Set<string> = new Set<string>();

        for (
            const column of table.columns
        ) {
            const columnKey: string =
                column.columnName.toLowerCase();

            if (seenColumns.has(columnKey)) {
                errors.push(
                    `Duplicate column ${table.tableName}.${column.columnName} in target_schema`
                );
            }
            seenColumns.add(columnKey);

            if (
                !IDENTIFIER_PATTERN.test(
                    column.columnName
                )
            ) {
                errors.push(
                    `Invalid PostgreSQL column identifier: ${table.tableName}.${column.columnName}`
                );
            }

            if (
                !POSTGRES_TYPES.has(
                    column.dataType
                        .toLowerCase()
                        .trim()
                )
            ) {
                errors.push(
                    `Column ${table.tableName}.${column.columnName} has non-PostgreSQL dataType "${column.dataType}"`
                );
            }

            if (
                column.nullable === "N" &&
                column.dataDefault
                    .toLowerCase()
                    .includes("null")
            ) {
                errors.push(
                    `Column ${table.tableName}.${column.columnName} is NOT NULL but defaults to NULL`
                );
            }
        }

        /* Primary key integrity. */
        const pkColumns: string[] =
            table.primaryKey.columns;

        if (pkColumns.length > 0) {
            for (
                const pkColumn of pkColumns
            ) {
                if (
                    !seenColumns.has(
                        pkColumn.toLowerCase()
                    )
                ) {
                    errors.push(
                        `Primary key on ${table.tableName} references unknown column ${pkColumn}`
                    );
                }
            }
        }

        /* Foreign key integrity: target must exist and point at real columns. */
        for (
            const fk of table.foreignKeys
        ) {
            for (
                const fkColumn of fk.columns
            ) {
                if (
                    !seenColumns.has(
                        fkColumn.toLowerCase()
                    )
                ) {
                    errors.push(
                        `Foreign key ${table.tableName}.${fk.constraintName} references unknown local column ${fkColumn}`
                    );
                }
            }

            const referencedKey: string =
                fk.referencedTable.toLowerCase();

            if (
                !seenTables.has(referencedKey)
            ) {
                errors.push(
                    `Foreign key ${table.tableName}.${fk.constraintName} references missing table ${fk.referencedTable}`
                );
                continue;
            }

            const referencedTable: TableMetadata | undefined =
                target.tables.find(
                    (
                        candidate: TableMetadata
                    ): boolean =>
                        candidate.tableName
                            .toLowerCase() ===
                        referencedKey
                );

            if (referencedTable === undefined) {
                continue;
            }

            const available: Set<string> =
                columnNames(referencedTable);

            for (
                const referencedColumn of fk.referencedColumns
            ) {
                if (
                    !available.has(
                        referencedColumn.toLowerCase()
                    )
                ) {
                    errors.push(
                        `Foreign key ${table.tableName}.${fk.constraintName} references unknown column ${fk.referencedTable}.${referencedColumn}`
                    );
                }
            }

            /*
             * A foreign key must point at a real key. The target key is
             * either the referenced table's primary key or its unique
             * constraint. Accept a primary key match; flag a reference to a
             * non-key column only when the referenced table does have a
             * primary key, since that is an unambiguous modelling error.
             */
            const referencedPk: string[] =
                referencedTable.primaryKey.columns;

            if (referencedPk.length > 0) {
                const matches: boolean =
                    referencedPk.length ===
                        fk.referencedColumns.length &&
                    referencedPk.every(
                        (
                            pkColumn: string,
                            position: number
                        ): boolean =>
                            pkColumn
                                .toLowerCase() ===
                            fk.referencedColumns[position]
                                ?.toLowerCase()
                    );

                if (!matches) {
                    errors.push(
                        `Foreign key ${table.tableName}.${fk.constraintName} must reference the primary key of ${fk.referencedTable} (${referencedPk.join(", ")})`
                    );
                }
            }
        }
    }

    if (target.tables.length === 0) {
        errors.push(
            "target_schema contains no tables — nothing to diff against the source schema"
        );
    }

    return errors;
}

/* ============================================================
 * Diff
 * ========================================================== */

export type ColumnChange = {
    column: string;
    from: string;
    to: string;
};

export type TableDiff = {
    table: string;
    added_columns: string[];
    dropped_columns: string[];
    type_changes: ColumnChange[];
    nullability_changes: ColumnChange[];
    renamed_from: string | null;
    primary_key_before: string[];
    primary_key_after: string[];
    foreign_keys_added: string[];
    foreign_keys_removed: string[];
};

export type SchemaDiff = {
    created_tables: string[];
    dropped_tables: string[];
    altered_tables: TableDiff[];
    unchanged_tables: string[];
};

const POSTGRES_TARGET_SCHEMA = "public";

function sameColumnList(
    left: string[],
    right: string[]
): boolean {

    if (left.length !== right.length) {
        return false;
    }

    return left.every(
        (
            value: string,
            position: number
        ): boolean =>
            value.toLowerCase() ===
            (right[position] ?? "")
                .toLowerCase()
    );
}

function sameType(
    column: ColumnMetadata
): string {

    return column.dataType
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Compares the Oracle source schema with the designed PostgreSQL schema and
 * classifies every difference into create / alter / drop.
 */
export function computeSchemaDiff(
    source: SchemaMetadata,
    target: SchemaMetadata
): SchemaDiff {

    const sourceTables: Map<string, TableMetadata> =
        indexTables(source);
    const targetTables: Map<string, TableMetadata> =
        indexTables(target);

    const createdTables: string[] = [];
    const droppedTables: string[] = [];
    const alteredTables: TableDiff[] = [];
    const unchangedTables: string[] = [];

    for (
        const [key, table] of targetTables
    ) {
        if (!sourceTables.has(key)) {
            createdTables.push(
                table.tableName
            );
        }
    }

    for (
        const [key, table] of sourceTables
    ) {
        if (!targetTables.has(key)) {
            droppedTables.push(
                table.tableName
            );
        }
    }

    for (
        const table of target.tables
    ) {
        const key: string =
            table.tableName.toLowerCase();

        const sourceTable: TableMetadata | undefined =
            sourceTables.get(key);

        if (sourceTable === undefined) {
            continue;
        }

        const sourceColumns: Map<string, ColumnMetadata> =
            new Map<string, ColumnMetadata>(
                sourceTable.columns.map(
                    (
                        column: ColumnMetadata
                    ): [string, ColumnMetadata] => [
                        column.columnName.toLowerCase(),
                        column
                    ]
                )
            );

        const targetColumns: Map<string, ColumnMetadata> =
            new Map<string, ColumnMetadata>(
                table.columns.map(
                    (
                        column: ColumnMetadata
                    ): [string, ColumnMetadata] => [
                        column.columnName.toLowerCase(),
                        column
                    ]
                )
            );

        const addedColumns: string[] = [];
        const droppedColumns: string[] = [];
        const typeChanges: ColumnChange[] = [];
        const nullabilityChanges: ColumnChange[] = [];

        for (
            const [columnKey, column] of targetColumns
        ) {
            const sourceColumn: ColumnMetadata | undefined =
                sourceColumns.get(columnKey);

            if (sourceColumn === undefined) {
                addedColumns.push(column.columnName);
                continue;
            }

            if (
                sameType(sourceColumn) !==
                sameType(column)
            ) {
                typeChanges.push({
                    column: column.columnName,
                    from: sourceColumn.dataType,
                    to: column.dataType
                });
            }

            if (
                sourceColumn.nullable !==
                column.nullable
            ) {
                nullabilityChanges.push({
                    column: column.columnName,
                    from: sourceColumn.nullable === "Y"
                        ? "NULLABLE"
                        : "NOT NULL",
                    to: column.nullable === "Y"
                        ? "NULLABLE"
                        : "NOT NULL"
                });
            }
        }

        for (
            const [columnKey, column] of sourceColumns
        ) {
            if (!targetColumns.has(columnKey)) {
                droppedColumns.push(column.columnName);
            }
        }

        const sourceFkKeys: Set<string> =
            new Set<string>(
                sourceTable.foreignKeys.map(
                    foreignKeyKey
                )
            );

        const targetFkKeys: Set<string> =
            new Set<string>(
                table.foreignKeys.map(
                    foreignKeyKey
                )
            );

        const foreignKeysAdded: string[] = [];
        const foreignKeysRemoved: string[] = [];

        for (
            const fk of table.foreignKeys
        ) {
            const fkKey: string = foreignKeyKey(fk);

            if (!sourceFkKeys.has(fkKey)) {
                foreignKeysAdded.push(
                    fk.constraintName.length > 0
                        ? fk.constraintName
                        : describeForeignKey(fk)
                );
            }
        }

        for (
            const fk of sourceTable.foreignKeys
        ) {
            const fkKey: string = foreignKeyKey(fk);

            if (!targetFkKeys.has(fkKey)) {
                foreignKeysRemoved.push(
                    fk.constraintName.length > 0
                        ? fk.constraintName
                        : describeForeignKey(fk)
                );
            }
        }

        const pkChanged: boolean =
            !sameColumnList(
                sourceTable.primaryKey.columns,
                table.primaryKey.columns
            );

        const hasChanges: boolean =
            addedColumns.length > 0 ||
            droppedColumns.length > 0 ||
            typeChanges.length > 0 ||
            nullabilityChanges.length > 0 ||
            pkChanged ||
            foreignKeysAdded.length > 0 ||
            foreignKeysRemoved.length > 0;

        if (!hasChanges) {
            unchangedTables.push(table.tableName);
            continue;
        }

        alteredTables.push({
            table: table.tableName,
            added_columns: addedColumns,
            dropped_columns: droppedColumns,
            type_changes: typeChanges,
            nullability_changes: nullabilityChanges,
            renamed_from: null,
            primary_key_before:
                sourceTable.primaryKey.columns,
            primary_key_after:
                table.primaryKey.columns,
            foreign_keys_added: foreignKeysAdded,
            foreign_keys_removed: foreignKeysRemoved
        });
    }

    return {
        created_tables: createdTables,
        dropped_tables: droppedTables,
        altered_tables: alteredTables,
        unchanged_tables: unchangedTables
    };
}

function foreignKeyKey(
    fk: ForeignKeyMetadata
): string {

    return [
        fk.columns.join("+"),
        fk.referencedTable.toLowerCase(),
        fk.referencedColumns.join("+")
    ].join("->");
}

function describeForeignKey(
    fk: ForeignKeyMetadata
): string {

    return `FK (${fk.columns.join(", ")}) -> ${fk.referencedTable} (${fk.referencedColumns.join(", ")})`;
}

export function isEmptyDiff(
    diff: SchemaDiff
): boolean {

    return (
        diff.created_tables.length === 0 &&
        diff.dropped_tables.length === 0 &&
        diff.altered_tables.length === 0
    );
}

export function diffCounts(
    diff: SchemaDiff
): {
        create: number;
        alter: number;
        drop: number;
    } {

    return {
        create: diff.created_tables.length,
        alter: diff.altered_tables.length,
        drop: diff.dropped_tables.length
    };
}

export { POSTGRES_TARGET_SCHEMA };
