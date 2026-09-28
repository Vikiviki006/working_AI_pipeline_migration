import {
    generateSchemaDesign
} from "./schema_design_service.js";

import {
    generateTableManagement
} from "./table_management_service.js";

import {
    DesignRejectedError
} from "../../lib/errors.js";

import {
    MANIFEST_PATH,
    TARGET_SCHEMA_PATH
} from "../../lib/file_layout.js";

import type {
    AIProviderName,
    SchemaDesignInput,
    SourceDatabase,
    TargetDatabase
} from "../../types/types.js";

import type {
    TableManagementOutput
} from "./table_management_service.js";

import type {
    ArtifactFile
} from "../../lib/file_layout.js";

export type DesignStatus =
    | "recommended"
    | "needs_change"
    | "not_recommended";
export const PROCEEDING_DESIGN_STATUSES: ReadonlySet<DesignStatus> =
    new Set<DesignStatus>([
        "recommended",
        "needs_change"
    ]);

export function shouldGenerateTableManagement(
    status: DesignStatus
): boolean {

    return PROCEEDING_DESIGN_STATUSES.has(status);
}

type DesignedSchema = {
    status: DesignStatus;
    summary: string;
    issue_reason: string;
    target_schema: unknown;
};

export type CombinedFileManifestEntry = {
    path: string;
    kind:
        | "schema"
        | "table_management"
        | "manifest";
    index?: number;
    statement?: string;
};

export type SchemaMigrationResult = {
    schema_design: {
        provider: string;
        status: DesignStatus;
        summary: string;
        issue_reason: string;
        target_schema: unknown;
    };

    table_management: {
        provider: string;
        source: SourceDatabase;
        target: TargetDatabase;
        table_management: string[];
        plan: TableManagementOutput["plan"];
        summary: string;
    };

    files: CombinedFileManifestEntry[];
};

/*
 * The schema-design pipeline.
 *
 * The design stage runs first because it is the only stage that makes design
 * decisions; the DDL stage is a pure translation of its output. Both run on the
 * provider Jev picked for this request, so the whole pipeline costs one routing
 * round-trip rather than one per stage.
 */
export async function runSchemaMigration(
    input: SchemaDesignInput,
    provider?: AIProviderName
): Promise<SchemaMigrationResult> {

    const design = await generateSchemaDesign(
        input,
        provider
    );

    const designed =
        design.result as DesignedSchema;

    if (
        !shouldGenerateTableManagement(
            designed.status
        )
    ) {
        throw new DesignRejectedError(
            `Schema design was not applied (status: ${designed.status})`,
            {
                provider: design.provider,
                status: designed.status,
                summary: designed.summary,
                issue_reason: designed.issue_reason,
                target_schema: designed.target_schema
            }
        );
    }

    const management = await generateTableManagement(
        {
            source_database: "oracle",
            target_database: "postgresql",

            /*
             * The Oracle metadata the design was based on, so the diff is
             * against the same document the design stage saw.
             */
            source_schema:
                input.selected_schema,

            target_schema:
                designed.target_schema,

            user_query: input.user_query
        },
        provider
    );

    const ddlFiles: ArtifactFile[] =
        management.result.files;

    return {
        schema_design: {
            provider: design.provider,
            status: designed.status,
            summary: designed.summary,
            issue_reason: designed.issue_reason,
            target_schema: designed.target_schema
        },

        table_management: {
            provider: management.provider,
            source: management.result.source,
            target: management.result.target,
            table_management:
                management.result.table_management,
            plan: management.result.plan,
            summary: management.result.summary
        },

        files: [
            {
                path: TARGET_SCHEMA_PATH,
                kind: "schema"
            },
            ...ddlFiles.map(
                (
                    file: ArtifactFile
                ): CombinedFileManifestEntry => ({
                    path: file.path,
                    kind: "table_management",
                    index: file.index,
                    statement: file.statement
                })
            ),
            {
                path: MANIFEST_PATH,
                kind: "manifest"
            }
        ]
    };
}
