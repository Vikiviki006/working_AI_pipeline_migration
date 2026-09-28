/*
 * The guard's answer, validated after it comes back from a provider.
 *
 * Structure and vocabulary are inherited from the JSON Schema in
 * query_scope_intent_schema.ts so the shape the model was asked for and the
 * shape the answer is held to are the same one. This file adds what JSON
 * Schema cannot express: the scope/intent/operations pairing rules, and the
 * guarantee that a resolved query exists whenever the pipeline is going to
 * plan work against one.
 */

import { z } from "zod";

import {
    QUERY_OPERATION_VERBS,
    QUERY_SCOPE_INTENT_VALUES,
    QUERY_SCOPE_VALUES
} from "./query_scope_intent_schema.js";

export const QueryOperationSchema =
    z.object(
        {
            verb: z.enum(
                QUERY_OPERATION_VERBS
            ),

            target: z.string()
        }
    )
    .strict();

export const QueryScopeIntentSchema =
    z.object({
        scope: z.enum(
            QUERY_SCOPE_VALUES
        ),

        intent: z.enum(
            QUERY_SCOPE_INTENT_VALUES
        ),

        reason: z.string(),

        /*
         * The rewritten request, and the field the rest of the pipeline is
         * planned against. Whether it is usable is decided by the
         * scope-dependent rules below rather than by shape.
         */
        resolved_user_query: z.string(),

        operations: z.array(
            QueryOperationSchema
        )
    })
    .strict()
    .superRefine(
        (
            value: {
                scope: typeof QUERY_SCOPE_VALUES[number];
                intent: typeof QUERY_SCOPE_INTENT_VALUES[number];
                resolved_user_query: string;
                operations: z.infer<
                    typeof QueryOperationSchema
                >[];
            },
            context: z.RefinementCtx
        ): void => {

            const resolvedIsEmpty: boolean =
                value.resolved_user_query.trim()
                    .length === 0;

            /*
             * The three rules exist to stop the failure mode that matters:
             * an unrelated request being dressed up as a migration request
             * with a fabricated or blank intent, which would then be fed
             * into the design and DDL stages as real work.
             */
            if (
                value.scope ===
                    "OUT_OF_SCOPE"
            ) {

                if (
                    value.intent !==
                        "NONE"
                ) {
                    context.addIssue({
                        code: "custom",
                        path: ["intent"],
                        message:
                            "OUT_OF_SCOPE requests must use intent NONE."
                    });
                }

                if (
                    !resolvedIsEmpty
                ) {
                    context.addIssue({
                        code: "custom",
                        path: ["resolved_user_query"],
                        message:
                            "OUT_OF_SCOPE requests must leave resolved_user_query empty."
                    });
                }

                if (
                    value.operations.length > 0
                ) {
                    context.addIssue({
                        code: "custom",
                        path: ["operations"],
                        message:
                            "OUT_OF_SCOPE requests must not declare any operations."
                    });
                }

                return;
            }

            if (
                value.scope ===
                    "UNCERTAIN"
            ) {

                if (
                    value.intent !==
                        "UNKNOWN"
                ) {
                    context.addIssue({
                        code: "custom",
                        path: ["intent"],
                        message:
                            "UNCERTAIN requests must use intent UNKNOWN."
                    });
                }

                if (
                    value.operations.length > 0
                ) {
                    context.addIssue({
                        code: "custom",
                        path: ["operations"],
                        message:
                            "UNCERTAIN requests must not declare any operations."
                    });
                }

                return;
            }

            /*
             * DATABASE_MIGRATION. The rest of the pipeline plans against
             * resolved_user_query and reports operations, so an in-scope
             * answer without them is unusable rather than merely thin.
             */
            if (
                value.intent ===
                    "NONE" ||
                value.intent ===
                    "UNKNOWN"
            ) {
                context.addIssue({
                    code: "custom",
                    path: ["intent"],
                    message:
                        "DATABASE_MIGRATION requests must have a real intent."
                });
            }

            if (
                resolvedIsEmpty
            ) {
                context.addIssue({
                    code: "custom",
                    path: ["resolved_user_query"],
                    message:
                        "DATABASE_MIGRATION requests must resolve the user query into a concrete migration instruction."
                });
            }

            if (
                value.operations.length === 0
            ) {
                context.addIssue({
                    code: "custom",
                    path: ["operations"],
                    message:
                        "DATABASE_MIGRATION requests must declare at least one operation."
                });
            }
        }
    );

export type QueryScopeIntent =
    z.infer<
        typeof QueryScopeIntentSchema
    >;

export type QueryOperation =
    z.infer<
        typeof QueryOperationSchema
    >;
