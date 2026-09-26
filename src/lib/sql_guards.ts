/*
 * Pure, deterministic SQL guards.
 *
 * The AI only ever produces SQL *text*. Everything in this module exists to
 * prove, without trusting the model, that the text is exactly one statement of
 * an allowed kind, that it targets only objects which really exist in the
 * supplied metadata, and that it carries no row data.
 *
 * No LLM calls here. No I/O. Safe to unit test.
 */

export const VALUES_PLACEHOLDER =
    "{VALUES_PLACEHOLDER}";

/* ============================================================
 * Statement kinds
 * ========================================================== */

export const DDL_KINDS = [
    "CREATE SCHEMA",
    "CREATE TABLE",
    "ALTER TABLE",
    "DROP TABLE",
    "CREATE INDEX",
    "CREATE UNIQUE INDEX",
    "DROP INDEX",
    "CREATE SEQUENCE",
    "CREATE TYPE"
] as const;

const DDL_KIND_SET: ReadonlySet<string> =
    new Set<string>(DDL_KINDS);

const IDENT =
    "[A-Za-z_][A-Za-z0-9_$]*";

/* ============================================================
 * Normalisation
 * ========================================================== */

/**
 * Strips markdown fences the model sometimes wraps JSON string
 * members in, collapses all whitespace runs to a single space, and
 * guarantees exactly one trailing semicolon.
 */
export function normalizeSql(
    raw: string
): string {

    let sql: string = raw.trim();

    /* Unwrap ```sql ... ``` fences. */
    const fence =
        /^```(?:sql|postgresql|oracle)?\s*([\s\S]*?)\s*```$/i
            .exec(sql);

    if (fence !== null) {
        sql = fence[1].trim();
    }

    /* Collapse whitespace outside of string literals. */
    sql = collapseWhitespace(sql);

    /* Guarantee a single trailing semicolon. */
    sql = sql.replace(/;\s*$/, "").trimEnd();
    sql = `${sql};`;

    return sql;
}

function collapseWhitespace(
    sql: string
): string {

    let out: string = "";
    let inSingle: boolean = false;
    let inDouble: boolean = false;
    let inLineComment: boolean = false;
    let inBlockComment: boolean = false;

    for (let i = 0; i < sql.length; i += 1) {
        const ch: string = sql[i];
        const next: string = sql[i + 1] ?? "";

        if (inLineComment) {
            if (ch === "\n") {
                inLineComment = false;
                out += " ";
            }
            continue;
        }

        if (inBlockComment) {
            if (ch === "*" && next === "/") {
                inBlockComment = false;
                i += 1;
            }
            continue;
        }

        if (!inSingle && !inDouble) {
            if (ch === "-" && next === "-") {
                inLineComment = true;
                i += 1;
                continue;
            }
            if (ch === "/" && next === "*") {
                inBlockComment = true;
                i += 1;
                continue;
            }
        }

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (ch === "\"" && !inSingle) {
            inDouble = !inDouble;
        }

        if (!inSingle && !inDouble) {
            if (/\s/.test(ch)) {
                if (!out.endsWith(" ") && out.length > 0) {
                    out += " ";
                }
                continue;
            }
        }

        out += ch;
    }

    return out.trim();
}

/**
 * Splits a SQL string on semicolons that sit outside string literals and
 * comments. A migration artifact must contain exactly one statement.
 */
export function splitSqlStatements(
    sql: string
): string[] {

    const parts: string[] = [];
    let current: string = "";
    let inSingle: boolean = false;
    let inDouble: boolean = false;

    for (let i = 0; i < sql.length; i += 1) {
        const ch: string = sql[i];

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (ch === "\"" && !inSingle) {
            inDouble = !inDouble;
        }

        if (
            ch === ";" &&
            !inSingle &&
            !inDouble
        ) {
            const trimmed: string = current.trim();
            if (trimmed.length > 0) {
                parts.push(trimmed);
            }
            current = "";
            continue;
        }

        current += ch;
    }

    const tail: string = current.trim();
    if (tail.length > 0) {
        parts.push(tail);
    }

    return parts;
}

/* ============================================================
 * Kind detection
 * ========================================================== */

/**
 * Returns the canonical kind of a statement.
 *
 * Two-word DDL verbs must be resolved as a unit, otherwise "CREATE TABLE"
 * reports as "CREATE" and the allow-list check silently rejects valid
 * statements. Longest prefix wins, so "CREATE UNIQUE INDEX" beats
 * "CREATE INDEX".
 */
