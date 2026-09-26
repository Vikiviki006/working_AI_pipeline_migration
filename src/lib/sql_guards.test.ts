import assert from "node:assert/strict";
import { test } from "node:test";

import {
    VALUES_PLACEHOLDER,
    ddlTargetTable,
    extractCreateTableColumns,
    extractInsertTarget,
    extractProjection,
    extractSelectSources,
    extractSelectTables,
    findBindParameters,
    normalizeSql,
    splitSqlStatements,
    statementKind
} from "./sql_guards.js";

import {
    computeSchemaDiff,
    parseSchema,
    verifyTargetSchema
} from "./schema_verifier.js";

import {
    buildFileManifest,
    describeDdlStatement
} from "./file_layout.js";

import {
    tableManagementResponseSchema
} from "../ai/schemas/table_management_schema.js";

import {
    dataMigrationResponseSchema
} from "../ai/schemas/data_migration_schema.js";

/* ============================================================
 * Fixtures
 * ========================================================== */

const ORACLE_SCHEMA = {
    tables: [
        {
            tableName: "DEPARTMENTS",
            columns: [
                {
                    columnName: "DEPARTMENT_ID",
                    dataType: "NUMBER",
                    dataLength: -1,
                    dataPrecision: 4,
                    dataScale: 0,
                    nullable: "N",
                    dataDefault: "",
                    columnId: 1
                },
                {
                    columnName: "DEPARTMENT_NAME",
                    dataType: "VARCHAR2",
                    dataLength: 30,
                    dataPrecision: -1,
                    dataScale: -1,
                    nullable: "N",
                    dataDefault: "",
                    columnId: 2
                },
                {
                    columnName: "LOCATION_ID",
                    dataType: "NUMBER",
                    dataLength: -1,
                    dataPrecision: 4,
                    dataScale: 0,
                    nullable: "Y",
                    dataDefault: "",
                    columnId: 3
                }
            ],
            primaryKey: {
                constraintName: "DEPARTMENTS_PK",
                columns: ["DEPARTMENT_ID"]
            },
            foreignKeys: []
        }
    ]
};

/* ============================================================
 * sql_guards
 * ========================================================== */

test("normalizeSql collapses whitespace and guarantees one semicolon", () => {
    assert.equal(
        normalizeSql("CREATE  TABLE   public.departments (\n  id INTEGER\n);"),
        "CREATE TABLE public.departments ( id INTEGER );"
    );

    assert.equal(
        normalizeSql("DROP TABLE public.departments"),
        "DROP TABLE public.departments;"
    );

    assert.equal(
        normalizeSql("```sql\nCREATE TABLE public.t (a INT);\n```"),
        "CREATE TABLE public.t (a INT);"
    );
});

test("splitSqlStatements keeps semicolons inside literals intact", () => {
    assert.deepEqual(
        splitSqlStatements("SELECT ';' FROM dual"),
        ["SELECT ';' FROM dual"]
    );

    assert.equal(
        splitSqlStatements(
            "SELECT 1 FROM dual; SELECT 2 FROM dual"
        ).length,
        2
    );
});

test("statementKind classifies the three table DDL verbs", () => {
    assert.equal(
        statementKind(
            "CREATE TABLE public.departments (department_id INTEGER);"
        ),
        "CREATE TABLE"
    );

    assert.equal(
        statementKind(
            "ALTER TABLE public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (department_id);"
        ),
        "ALTER TABLE"
    );

    assert.equal(
        statementKind("DROP TABLE public.departments;"),
        "DROP TABLE"
    );

    assert.equal(
        statementKind(
            "CREATE UNIQUE INDEX ux ON public.t (a);"
        ),
        "CREATE UNIQUE INDEX"
    );
});

test("ddlTargetTable resolves the qualified object for every table verb", () => {
    assert.equal(
        ddlTargetTable(
            "CREATE TABLE public.departments (department_id INTEGER NOT NULL);"
        ),
        "public.departments"
    );

    assert.equal(
        ddlTargetTable(
            "ALTER TABLE public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (department_id);"
        ),
        "public.departments"
    );

    assert.equal(
        ddlTargetTable(
            "DROP TABLE IF EXISTS public.departments;"
        ),
        "public.departments"
    );

    assert.equal(
        ddlTargetTable(
            "CREATE INDEX ix ON public.departments (location_id);"
        ),
        "public.departments"
    );
});

