export const schemaDesignSchema = {
    type: "object",

    properties: {
        status: {
            type: "string",
            enum: ["recommended", "needs_change", "not_recommended"]
        },

        summary: { type: "string" },

        // Empty string when there is no issue (status "recommended").
        issue_reason: { type: "string" },

        target_schema: {
            type: "object",

            properties: {
                tables: {
                    type: "array",

                    items: {
                        type: "object",

                        properties: {
                            tableName: { type: "string" },

                            columns: {
                                type: "array",

                                items: {
                                    type: "object",

                                    properties: {
                                        columnName: { type: "string" },
                                        dataType: { type: "string" },
                                        // -1 means "not applicable" (no length/precision/scale for this type)
                                        dataLength: { type: "integer" },
                                        dataPrecision: { type: "integer" },
                                        dataScale: { type: "integer" },
                                        nullable: { type: "string", enum: ["Y", "N"] },
                                        // "" means no default
                                        dataDefault: { type: "string" },
                                        columnId: { type: "integer" }
                                    },

                                    required: [
                                        "columnName", "dataType", "dataLength",
                                        "dataPrecision", "dataScale", "nullable",
                                        "dataDefault", "columnId"
                                    ],

                                    additionalProperties: false
                                }
                            },

                            // Always an object. constraintName: "" and columns: [] means "no primary key".
                            primaryKey: {
                                type: "object",

                                properties: {
                                    constraintName: { type: "string" },
                                    columns: { type: "array", items: { type: "string" } }
                                },

                                required: ["constraintName", "columns"],
                                additionalProperties: false
                            },

                            foreignKeys: {
                                type: "array",

                                items: {
                                    type: "object",

                                    properties: {
                                        constraintName: { type: "string" },
                                        columns: { type: "array", items: { type: "string" } },
                                        referencedTable: { type: "string" },
                                        referencedColumns: { type: "array", items: { type: "string" } }
                                    },

                                    required: [
                                        "constraintName", "columns",
                                        "referencedTable", "referencedColumns"
                                    ],

                                    additionalProperties: false
                                }
                            }
                        },

                        required: ["tableName", "columns", "primaryKey", "foreignKeys"],
                        additionalProperties: false
                    }
                }
            },

            required: ["tables"],
            additionalProperties: false
        }
    },

    required: [
        "status", "summary", "issue_reason", "target_schema"
    ],

    additionalProperties: false
};