export function statementKind(
    sql: string
): string {

    const head: string = sql
        .replace(/;\s*$/, "")
        .trimStart()
        .toUpperCase()
        .replace(/\s+/g, " ");

    for (
        const kind of KIND_LONGEST_FIRST
    ) {
        if (
            head === kind ||
            head.startsWith(`${kind} `)
        ) {
            return kind;
        }
    }

    /* SELECT, INSERT, UPDATE, DELETE and anything unrecognised. */
    return head.split(" ")[0] ?? "";
}

const KIND_LONGEST_FIRST: readonly string[] = [
    ...DDL_KINDS
]
    .slice()
    .sort(
        (
            left: string,
            right: string
        ): number =>
            right.length - left.length
    );

export function isDdlStatement(
    sql: string
): boolean {

    return DDL_KIND_SET.has(statementKind(sql));
}

/* ============================================================
 * Forbidden-content detection
 * ========================================================== */

/**
 * Bind parameters the model must never emit. Runtime values are injected
 * by the migration engine through VALUES_PLACEHOLDER only.
 *
 * The ":name" pattern must exclude the "::" cast operator. A USING clause on
 * an ALTER COLUMN ... TYPE is mandatory DDL, and "col::NUMERIC" is a cast, not
 * a bind.
 */
const BIND_PARAM_PATTERNS: RegExp[] = [
    /* $1, $2 — PostgreSQL positional. */
    /\$\d+/,

    /* ? — JDBC / MySQL positional. */
    /(^|[\s(,=<>])[?](?=$|[\s,)])/,

    /* :name — Oracle named, but never the "::" cast operator. */
    /(?<!:):(?!:)[A-Za-z_][A-Za-z0-9_]*/,

    /* @name — T-SQL named. */
    /(^|[\s(,])@[A-Za-z_][A-Za-z0-9_]*/
];

export function findBindParameters(
    sql: string
): string[] {

    const hits: string[] = [];

    for (
        const pattern of BIND_PARAM_PATTERNS
    ) {
        const found: RegExpExecArray | null =
            pattern.exec(sql);

        if (found !== null) {
            hits.push(found[0].trim());
        }
    }

    return hits;
}

const DML_KEYWORD_PATTERN: RegExp =
    /\b(INSERT\s+INTO|UPDATE\s+[A-Za-z_]|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\b|COMMIT\b)/i;

const SELECT_PATTERN: RegExp =
    /\bSELECT\b/i;

export function containsDml(
    sql: string
): boolean {

    return DML_KEYWORD_PATTERN.test(sql);
}

export function containsSelect(
    sql: string
): boolean {

    return SELECT_PATTERN.test(sql);
}

/* ============================================================
 * Identifier extraction
 * ========================================================== */

/** Lower-cased, unqualified object name: "public.DEPARTMENTS" -> "departments". */
export function bareName(
    qualified: string
): string {

    const parts: string[] = qualified.split(".");

    const last: string =
        parts[parts.length - 1] ?? qualified;

    return last.toLowerCase();
}

const CREATE_TABLE_PATTERN: RegExp = new RegExp(
    `^CREATE\\s+(?:UNLOGGED\\s+|TEMP\\s+|TEMPORARY\\s+)?TABLE\\s+` +
    `(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT}(?:\\.${IDENT})?)`,
    "i"
);

const ALTER_TABLE_PATTERN: RegExp = new RegExp(
    `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${IDENT}(?:\\.${IDENT})?)`,
    "i"
);

const DROP_TABLE_PATTERN: RegExp = new RegExp(
    `^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT}(?:\\.${IDENT})?)`,
    "i"
);

const CREATE_INDEX_ON_PATTERN: RegExp =
    new RegExp(
        `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}\\s+ON\\s+(${IDENT}(?:\\.${IDENT})?)`,
        "i"
    );

const INSERT_PATTERN: RegExp = new RegExp(
    `^INSERT\\s+INTO\\s+(${IDENT}(?:\\.${IDENT})?)` +
    `(?:\\s*\\(([^)]*)\\))?` +
    `(?:\\s+OVERRIDING\\s+SYSTEM\\s+VALUE)?` +
    `\\s*VALUES`,
    "i"
);

/**
 * The table a DDL statement operates on, or null when the statement is not a
 * table-level DDL (schema creation, sequence creation, ...).
 */
export function ddlTargetTable(
    sql: string
): string | null {

    const body: string = sql
        .replace(/;\s*$/, "")
        .trim();

    const createIndex: RegExpExecArray | null =
        CREATE_INDEX_ON_PATTERN.exec(body);

    if (createIndex !== null) {
        return createIndex[1];
    }

    const drop: RegExpExecArray | null =
        DROP_TABLE_PATTERN.exec(body);

    if (drop !== null) {
        return drop[1];
    }

    const alter: RegExpExecArray | null =
        ALTER_TABLE_PATTERN.exec(body);

    if (alter !== null) {
        return alter[1];
    }

    const create: RegExpExecArray | null =
        CREATE_TABLE_PATTERN.exec(body);

    if (create !== null) {
        return create[1];
    }

    return null;
}

/** Index name for CREATE INDEX / DROP INDEX statements. */
export function indexName(
    sql: string
): string | null {

    const match: RegExpExecArray | null = new RegExp(
        `^(?:CREATE\\s+(?:UNIQUE\\s+)?INDEX|DROP\\s+INDEX)` +
        `(?:\\s+IF\\s+(?:NOT\\s+)?EXISTS)?\\s+(${IDENT}(?:\\.${IDENT})?)`,
        "i"
    ).exec(sql.replace(/;\s*$/, "").trim());

    return match === null ? null : match[1];
}

/** Schema, sequence, type, database or extension name for non-table DDL. */
export function objectName(
    sql: string
): string | null {

    const match: RegExpExecArray | null = new RegExp(
        `^CREATE\\s+(?:SCHEMA|SEQUENCE|TYPE|DATABASE|EXTENSION|ROLE)` +
        `(?:\\s+IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT}(?:\\.${IDENT})?)`,
        "i"
    ).exec(sql.replace(/;\s*$/, "").trim());

    return match === null ? null : match[1];
}

/* ============================================================
 * Balanced-region slicing
 * ========================================================== */

/**
 * Returns the contents between the first "(" and its matching ")".
 * Used to read a CREATE TABLE column list and an INSERT column list.
 */
function readParenBlock(
    sql: string,
    fromIndex: number
): string | null {

    const open: number = sql.indexOf("(", fromIndex);

    if (open === -1) {
        return null;
    }

    let depth: number = 0;
    let inSingle: boolean = false;
    let inDouble: boolean = false;

    for (let i = open; i < sql.length; i += 1) {
        const ch: string = sql[i];

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (
            ch === "\"" &&
            !inSingle
        ) {
            inDouble = !inDouble;
        }

        if (inSingle || inDouble) {
            continue;
        }

        if (ch === "(") {
            depth += 1;
        } else if (ch === ")") {
            depth -= 1;
            if (depth === 0) {
                return sql.slice(open + 1, i);
            }
        }
    }

    return null;
}

/** Splits on commas that are not nested inside parentheses. */
function splitTopLevel(
    body: string
): string[] {

    const parts: string[] = [];
    let depth: number = 0;
    let current: string = "";
    let inSingle: boolean = false;
    let inDouble: boolean = false;

    for (let i = 0; i < body.length; i += 1) {
        const ch: string = body[i];

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (
            ch === "\"" &&
            !inSingle
        ) {
            inDouble = !inDouble;
        }

        if (!inSingle && !inDouble) {
            if (ch === "(") {
                depth += 1;
            } else if (ch === ")") {
                depth -= 1;
            } else if (
                ch === "," &&
                depth === 0
            ) {
                parts.push(current);
                current = "";
                continue;
            }
        }

        current += ch;
    }

    parts.push(current);

    return parts
        .map(
            (
                part: string
            ): string => part.trim()
        )
        .filter(
            (
                part: string
            ): boolean =>
                part.length > 0
        );
}

const TABLE_CONSTRAINT_STARTERS: RegExp =
    /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE)\b/i;

