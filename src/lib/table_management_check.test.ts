import assert from "node:assert/strict";
import { test } from "node:test";

import {
    crossCheckStatements
} from "../ai/services/table_management_service.js";

import {
    parseSchema,
    planTargetBuild
} from "./schema_verifier.js";

/*
 * Oracle side: one table with a nullable LOCATION_ID that the design splits
 * out into its own table.
 */
const SOURCE = parseSchema({
    tables: [
        {
            tableName: "DEPARTMENTS",
            columns: [
                { columnName: "DEPARTMENT_ID", dataType: "NUMBER", dataLength: -1, dataPrecision: 4, dataScale: 0, nullable: "N", dataDefault: "", columnId: 1 },
                { columnName: "DEPARTMENT_NAME", dataType: "VARCHAR2", dataLength: 30, dataPrecision: -1, dataScale: -1, nullable: "N", dataDefault: "", columnId: 2 },
                { columnName: "LOCATION_ID", dataType: "NUMBER", dataLength: -1, dataPrecision: 4, dataScale: 0, nullable: "Y", dataDefault: "", columnId: 3 }
            ],
            primaryKey: { constraintName: "DEPARTMENTS_PK", columns: ["DEPARTMENT_ID"] },
            foreignKeys: []
        }
    ]
}).value;

/*
 * The designed target. Both tables are new to PostgreSQL: the database starts
 * empty, so departments must be CREATED even though it exists in Oracle.
 */
const TARGET = parseSchema({
    tables: [
        {
            tableName: "DEPARTMENTS",
            columns: [
                { columnName: "DEPARTMENT_ID", dataType: "INTEGER", dataLength: -1, dataPrecision: -1, dataScale: -1, nullable: "N", dataDefault: "", columnId: 1 },
                { columnName: "DEPARTMENT_NAME", dataType: "VARCHAR", dataLength: 30, dataPrecision: -1, dataScale: -1, nullable: "N", dataDefault: "", columnId: 2 }
            ],
            primaryKey: { constraintName: "DEPARTMENTS_PK", columns: ["DEPARTMENT_ID"] },
            foreignKeys: []
        },
        {
            tableName: "DEPARTMENT_LOCATIONS",
            columns: [
                { columnName: "DEPARTMENT_ID", dataType: "INTEGER", dataLength: -1, dataPrecision: -1, dataScale: -1, nullable: "N", dataDefault: "", columnId: 1 },
                { columnName: "LOCATION_ID", dataType: "INTEGER", dataLength: -1, dataPrecision: -1, dataScale: -1, nullable: "N", dataDefault: "", columnId: 2 }
            ],
            primaryKey: { constraintName: "DEPARTMENT_LOCATIONS_PK", columns: ["DEPARTMENT_ID"] },
            foreignKeys: [
                {
                    constraintName: "DEPT_LOC_DEPT_FK",
                    columns: ["DEPARTMENT_ID"],
                    referencedTable: "DEPARTMENTS",
                    referencedColumns: ["DEPARTMENT_ID"]
                }
            ]
        }
    ]
}).value;

const PLAN = planTargetBuild(SOURCE, TARGET);

const CORRECT = [
    "CREATE TABLE IF NOT EXISTS public.departments (department_id INTEGER NOT NULL, department_name VARCHAR(30) NOT NULL);",
    "CREATE TABLE IF NOT EXISTS public.department_locations (department_id INTEGER NOT NULL, location_id INTEGER NOT NULL);",
    "ALTER TABLE public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (department_id);",
    "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_pkey PRIMARY KEY (department_id);",
    "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments (department_id);"
];

function check(
    statements: string[]
): string[] {

    return crossCheckStatements(
        statements,
        SOURCE,
        TARGET,
        PLAN
    );
}

/* ============================================================
 * The build plan
 * ========================================================== */