test("extractCreateTableColumns reads columns and skips table constraints", () => {
    const columns = extractCreateTableColumns(
        "CREATE TABLE public.departments (department_id INTEGER NOT NULL, department_name VARCHAR(100), location_id INTEGER, CONSTRAINT departments_pkey PRIMARY KEY (department_id), FOREIGN KEY (location_id) REFERENCES public.locations (location_id));"
    );

    assert.deepEqual(columns, [
        "department_id",
        "department_name",
        "location_id"
    ]);
});

test("extractInsertTarget reads table and explicit column list", () => {
    const target = extractInsertTarget(
        `INSERT INTO public.departments (department_id, department_name, location_id) VALUES ${VALUES_PLACEHOLDER};`
    );

    assert.equal(target?.table, "public.departments");
    assert.deepEqual(target?.columns, [
        "department_id",
        "department_name",
        "location_id"
    ]);
});

test("extractSelectTables and extractProjection read the projection", () => {
    const sql =
        "SELECT DEPARTMENT_ID, DEPARTMENT_NAME, LOCATION_ID FROM HR.DEPARTMENTS;";

    assert.deepEqual(extractSelectTables(sql), [
        "HR.DEPARTMENTS"
    ]);

    assert.deepEqual(
        extractProjection(sql).map((i) => i.column),
        ["department_id", "department_name", "location_id"]
    );
});

test("extractSelectSources resolves JOIN tables and their aliases", () => {
    /*
     * Regression: a merge produces a join, and a column qualified by the
     * joined table's alias must resolve to that table, not to the driving
     * table. Validating every column against the first table rejected valid
     * merge queries.
     */
    const sources = extractSelectSources(
        "SELECT e.EMPLOYEE_ID, e.FIRST_NAME, c.EMAIL FROM EMPLOYEES e JOIN EMP_CONTACT c ON e.EMPLOYEE_ID = c.EMPLOYEE_ID;"
    );

    assert.deepEqual(sources, [
        { table: "EMPLOYEES", alias: "e" },
        { table: "EMP_CONTACT", alias: "c" }
    ]);
});

test("extractSelectSources handles every join qualifier", () => {
    /*
     * Regression: "LEFT" was left in the fragment, which hid the driving
     * table and orphaned its alias, rejecting a valid merge join.
     */
    for (
        const qualifier of [
            "",
            "INNER ",
            "LEFT ",
            "LEFT OUTER ",
            "RIGHT OUTER ",
            "FULL OUTER ",
            "CROSS "
        ]
    ) {
        assert.deepEqual(
            extractSelectSources(
                `SELECT e.EMPLOYEE_ID, c.EMAIL FROM EMPLOYEES e ${qualifier}JOIN EMP_CONTACT c ON e.EMPLOYEE_ID = c.EMPLOYEE_ID;`
            ),
            [
                { table: "EMPLOYEES", alias: "e" },
                { table: "EMP_CONTACT", alias: "c" }
            ],
            `failed for qualifier "${qualifier.trim()}"`
        );
    }
});

test("extractSelectSources handles comma joins, AS aliases and no alias", () => {
    assert.deepEqual(
        extractSelectSources(
            "SELECT a.ID, b.NAME FROM HR.A a, HR.B AS b;"
        ),
        [
            { table: "HR.A", alias: "a" },
            { table: "HR.B", alias: "b" }
        ]
    );

    assert.deepEqual(
        extractSelectSources(
            "SELECT ID FROM HR.DEPARTMENTS WHERE CITY = 'FROMTEST';"
        ),
        [
            { table: "HR.DEPARTMENTS", alias: null }
        ]
    );
});

test("extractProjection separates qualified refs, plain refs and expressions", () => {
    const projection = extractProjection(
        "SELECT e.EMPLOYEE_ID, c.EMAIL, NVL(c.PHONE, 'N/A') AS PHONE FROM EMPLOYEES e JOIN EMP_CONTACT c ON e.EMPLOYEE_ID = c.EMPLOYEE_ID;"
    );

    assert.deepEqual(projection, [
        {
            column: "employee_id",
            qualifier: "e",
            expression: false
        },
        {
            column: "email",
            qualifier: "c",
            expression: false
        },
        {
            column: null,
            qualifier: null,
            expression: true
        }
    ]);
});