/**
 * Column names declared in a CREATE TABLE body, in declaration order.
 * Table-level constraints are skipped; only real columns are returned.
 */
export function extractCreateTableColumns(
    sql: string
): string[] | null {

    const tableMatch: RegExpExecArray | null =
        CREATE_TABLE_PATTERN.exec(
            sql.replace(/;\s*$/, "").trim()
        );

    if (tableMatch === null) {
        return null;
    }

    const afterName: number =
        tableMatch[0].length;

    const body: string | null = readParenBlock(
        sql.replace(/;\s*$/, "").trim(),
        afterName
    );

    if (body === null) {
        return null;
    }

    const columns: string[] = [];

    for (
        const part of splitTopLevel(body)
    ) {
        if (TABLE_CONSTRAINT_STARTERS.test(part)) {
            continue;
        }

        const nameMatch: RegExpExecArray | null =
            new RegExp(`^(${IDENT})`).exec(part);

        if (nameMatch === null) {
            continue;
        }

        columns.push(nameMatch[1]);
    }

    return columns;
}

/**
 * Table-level constraint clauses found inside a CREATE TABLE body.
 *
 * The build plan requires keys to be separate ALTER TABLE ... ADD CONSTRAINT
 * statements, because a foreign key may reference a table created later in
 * the array. An inlined key would break that ordering, so these are reported
 * and rejected.
 */
