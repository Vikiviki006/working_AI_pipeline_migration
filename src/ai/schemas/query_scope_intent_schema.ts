export const QUERY_SCOPE_VALUES = [
    "DATABASE_MIGRATION",
    "OUT_OF_SCOPE",
    "UNCERTAIN"
] as const;

export const QUERY_SCOPE_INTENT_VALUES = [
    "MIGRATE_DATA",
    "MIGRATE_SCHEMA",
    "SPLIT_TABLE",
    "MERGE_TABLES",
    "CREATE_TABLE",
    "RENAME_TABLE",
    "RENAME_COLUMN",
    "ADD_COLUMN",
    "REMOVE_COLUMN",
    "CHANGE_TYPE",
    "CHANGE_LENGTH",
    "CHANGE_PRECISION",
    "CHANGE_SCALE",
    "ALTER_NULLABILITY",
    "CREATE_PRIMARY_KEY",
    "MODIFY_PRIMARY_KEY",
    "CREATE_FOREIGN_KEY",
    "MODIFY_FOREIGN_KEY",
    "REMOVE_FOREIGN_KEY",
    "CREATE_UNIQUE_CONSTRAINT",
    "CREATE_CHECK_CONSTRAINT",
    "CREATE_INDEX",
    "REMOVE_INDEX",
    "CREATE_RELATIONSHIP",
    "REMOVE_RELATIONSHIP",
    "NORMALIZE_SCHEMA",
    "VALIDATE_SCHEMA",
    "GENERATE_SOURCE_SELECT",
    "GENERATE_TARGET_DDL",
    "GENERATE_TARGET_DML",
    "GENERATE_MIGRATION_QUERIES",
    "OBJECT_DDL",
    "UNKNOWN",
    "NONE"
] as const;

/*
 * The verbs an operation may carry. Declared once here and imported by the Zod
 * validator, so the vocabulary the model is offered and the vocabulary the
 * answer is held to cannot drift apart.
 */
export const QUERY_OPERATION_VERBS = [
    "CREATE",
    "RENAME",
    "ADD",
    "REMOVE",
    "SPLIT",
    "MERGE",
    "MODIFY",
    "CONVERT",
    "VALIDATE",
    "NORMALIZE",
    "MOVE",
    "GENERATE",
    "OTHER"
] as const;

/*
 * The response name is what Groq registers this shape under, so it must stay
 * stable: renaming it is a contract change, not a refactor.
 */
export const QUERY_SCOPE_INTENT_SCHEMA_NAME =
    "query_scope_intent";

export const queryScopeIntentJsonSchema:
    Record<string, unknown> = {
        type: "object",

        properties: {
            scope: {
                type: "string",

                description:
                    "DATABASE_MIGRATION when the request is a supported Oracle-to-PostgreSQL migration or schema operation. OUT_OF_SCOPE when it is not connected to this system at all. UNCERTAIN when it may be related but the intent cannot be determined.",

                enum: [
                    ...QUERY_SCOPE_VALUES
                ]
            },

            intent: {
                type: "string",

                description:
                    "The single primary intent of the request. NONE is only legal with OUT_OF_SCOPE, UNKNOWN is the only legal value with UNCERTAIN, and DATABASE_MIGRATION must carry a real intent.",

                enum: [
                    ...QUERY_SCOPE_INTENT_VALUES
                ]
            },

            reason: {
                type: "string",

                description:
                    "One short sentence explaining the classification, quoting the part of the request that decided it."
            },

            resolved_user_query: {
                type: "string",

                description:
                    "The request rewritten as a single unambiguous migration instruction, with every pronoun and placeholder resolved against the supplied Oracle metadata and every object named concretely. It must preserve the user's intent without adding or dropping steps. Empty string only when the request is out of scope."
            },

            operations: {
                type: "array",

                description:
                    "The discrete operations the request asks for, in the order it implies them. Empty for an out-of-scope or uncertain request, at least one for an in-scope one.",

                items: {
                    type: "object",

                    properties: {
                        verb: {
                            type: "string",

                            description:
                                "The kind of change this operation performs.",

                            enum: [
                                ...QUERY_OPERATION_VERBS
                            ]
                        },

                        target: {
                            type: "string",

                            description:
                                "The concrete table, column, constraint or object the operation acts on, as named in resolved_user_query. Empty string when the request does not identify one."
                        }
                    },

                    required: [
                        "verb",
                        "target"
                    ],

                    additionalProperties: false
                }
            }
        },

        required: [
            "scope",
            "intent",
            "reason",
            "resolved_user_query",
            "operations"
        ],

        additionalProperties: false
    };
