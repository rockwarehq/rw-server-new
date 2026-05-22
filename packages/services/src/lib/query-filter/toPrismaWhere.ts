/**
 * Translates a validated QueryFilter tree into a Prisma `where` clause.
 *
 * Security:
 * - Only fields present in the allowlist are accepted (400 on unknown fields).
 * - Only the fixed operator set from types.ts is allowed (enforced by Zod).
 * - Output is a Prisma `where` object — never raw SQL.
 * - This function only produces `where` shapes; it cannot produce mutations.
 */

import type { QueryFilter, QueryRule, FieldAllowlist, AllowedField } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a QueryFilter into a Prisma-compatible `where` object.
 * Throws on unknown fields or type mismatches.
 */
export function toPrismaWhere(query: QueryFilter, allowlist: FieldAllowlist): Record<string, unknown> {
  const conditions = query.rules
    .map((rule) => {
      if ("rules" in rule && "combinator" in rule) {
        return toPrismaWhere(rule as QueryFilter, allowlist);
      }
      return ruleToPrisma(rule as QueryRule, allowlist);
    })
    .filter(Boolean);

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0] as Record<string, unknown>;

  return query.combinator === "and" ? { AND: conditions } : { OR: conditions };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function ruleToPrisma(rule: QueryRule, allowlist: FieldAllowlist): Record<string, unknown> | null {
  const allowed = allowlist[rule.field];
  if (!allowed) {
    throw new BadRequestError(`Field "${rule.field}" is not queryable`);
  }

  // null/notNull don't need a value
  if (rule.operator === "null") return buildNestedWhere(allowed.column, null);
  if (rule.operator === "notNull") return buildNestedWhere(allowed.column, { not: null });

  // Skip incomplete rules (empty value)
  if (rule.value === null || rule.value === undefined || rule.value === "") return null;

  switch (rule.operator) {
    case "=":
      return buildNestedWhere(allowed.column, coerce(rule.value, allowed));
    case "!=":
      return buildNestedWhere(allowed.column, { not: coerce(rule.value, allowed) });
    case ">":
      return buildNestedWhere(allowed.column, { gt: coerce(rule.value, allowed) });
    case "<":
      return buildNestedWhere(allowed.column, { lt: coerce(rule.value, allowed) });
    case ">=":
      return buildNestedWhere(allowed.column, { gte: coerce(rule.value, allowed) });
    case "<=":
      return buildNestedWhere(allowed.column, { lte: coerce(rule.value, allowed) });
    case "contains":
      return buildNestedWhere(allowed.column, {
        contains: String(rule.value),
        mode: "insensitive",
      });
    case "beginsWith":
      return buildNestedWhere(allowed.column, {
        startsWith: String(rule.value),
        mode: "insensitive",
      });
    case "in": {
      const arr = toArray(rule.value);
      if (arr.length === 0) return null;
      return buildNestedWhere(allowed.column, { in: arr.map((v) => coerce(v, allowed)) });
    }
    case "notIn": {
      const arr = toArray(rule.value);
      if (arr.length === 0) return null;
      return buildNestedWhere(allowed.column, { notIn: arr.map((v) => coerce(v, allowed)) });
    }
    case "between": {
      const [from, to] = toBetweenPair(rule.value, allowed);
      return { AND: [buildNestedWhere(allowed.column, { gte: from }), buildNestedWhere(allowed.column, { lte: to })] };
    }
    case "notBetween": {
      const [from, to] = toBetweenPair(rule.value, allowed);
      return { OR: [buildNestedWhere(allowed.column, { lt: from }), buildNestedWhere(allowed.column, { gt: to })] };
    }
    default:
      return null;
  }
}

/**
 * Build a nested Prisma where for dot-notation column paths.
 * e.g. "station.name" → { station: { name: value } }
 */
function buildNestedWhere(column: string, value: unknown): Record<string, unknown> {
  const parts = column.split(".");
  const result: Record<string, unknown> = {};
  let current = result;
  for (let i = 0; i < parts.length - 1; i++) {
    current[parts[i]] = {};
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return result;
}

function coerce(value: unknown, field: AllowedField): unknown {
  switch (field.type) {
    case "number":
      return typeof value === "number" ? value : Number(value);
    case "boolean":
      if (typeof value === "boolean") return value;
      return value === "true" || value === "1";
    case "datetime":
      return new Date(String(value));
    default:
      return String(value);
  }
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string")
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [value];
}

function toBetweenPair(value: unknown, field: AllowedField): [unknown, unknown] {
  let arr: unknown[];
  if (Array.isArray(value)) {
    arr = value;
  } else if (typeof value === "string") {
    arr = value.split(",").map((s) => s.trim());
  } else {
    throw new BadRequestError("between/notBetween requires two values");
  }
  if (arr.length !== 2) {
    throw new BadRequestError("between/notBetween requires exactly two values");
  }
  return [coerce(arr[0], field), coerce(arr[1], field)];
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

class BadRequestError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