export function findInlinedTableConstraints(
    sql: string
): string[] {

    const tableMatch: RegExpExecArray | null =
        CREATE_TABLE_PATTERN.exec(
            sql.replace(/;\s*$/, "").trim()
        );

    if (tableMatch === null) {
        return [];
    }

    const body: string | null = readParenBlock(
        sql.replace(/;\s*$/, "").trim(),
        tableMatch[0].length
    );

    if (body === null) {
        return [];
    }

    const found: string[] = [];

    for (
        const part of splitTopLevel(body)
    ) {
        if (TABLE_CONSTRAINT_STARTERS.test(part)) {
            found.push(
                part.split(/\s+/)[0]
                    .toUpperCase()
            );
        }
    }

    return found;
}

const COLUMN_MUTATION_PATTERNS: ReadonlyArray<{
    label: string;
    pattern: RegExp;
}> = [
    {
        label: "ADD COLUMN",
        pattern: /\bADD\s+COLUMN\b/i
    },
    {
        label: "DROP COLUMN",
        pattern: /\bDROP\s+COLUMN\b/i
    },
    {
        label: "ALTER COLUMN",
        pattern: /\bALTER\s+COLUMN\b/i
    },
    {
        label: "RENAME COLUMN",
        pattern: /\bRENAME\s+COLUMN\b/i
    },
    {
        label: "RENAME",
        pattern: /\bRENAME\s+TO\b/i
    }
];

/**
 * Detects an ALTER TABLE that mutates a column, and names the mutation.
 *
 * Against a database being built from empty these are always invalid: there is
 * no existing column to retype, add, drop or rename, so the statement fails
 * with "relation does not exist". Returns null for a statement that only adds
 * or drops a constraint, which is the form the build plan requires.
 */
export function findColumnMutation(
    sql: string
): string | null {

    if (statementKind(sql) !== "ALTER TABLE") {
        return null;
    }

    for (
        const entry of COLUMN_MUTATION_PATTERNS
    ) {
        if (entry.pattern.test(sql)) {
            return entry.label;
        }
    }

    return null;
}

export type InsertTarget = {
    table: string;
    columns: string[];
};

type AlterAction =
    | "ADD_COLUMN"
    | "DROP_COLUMN"
    | "ALTER_COLUMN"
    | "ADD_CONSTRAINT"
    | "DROP_CONSTRAINT";

const ALTER_ACTION_PATTERNS: ReadonlyArray<{
    action: AlterAction;
    pattern: RegExp;
}> = [
    {
        action: "ADD_COLUMN",
        pattern:
            /\bADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_$]*)/i
    },
    {
        action: "DROP_COLUMN",
        pattern:
            /\bDROP\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_$]*)/i
    },
    {
        action: "ALTER_COLUMN",
        pattern:
            /\bALTER\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_$]*)/i
    },
    {
        action: "ADD_CONSTRAINT",
        pattern:
            /\bADD\s+CONSTRAINT\s+([A-Za-z_][A-Za-z0-9_$]*)/i
    },
    {
        action: "DROP_CONSTRAINT",
        pattern:
            /\bDROP\s+CONSTRAINT\s+([A-Za-z_][A-Za-z0-9_$]*)/i
    }
];

/**
 * The specific thing an ALTER TABLE statement does, and the object it acts on.
 *
 * "ADD CONSTRAINT x PRIMARY KEY (...)" must be read as ADD_CONSTRAINT, not as
 * an added column, so the constraint patterns are probed first.
 */