test("the plan creates every target table, including ones present in Oracle", () => {
    /*
     * Regression: a table in both Oracle and the target was classified as an
     * ALTER, so public.departments was never created while other statements
     * altered and referenced it. Against an empty database that fails with
     * 42P01 "relation does not exist".
     */
    assert.deepEqual(
        PLAN.create.map((t) => t.table).sort(),
        ["DEPARTMENTS", "DEPARTMENT_LOCATIONS"]
    );

    assert.deepEqual(PLAN.drop, []);
});

test("the plan records the Oracle to PostgreSQL type translation without generating DDL", () => {
    assert.deepEqual(PLAN.type_mappings, [
        {
            table: "DEPARTMENTS",
            column: "DEPARTMENT_ID",
            oracle: "NUMBER",
            postgresql: "INTEGER"
        },
        {
            table: "DEPARTMENTS",
            column: "DEPARTMENT_NAME",
            oracle: "VARCHAR2",
            postgresql: "VARCHAR"
        }
    ]);
});

test("the plan drops source tables the design removed", () => {
    const merged = planTargetBuild(
        SOURCE,
        parseSchema({
            tables: [
                {
                    tableName: "DEPARTMENTS",
                    columns: [
                        { columnName: "DEPARTMENT_ID", dataType: "INTEGER", dataLength: -1, dataPrecision: -1, dataScale: -1, nullable: "N", dataDefault: "", columnId: 1 },
                        { columnName: "LOCATION_ID", dataType: "INTEGER", dataLength: -1, dataPrecision: -1, dataScale: -1, nullable: "Y", dataDefault: "", columnId: 2 }
                    ],
                    primaryKey: { constraintName: "DEPARTMENTS_PK", columns: ["DEPARTMENT_ID"] },
                    foreignKeys: []
                }
            ]
        }).value
    );

    assert.deepEqual(merged.drop, []);
});

/* ============================================================
 * Accepted output
 * ========================================================== */

test("a correct build produces no errors", () => {
    assert.deepEqual(check(CORRECT), []);
});

/* ============================================================
 * Rejected output
 * ========================================================== */

test("a table present in Oracle but never created is rejected", () => {
    const errors = check([
        "CREATE TABLE IF NOT EXISTS public.department_locations (department_id INTEGER NOT NULL, location_id INTEGER NOT NULL);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments (department_id);"
    ]);

    assert.ok(
        errors.some((e) =>
            e.includes(
                "build_plan creates DEPARTMENTS, but no CREATE TABLE statement was returned"
            )
        ),
        JSON.stringify(errors)
    );
});

test("a column mutation is rejected as invalid against an empty database", () => {
    /*
     * The exact shape that previously shipped and could never run: altering
     * and dropping columns on a table that was never created.
     */
    const errors = check([
        "CREATE TABLE IF NOT EXISTS public.department_locations (department_id INTEGER NOT NULL, location_id INTEGER NOT NULL);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.departments ALTER COLUMN department_id TYPE INTEGER USING department_id::INTEGER;",
        "ALTER TABLE public.departments DROP COLUMN location_id;"
    ]);

    assert.ok(
        errors.some((e) => e.includes("ALTER COLUMN")),
        JSON.stringify(errors)
    );

    assert.ok(
        errors.some((e) => e.includes("DROP COLUMN")),
        JSON.stringify(errors)
    );

    assert.ok(
        errors.some((e) =>
            e.includes(
                "The target database is created from empty"
            )
        ),
        JSON.stringify(errors)
    );
});

test("a missing primary key constraint is rejected", () => {
    const errors = check([
        "CREATE TABLE IF NOT EXISTS public.departments (department_id INTEGER NOT NULL, department_name VARCHAR(30) NOT NULL);",
        "CREATE TABLE IF NOT EXISTS public.department_locations (department_id INTEGER NOT NULL, location_id INTEGER NOT NULL);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_pkey PRIMARY KEY (department_id);"
    ]);

    assert.ok(
        errors.some((e) =>
            e.includes(
                "no ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY was returned"
            )
        ),
        JSON.stringify(errors)
    );
});