test("extractProjection keeps comma nesting intact and handles DISTINCT", () => {
    const projection = extractProjection(
        "SELECT DISTINCT DECODE(a, 1, 'X', 2, 'Y'), b FROM T a;"
    );

    assert.equal(projection.length, 2);
    assert.equal(projection[0].expression, true);
    assert.equal(projection[1].column, "b");
});

test("findBindParameters rejects positional and named binds", () => {
    assert.ok(
        findBindParameters(
            "SELECT * FROM t WHERE id = $1"
        ).length > 0
    );

    assert.ok(
        findBindParameters(
            "SELECT * FROM t WHERE id = :pid"
        ).length > 0
    );

    assert.equal(
        findBindParameters(
            `INSERT INTO t (a) VALUES ${VALUES_PLACEHOLDER};`
        ).length,
        0
    );
});

test("findBindParameters does not mistake a :: cast for a named bind", () => {
    /*
     * Regression: a USING clause on a type change is mandatory DDL, and its
     * "::" cast must not be read as an Oracle ":name" bind parameter.
     */
    assert.deepEqual(
        findBindParameters(
            "ALTER TABLE public.departments ALTER COLUMN department_id TYPE NUMERIC USING department_id::NUMERIC;"
        ),
        []
    );

    assert.deepEqual(
        findBindParameters(
            "ALTER TABLE public.t ALTER COLUMN a TYPE TEXT USING a::TEXT"
        ),
        []
    );
});

/* ============================================================
 * table_management response validation
 * ========================================================== */

