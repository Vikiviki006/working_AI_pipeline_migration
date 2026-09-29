import {
    generateSchemaDesign
} from "./schemaDesignService.js";

import {
    generateTableManagement
} from "./tableManagementService.js";

import {
    DesignRejectedError
} from "../../lib/errors.js";

import {
    MANIFEST_PATH,
    TARGET_SCHEMA_PATH
} from "../../lib/fileLayout.js";

import type {
    AIProviderName,
    RoutingDecision,
    SchemaDesignInput,
    SourceDatabase,
    TargetDatabase
} from "../../types/types.js";

import type {
    TableManagementOutput
} from "./tableManagementService.js";

import type {
    ArtifactFile
} from "../../lib/fileLayout.js";

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
        provider: AIProviderName;

        /*
         * The model that stage actually generated on, or null when the provider
         * could not name one. Carried per stage rather than once for the
         * pipeline, because the two stages can be served by different providers
         * if one of them failed and fell through the chain.
         */
        model: string | null;

        status: DesignStatus;
        summary: string;
        issue_reason: string;
        target_schema: unknown;
    };

    table_management: {
        provider: AIProviderName;
        model: string | null;
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
 * decision Jev made for this request, so the whole pipeline costs one routing
 * round-trip rather than one per stage.
 *
 * The decision is passed whole rather than just its provider, because the
 * OpenRouter model travels with it. Every stage re-asks nothing; the model a
 * request generates on is settled before the first prompt is sent.
 */
export async function runSchemaMigration(
    input: SchemaDesignInput,
    decision?: RoutingDecision
): Promise<SchemaMigrationResult> {

    const design = await generateSchemaDesign(
        input,
        decision
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

                model:
                    design.model ?? null,

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
        decision
    );

    const ddlFiles: ArtifactFile[] =
        management.result.files;

    return {
        schema_design: {
            provider: design.provider,

            model:
                design.model ?? null,

            status: designed.status,
            summary: designed.summary,
            issue_reason: designed.issue_reason,
            target_schema: designed.target_schema
        },

        table_management: {
            provider: management.provider,

            model:
                management.model ?? null,

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
