/*
 * The resolved environment, as config/env.ts exposes it. Listed here so the
 * shape a provider may rely on is visible in one place.
 */
export type EnvConfig = {
    groqApiKey: string;
    geminiApiKey: string;
    openrouterApiKey: string;
    groqModel: string;
    geminiModel: string;
    openrouterModel: string;
    jevModel: string;
    port: number;
};

export type AIProviderName =
    | "groq"
    | "gemini"
    | "openrouter";

/*
 * Providers in the order they are tried once the pinned provider has failed.
 * Indexed by the preferred provider so a fallback never repeats a provider
 * that has already been tried.
 */
export const FALLBACK_ORDER: Readonly<
    Record<
        AIProviderName,
        readonly AIProviderName[]
    >
> = {
    groq: [
        "gemini",
        "openrouter"
    ],

    gemini: [
        "groq",
        "openrouter"
    ],

    openrouter: [
        "gemini",
        "groq"
    ]
};

export type SourceDatabase = "oracle";

export type TargetDatabase = "postgresql";

export type AIRequest = {
    systemPrompt: string;
    staticContext?: string;
    dynamicPrompt: string;
    responseSchema: Record<string, unknown>;
    responseSchemaName: string;
};

export type AIResponse = {
    provider: AIProviderName;
    result: unknown;
};

export type ColumnMetadata = {
    columnName: string;
    dataType: string;
    dataLength: number;
    dataPrecision: number;
    dataScale: number;
    nullable: "Y" | "N";
    dataDefault: string;
    columnId: number;
};

export type PrimaryKeyMetadata = {
    constraintName: string;
    columns: string[];
};

export type ForeignKeyMetadata = {
    constraintName: string;
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
};

export type TableMetadata = {
    tableName: string;
    columns: ColumnMetadata[];
    primaryKey: PrimaryKeyMetadata;
    foreignKeys: ForeignKeyMetadata[];
};

export type SchemaMetadata = {
    tables: TableMetadata[];
};

export type SchemaDesignInput = {
    selected_schema: unknown;
    current_design?: unknown;
    user_query: string;
};