export function parseAlterTableAction(
    sql: string
): {
        action: AlterAction;
        object: string;
    } | null {

    for (
        const entry of ALTER_ACTION_PATTERNS
    ) {
        const match: RegExpExecArray | null =
            entry.pattern.exec(sql);

        if (match !== null) {
            return {
                action: entry.action,
                object: match[1]
            };
        }
    }

    return null;
}
export function extractInsertTarget(
    sql: string
): InsertTarget | null {

    const body: string = sql
        .replace(/;\s*$/, "")
        .trim();

    const match: RegExpExecArray | null =
        INSERT_PATTERN.exec(body);

    if (match === null) {
        return null;
    }

    const columns: string[] =
        match[2] === undefined
            ? []
            : match[2]
                .split(",")
                .map(
                    (
                        part: string
                    ): string =>
                        part
                            .trim()
                            .replace(
                                new RegExp(
                                    `^"([^"]*)"$`
                                ),
                                "$1"
                            )
                )
                .filter(
                    (
                        part: string
                    ): boolean =>
                        part.length > 0
                );

    return {
        table: match[1],
        columns
    };
}

/** Every table referenced in the FROM / JOIN clauses of a SELECT. */
export function extractSelectTables(
    sql: string
): string[] {

    return extractSelectSources(sql).map(
        (
            source: SelectSource
        ): string => source.table
    );
}

/* ============================================================
 * SELECT structure
 * ========================================================== */

export type SelectSource = {
    table: string;
    alias: string | null;
};

export type ProjectedColumn = {
    /** Bare column name, lower-cased, when the item is a plain reference. */
    column: string | null;
    /** Table name or alias the reference is qualified with, lower-cased. */
    qualifier: string | null;
    /**
     * True when the projection item is a computed expression such as
     * NVL(bonus, 0) or UPPER(name), so no column existence check applies.
     */
    expression: boolean;
};

const CLAUSE_STOP_PATTERN: RegExp = new RegExp(
    `\\b(?:WHERE|GROUP\\s+BY|ORDER\\s+BY|HAVING|UNION|INTERSECT|EXCEPT` +
    `|ON|LIMIT|OFFSET|FETCH|FOR|RETURNING|START\\s+WITH|WINDOW|CONNECT\\s+BY)\\b`,
    "i"
);

const WORD_CHAR_PATTERN: RegExp =
    /[A-Za-z0-9_$]/;

/**
 * Locates the projection region of a SELECT: everything between the leading
 * SELECT keyword and the first top-level FROM. Returns null when the SELECT
 * has no FROM at all, which is the signal that column-level validation must be
 * skipped rather than guessed at.
 *
 * The FROM keyword is matched on word boundaries, so a column literally named
 * "from_date" is not mistaken for the clause.
 */
function projectionRegion(
    sql: string
): string | null {

    const body: string = sql
        .replace(/;\s*$/, "")
        .trim();

    const head: RegExpExecArray | null = new RegExp(
        `^SELECT\\s+(?:DISTINCT\\s+|ALL\\s+|UNIQUE\\s+)?`,
        "i"
    ).exec(body);

    if (head === null) {
        return null;
    }

    const start: number = head[0].length;

    let depth: number = 0;
    let inSingle: boolean = false;

    for (
        let i = start;
        i + 4 <= body.length;
        i += 1
    ) {
        const ch: string = body[i];

        if (ch === "'") {
            inSingle = !inSingle;
            continue;
        }

        if (inSingle) {
            continue;
        }

        if (ch === "(") {
            depth += 1;
            continue;
        }

        if (ch === ")") {
            depth -= 1;
            continue;
        }

        if (depth !== 0) {
            continue;
        }

        if (
            body
                .slice(i, i + 4)
                .toUpperCase() !== "FROM"
        ) {
            continue;
        }

        const before: string =
            i > 0 ? body[i - 1] : " ";
        const after: string =
            body[i + 4] ?? " ";

        if (
            WORD_CHAR_PATTERN.test(before) ||
            WORD_CHAR_PATTERN.test(after)
        ) {
            continue;
        }

        return body.slice(start, i);
    }

    return null;
}

