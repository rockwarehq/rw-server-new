/**
 * Shared types and Zod schemas for the dynamic query-filter system.
 *
 * Clients send a QueryFilter JSON tree; the server validates it with Zod,
 * checks every field against a per-endpoint allowlist, then translates to
 * either a Prisma `where` clause or an in-memory row predicate.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Fixed set of supported operators — no arbitrary SQL. */
export const operatorEnum = z.enum([
  "=",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "contains",
  "beginsWith",
  "in",
  "notIn",
  "between",
  "notBetween",
  "null",
  "notNull",
]);

export const queryRuleSchema = z.object({
  field: z.string().min(1),
  operator: operatorEnum,
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]),
});

export type QueryRule = z.infer<typeof queryRuleSchema>;

export const queryFilterSchema: z.ZodType<QueryFilter> = z.lazy(() =>
  z.object({
    combinator: z.enum(["and", "or"]),
    rules: z.array(z.union([queryRuleSchema, queryFilterSchema])).max(20, "Too many filter rules (max 20 per group)"),
  }),
);

export type QueryFilter = {
  combinator: "and" | "or";
  rules: Array<QueryRule | QueryFilter>;
};

// ---------------------------------------------------------------------------
// Field allowlist types
// ---------------------------------------------------------------------------

export type FieldType = "string" | "number" | "boolean" | "uuid" | "datetime";

export interface AllowedField {
  /** The Prisma column path (e.g. "durationSeconds" or "station.name") */
  column: string;
  /** The expected value type — used for runtime validation */
  type: FieldType;
}

/** Map from client field name → allowed column definition */
export type FieldAllowlist = Record<string, AllowedField>;
