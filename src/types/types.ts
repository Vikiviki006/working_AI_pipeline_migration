export type EnvConfig = {
    geminiApiKey: string;
    geminiModel: string;
    groqApiKey: string;
    groqModel: string;
};

export type AIProviderName =
    | "groq"
    | "gemini";

export type SourceDatabase = "oracle";

export type TargetDatabase = "postgresql";

/*
 * A provider-agnostic AI call description.
 *
 * The provider knows nothing about the task. The service supplies
 * the prompt, the static cacheable context and the response schema.
 */
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