test("table_management accepts the documented example", () => {
    const parsed = tableManagementResponseSchema.safeParse({
        source: "oracle",
        target: "postgresql",
        table_management: [
            "CREATE TABLE public.departments (department_id INTEGER NOT NULL, department_name VARCHAR(100), location_id INTEGER);",
            "ALTER TABLE public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (department_id);",
            "DROP TABLE public.legacy_audit;"
        ],
        summary: "1 created, 0 altered, 1 dropped."
    });

    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test("table_management rejects DML, SELECT, multi-statements and bad kinds", () => {
    const cases: string[][] = [
        ["INSERT INTO public.t (a) VALUES {VALUES_PLACEHOLDER};"],
        ["SELECT * FROM public.t;"],
        ["CREATE TABLE public.t (a INT); DROP TABLE public.u;"],
        ["TRUNCATE TABLE public.t;"],
        ["CREATE TABLE public.t (a INT)"],
        ["CREATE TABLE public.t (a $1);"]
    ];

    for (const [statement] of cases) {
        const parsed = tableManagementResponseSchema.safeParse({
            source: "oracle",
            target: "postgresql",
            table_management: [statement],
            summary: "x"
        });

        assert.equal(
            parsed.success,
            false,
            `should have been rejected: ${statement}`
        );
    }
});

test("table_management accepts an empty array for an unchanged schema", () => {
    const parsed = tableManagementResponseSchema.safeParse({
        source: "oracle",
        target: "postgresql",
        table_management: [],
        summary: "no change"
    });

    assert.equal(parsed.success, true);
});

/* ============================================================
 * data_migration response validation
 * ========================================================== */

test("data_migration accepts the documented example", () => {
    const parsed = dataMigrationResponseSchema.safeParse({
        source: "oracle",
        target: "postgresql",
        data_extraction: [
            "SELECT DEPARTMENT_ID, DEPARTMENT_NAME, LOCATION_ID FROM HR.DEPARTMENTS;"
        ],
        data_management: [
            `INSERT INTO public.departments (department_id, department_name, location_id) VALUES ${VALUES_PLACEHOLDER};`
        ],
        summary: "1 pair."
    });

    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test("data_migration rejects a literal value beside the placeholder", () => {
    const parsed = dataMigrationResponseSchema.safeParse({
        source: "oracle",
        target: "postgresql",
        data_extraction: [
            "SELECT DEPARTMENT_ID FROM HR.DEPARTMENTS;"
        ],
        data_management: [
            `INSERT INTO public.departments (department_id) VALUES (1, ${VALUES_PLACEHOLDER});`
        ],
        summary: "x"
    });

    assert.equal(parsed.success, false);
});

test("data_migration rejects star projection and non-SELECT extraction", () => {
    const star = dataMigrationResponseSchema.safeParse({
        source: "oracle",
        target: "postgresql",
        data_extraction: ["SELECT * FROM HR.DEPARTMENTS;"],
        data_management: [
            `INSERT INTO public.departments (department_id) VALUES ${VALUES_PLACEHOLDER};`
        ],
        summary: "x"
    });

    assert.equal(star.success, false);

    const notSelect = dataMigrationResponseSchema.safeParse({
        source: "oracle",
        target: "postgresql",
        data_extraction: ["DELETE FROM HR.DEPARTMENTS;"],
        data_management: [
            `INSERT INTO public.departments (department_id) VALUES ${VALUES_PLACEHOLDER};`
        ],
        summary: "x"
    });

    assert.equal(notSelect.success, false);
});

test("data_migration rejects mismatched parallel array lengths", () => {
    const parsed = dataMigrationResponseSchema.safeParse({
        source: "oracle",
        target: "postgresql",
        data_extraction: [
            "SELECT DEPARTMENT_ID FROM HR.DEPARTMENTS;",
            "SELECT LOCATION_ID FROM HR.LOCATIONS;"
        ],
        data_management: [
            `INSERT INTO public.departments (department_id) VALUES ${VALUES_PLACEHOLDER};`
        ],
        summary: "x"
    });

    assert.equal(parsed.success, false);
});

/* ============================================================
 * schema_verifier
 * ========================================================== */

test("parseSchema tolerates Oracle nulls in numeric fields", () => {
    const parsed = parseSchema({
        tables: [
            {
                tableName: "T",
                columns: [
                    {
                        columnName: "A",
                        dataType: "VARCHAR2",
                        dataLength: null,
                        dataPrecision: null,
                        dataScale: null,
                        nullable: "Y",
                        dataDefault: null,
                        columnId: 1
                    }
                ],
                primaryKey: null,
                foreignKeys: null
            }
        ]
    });

    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
    assert.equal(parsed.value.tables[0].columns[0].dataLength, -1);
    assert.deepEqual(
        parsed.value.tables[0].primaryKey,
        { constraintName: "", columns: [] }
    );
});

test("parseSchema rejects a non-schema document", () => {
    assert.equal(parseSchema(null).ok, false);
    assert.equal(parseSchema({}).ok, false);
    assert.equal(
        parseSchema({ tables: "nope" }).ok,
        false
    );
});

test("verifyTargetSchema catches bad PK, FK and type declarations", () => {
    const errors = verifyTargetSchema(
        parseSchema({
            tables: [
                {
                    tableName: "orders",
                    columns: [
                        {
                            columnName: "id",
                            dataType: "INTEGER",
                            dataLength: -1,
                            dataPrecision: -1,
                            dataScale: -1,
                            nullable: "N",
                            dataDefault: "",
                            columnId: 1
                        }
                    ],
                    primaryKey: {
                        constraintName: "orders_pkey",
                        columns: ["missing_column"]
                    },
                    foreignKeys: [
                        {
                            constraintName: "orders_fkey",
                            columns: ["id"],
                            referencedTable: "ghost",
                            referencedColumns: ["id"]
                        }
                    ]
                },
                {
                    tableName: "legacy",
                    columns: [
                        {
                            columnName: "x",
                            dataType: "VARCHAR2",
                            dataLength: 10,
                            dataPrecision: -1,
                            dataScale: -1,
                            nullable: "Y",
                            dataDefault: "",
                            columnId: 1
                        }
                    ],
                    primaryKey: {
                        constraintName: "",
                        columns: []
                    },
                    foreignKeys: []
                }
            ]
        }).value
    );

    assert.ok(
        errors.some((e) => e.includes("unknown column missing_column")),
        JSON.stringify(errors)
    );

    assert.ok(
        errors.some((e) => e.includes("missing table ghost")),
        JSON.stringify(errors)
    );

    assert.ok(
        errors.some((e) => e.includes("non-PostgreSQL dataType")),
        JSON.stringify(errors)
    );
});

test("verifyTargetSchema accepts a clean designed schema", () => {
    const errors = verifyTargetSchema(
        parseSchema({
            tables: [
                {
                    tableName: "locations",
                    columns: [
                        {
                            columnName: "location_id",
                            dataType: "INTEGER",
                            dataLength: -1,
                            dataPrecision: -1,
                            dataScale: -1,
                            nullable: "N",
                            dataDefault: "",
                            columnId: 1
                        }
                    ],
                    primaryKey: {
                        constraintName: "locations_pkey",
                        columns: ["location_id"]
                    },
                    foreignKeys: []
                },
                {
                    tableName: "departments",
                    columns: [
                        {
                            columnName: "department_id",
                            dataType: "INTEGER",
                            dataLength: -1,
                            dataPrecision: -1,
                            dataScale: -1,
                            nullable: "N",
                            dataDefault: "",
                            columnId: 1
                        },
                        {
                            columnName: "location_id",
                            dataType: "INTEGER",
                            dataLength: -1,
                            dataPrecision: -1,
                            dataScale: -1,
                            nullable: "Y",
                            dataDefault: "",
                            columnId: 2
                        }
                    ],
                    primaryKey: {
                        constraintName: "departments_pkey",
                        columns: ["department_id"]
                    },
                    foreignKeys: [
                        {
                            constraintName: "departments_location_id_fkey",
                            columns: ["location_id"],
                            referencedTable: "locations",
                            referencedColumns: ["location_id"]
                        }
                    ]
                }
            ]
        }).value
    );

    assert.deepEqual(errors, []);
});

test("computeSchemaDiff detects a split into create + alter", () => {
    const source = parseSchema(ORACLE_SCHEMA).value;

    const target = parseSchema({
        tables: [
            {
                tableName: "departments",
                columns: [
                    {
                        columnName: "department_id",
                        dataType: "INTEGER",
                        dataLength: -1,
                        dataPrecision: -1,
                        dataScale: -1,
                        nullable: "N",
                        dataDefault: "",
                        columnId: 1
                    },
                    {
                        columnName: "department_name",
                        dataType: "VARCHAR",
                        dataLength: 30,
                        dataPrecision: -1,
                        dataScale: -1,
                        nullable: "N",
                        dataDefault: "",
                        columnId: 2
                    }
                ],
                primaryKey: {
                    constraintName: "departments_pkey",
                    columns: ["department_id"]
                },
                foreignKeys: []
            },
            {
                tableName: "department_locations",
                columns: [
                    {
                        columnName: "department_id",
                        dataType: "INTEGER",
                        dataLength: -1,
                        dataPrecision: -1,
                        dataScale: -1,
                        nullable: "N",
                        dataDefault: "",
                        columnId: 1
                    },
                    {
                        columnName: "location_id",
                        dataType: "INTEGER",
                        dataLength: -1,
                        dataPrecision: -1,
                        dataScale: -1,
                        nullable: "Y",
                        dataDefault: "",
                        columnId: 2
                    }
                ],
                primaryKey: {
                    constraintName: "department_locations_pkey",
                    columns: ["department_id"]
                },
                foreignKeys: []
            }
        ]
    }).value;

    const diff = computeSchemaDiff(source, target);

    assert.deepEqual(diff.created_tables, [
        "department_locations"
    ]);

    assert.deepEqual(diff.dropped_tables, []);

    const altered = diff.altered_tables.find(
        (t) => t.table === "departments"
    );

    assert.ok(altered, "departments should be altered");
    assert.deepEqual(altered.dropped_columns, [
        "LOCATION_ID"
    ]);
});

test("computeSchemaDiff detects a merge into drop and reports no change when identical", () => {    const source = parseSchema({
        tables: [
            {
                tableName: "EMP_PROFILE",
                columns: [
                    {
                        columnName: "EMP_ID",
                        dataType: "NUMBER",
                        dataLength: -1,
                        dataPrecision: 10,
                        dataScale: 0,
                        nullable: "N",
                        dataDefault: "",
                        columnId: 1
                    }
                ],
                primaryKey: {
                    constraintName: "EMP_PROFILE_PK",
                    columns: ["EMP_ID"]
                },
                foreignKeys: []
            }
        ]
    }).value;

    const merged = computeSchemaDiff(
        source,
        parseSchema({
            tables: [
                {
                    tableName: "employees",
                    columns: [
                        {
                            columnName: "emp_id",
                            dataType: "INTEGER",
                            dataLength: -1,
                            dataPrecision: -1,
                            dataScale: -1,
                            nullable: "N",
                            dataDefault: "",
                            columnId: 1
                        }
                    ],
                    primaryKey: {
                        constraintName: "employees_pkey",
                        columns: ["emp_id"]
                    },
                    foreignKeys: []
                }
            ]
        }).value
    );

    assert.deepEqual(merged.created_tables, [
        "employees"
    ]);
    assert.deepEqual(merged.dropped_tables, [
        "EMP_PROFILE"
    ]);

    const identical = computeSchemaDiff(
        parseSchema(ORACLE_SCHEMA).value,
        parseSchema({
            tables: [
                {
                    ...ORACLE_SCHEMA
                        .tables[0],
                    tableName: "DEPARTMENTS"
                }
            ]
        }).value
    );

    assert.deepEqual(identical.created_tables, []);
    assert.deepEqual(identical.dropped_tables, []);
    assert.deepEqual(identical.altered_tables, []);
    assert.deepEqual(identical.unchanged_tables, [
        "DEPARTMENTS"
    ]);
});

/* ============================================================
 * file_layout
 * ========================================================== */

test("describeDdlStatement gives distinct names to statements on the same table", () => {
    /*
     * Regression: three different statements all target
     * public.department_locations, so the bare table name is not enough to
     * name a file. They must not collapse onto one another.
     */
    const statements = [
        "CREATE TABLE public.department_locations (department_id INTEGER NOT NULL, location_id INTEGER);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_dept_fkey FOREIGN KEY (department_id) REFERENCES public.departments (department_id);",
        "ALTER TABLE public.departments DROP COLUMN location_id;",
        "ALTER TABLE public.departments ALTER COLUMN department_id TYPE INTEGER USING department_id::INTEGER;",
        "ALTER TABLE public.departments ALTER COLUMN location_id SET NOT NULL;",
        "DROP TABLE public.legacy_audit;",
        "CREATE UNIQUE INDEX ux_departments_name ON public.departments (department_name);",
        "CREATE SEQUENCE IF NOT EXISTS public.dept_seq;"
    ];

    const names = statements.map(describeDdlStatement);

    assert.equal(
        new Set(names).size,
        names.length,
        `filenames collided: ${JSON.stringify(names)}`
    );

    assert.equal(
        names[0],
        "create_table_department_locations"
    );
    assert.equal(
        names[1],
        "alter_table_add_constraint_department_locations_pkey"
    );
    assert.equal(
        names[3],
        "alter_table_drop_column_location_id"
    );
    assert.equal(
        names[4],
        "alter_table_alter_column_department_id_type"
    );
    assert.equal(
        names[5],
        "alter_table_set_not_null_location_id"
    );
    assert.equal(
        names[6],
        "drop_table_legacy_audit"
    );
    assert.equal(
        names[8],
        "create_sequence_dept_seq"
    );
});

test("buildFileManifest numbers sequentially and never collides", () => {
    const statements = [
        "CREATE TABLE public.a (id INTEGER);",
        "CREATE TABLE public.b (id INTEGER);",
        "INSERT INTO public.a (id) VALUES {VALUES_PLACEHOLDER};"
    ];

    const ddlFiles = buildFileManifest(
        "table_management",
        [statements[0], statements[1]],
        describeDdlStatement
    );

    assert.deepEqual(
        ddlFiles.map((f) => f.path),
        [
            "migration/postgres/ddl/001_create_table_a.sql",
            "migration/postgres/ddl/002_create_table_b.sql"
        ]
    );

    const dmlFiles = buildFileManifest(
        "data_management",
        [statements[2]],
        () => "insert_a",
        ddlFiles.length
    );

    assert.deepEqual(
        dmlFiles.map((f) => f.path),
        ["migration/postgres/dml/003_insert_a.sql"]
    );

    const paths = [
        ...ddlFiles.map((f) => f.path),
        ...dmlFiles.map((f) => f.path)
    ];

    assert.equal(
        new Set(paths).size,
        paths.length
    );
});