test("a missing foreign key constraint is rejected", () => {
    const errors = check([
        "CREATE TABLE IF NOT EXISTS public.departments (department_id INTEGER NOT NULL, department_name VARCHAR(30) NOT NULL);",
        "CREATE TABLE IF NOT EXISTS public.department_locations (department_id INTEGER NOT NULL, location_id INTEGER NOT NULL);",
        "ALTER TABLE public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_pkey PRIMARY KEY (department_id);"
    ]);

    assert.ok(
        errors.some((e) =>
            e.includes("FOREIGN KEY was returned")
        ),
        JSON.stringify(errors)
    );
});

test("a CREATE TABLE missing a planned column is rejected", () => {
    const errors = check([
        "CREATE TABLE IF NOT EXISTS public.departments (department_id INTEGER NOT NULL);",
        "CREATE TABLE IF NOT EXISTS public.department_locations (department_id INTEGER NOT NULL, location_id INTEGER NOT NULL);",
        "ALTER TABLE public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments (department_id);"
    ]);

    assert.ok(
        errors.some((e) =>
            e.includes(
                "omits column DEPARTMENT_NAME"
            )
        ),
        JSON.stringify(errors)
    );
});

test("a CREATE TABLE declaring an unplanned column is rejected", () => {
    const errors = check([
        "CREATE TABLE IF NOT EXISTS public.departments (department_id INTEGER NOT NULL, department_name VARCHAR(30) NOT NULL, ghost INTEGER);",
        "CREATE TABLE IF NOT EXISTS public.department_locations (department_id INTEGER NOT NULL, location_id INTEGER NOT NULL);",
        "ALTER TABLE public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments (department_id);"
    ]);

    assert.ok(
        errors.some((e) =>
            e.includes("declares column ghost")
        ),
        JSON.stringify(errors)
    );
});

test("a constraint added before its table is created is rejected", () => {
    const errors = check([
        "ALTER TABLE public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (department_id);",
        "CREATE TABLE IF NOT EXISTS public.departments (department_id INTEGER NOT NULL, department_name VARCHAR(30) NOT NULL);",
        "CREATE TABLE IF NOT EXISTS public.department_locations (department_id INTEGER NOT NULL, location_id INTEGER NOT NULL);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments (department_id);"
    ]);

    assert.ok(
        errors.some((e) =>
            e.includes(
                "Constraints must come after the table is created"
            )
        ),
        JSON.stringify(errors)
    );
});

test("a table outside the plan is rejected, and so is a drop the plan forbids", () => {
    const unplannedTable = check([
        "CREATE TABLE IF NOT EXISTS public.departments (department_id INTEGER NOT NULL, department_name VARCHAR(30) NOT NULL);",
        "CREATE TABLE IF NOT EXISTS public.ghost (id INTEGER);",
        "CREATE TABLE IF NOT EXISTS public.department_locations (department_id INTEGER NOT NULL, location_id INTEGER NOT NULL);",
        "ALTER TABLE public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments (department_id);"
    ]);

    assert.ok(
        unplannedTable.some((e) =>
            e.includes(
                "public.ghost, which is not present in target_schema"
            )
        ),
        JSON.stringify(unplannedTable)
    );

    const badDrop = check([
        ...CORRECT,
        "DROP TABLE IF EXISTS public.departments;"
    ]);

    assert.ok(
        badDrop.some((e) =>
            e.includes(
                "contradicts the build plan"
            )
        ),
        JSON.stringify(badDrop)
    );
});

test("an unqualified object is rejected", () => {
    const errors = check([
        "CREATE TABLE IF NOT EXISTS departments (department_id INTEGER NOT NULL, department_name VARCHAR(30) NOT NULL);",
        "CREATE TABLE IF NOT EXISTS public.department_locations (department_id INTEGER NOT NULL, location_id INTEGER NOT NULL);",
        "ALTER TABLE public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_pkey PRIMARY KEY (department_id);",
        "ALTER TABLE public.department_locations ADD CONSTRAINT department_locations_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments (department_id);"
    ]);

    assert.ok(
        errors.some((e) =>
            e.includes(
                'is not schema-qualified with "public"'
            )
        ),
        JSON.stringify(errors)
    );
});