function parseSourceFragment(
    fragment: string
): SelectSource | null {

    let text: string = fragment.trim();

    /* Drop a trailing ON clause belonging to a JOIN. */
    const onIndex: number = text.search(/\sON\s/i);

    if (onIndex !== -1) {
        text = text.slice(0, onIndex).trim();
    }

    const stop: RegExpExecArray | null =
        CLAUSE_STOP_PATTERN.exec(text);

    if (stop !== null) {
        text = text
            .slice(0, stop.index)
            .trim();
    }

    if (text.length === 0) {
        return null;
    }

    const match: RegExpExecArray | null = new RegExp(
        `^(${IDENT}(?:\\.${IDENT})?)` +
        `(?:\\s+(?:AS\\s+)?(${IDENT}))?$`,
        "i"
    ).exec(text);

    if (match === null) {
        return null;
    }

    return {
        table: match[1],
        alias:
            match[2] === undefined
                ? null
                : match[2]
    };
}

/**
 * Every table in the FROM and JOIN clauses, with the alias each one is
 * addressed by. A JOIN query must be resolved per alias, otherwise a column
 * qualified by a joined table's alias looks like it is missing from the
 * driving table.
 */
const JOIN_KEYWORD_PATTERN: RegExp = new RegExp(
    `\\b(?:NATURAL\\s+)?` +
    `(?:INNER\\s+|LEFT\\s+(?:OUTER\\s+)?|RIGHT\\s+(?:OUTER\\s+)?` +
    `|FULL\\s+(?:OUTER\\s+)?|CROSS\\s+)?JOIN\\b`,
    "gi"
);

export function extractSelectSources(
    sql: string
): SelectSource[] {

    const body: string = sql
        .replace(/;\s*$/, "")
        .trim();

    const sources: SelectSource[] = [];

    const head: RegExpExecArray | null = new RegExp(
        `^SELECT\\s+(?:DISTINCT\\s+|ALL\\s+|UNIQUE\\s+)?`,
        "i"
    ).exec(body);

    if (head === null) {
        return sources;
    }

    const fromIndex: number =
        body.toUpperCase().indexOf(" FROM ");

    if (fromIndex === -1) {
        return sources;
    }

    /*
     * Everything after the FROM keyword, with the whole join construct
     * (qualifier included) reduced to a separator, so a join list and a
     * comma list parse the same way. Keeping "LEFT" in place would hide the
     * driving table and orphan its alias.
     */
    const region: string = body
        .slice(fromIndex + 6)
        .replace(
            JOIN_KEYWORD_PATTERN,
            ","
        );

    for (
        const piece of region.split(",")
    ) {
        const source: SelectSource | null =
            parseSourceFragment(piece);

        if (source !== null) {
            sources.push(source);
        }
    }

    return sources;
}

/**
 * Projection items of a SELECT, resolved to (qualifier, column) where
 * possible. Computed items are flagged rather than guessed at.
 */
export function extractProjection(
    sql: string
): ProjectedColumn[] {

    const region: string | null =
        projectionRegion(sql);

    if (region === null) {
        return [];
    }

    return splitTopLevel(region).map(
        (
            item: string
        ): ProjectedColumn => {

            /* Strip an output alias. */
            const withoutAlias: string = item
                .trim()
                .replace(
                    /\s+AS\s+[A-Za-z_][A-Za-z0-9_$]*\s*$/i,
                    ""
                )
                .replace(
                    /\s+[A-Za-z_][A-Za-z0-9_$]*\s*$/,
                    ""
                )
                .trim();

            const qualified: RegExpExecArray | null =
                new RegExp(
                    `^(${IDENT})\\.(${IDENT})$`
                ).exec(withoutAlias);

            if (qualified !== null) {
                return {
                    column: qualified[2].toLowerCase(),
                    qualifier: qualified[1].toLowerCase(),
                    expression: false
                };
            }

            if (
                new RegExp(
                    `^${IDENT}$`
                ).test(withoutAlias)
            ) {
                return {
                    column: withoutAlias.toLowerCase(),
                    qualifier: null,
                    expression: false
                };
            }

            return {
                column: null,
                qualifier: null,
                expression: true
            };
        }
    );
}

/* ============================================================
 * Filename derivation
 * ========================================================== */

export function slugify(
    value: string
): string {

    const slug: string = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

    return slug.length > 0 ? slug : "object";
}

export function sequencePrefix(
    position: number
): string {

    return String(position + 1).padStart(3, "0");
}
