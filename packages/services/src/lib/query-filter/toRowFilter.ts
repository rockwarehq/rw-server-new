/**
 * Translates a validated QueryFilter tree into an in-memory row predicate.
 *
 * Used for endpoints that compute rows in application code (e.g. the downtime
 * log which cross-joins entries with shifts). The same security model applies:
 * only allowlisted fields are accepted, operators are fixed, no SQL involved.
 */

import type { QueryFilter, QueryRule, FieldAllowlist, AllowedField } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a QueryFilter into a predicate function that tests rows.
 * Throws on unknown fields.
 */
export function toRowFilter<T extends Record<string, unknown>>(
  query: QueryFilter,
  allowlist: FieldAllowlist,
): (row: T) => boolean {
  const predicates = query.rules
    .map((rule) => {
      if ("rules" in rule && "combinator" in rule) {
        return toRowFilter<T>(rule as QueryFilter, allowlist);
      }
      return ruleToRowPredicate<T>(rule as QueryRule, allowlist);
    })
    .filter((p): p is (row: T) => boolean => p !== null);

  if (predicates.length === 0) return () => true;

  return query.combinator === "and"
    ? (row) => predicates.every((p) => p(row))
    : (row) => predicates.some((p) => p(row));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function ruleToRowPredicate<T extends Record<string, unknown>>(
  rule: QueryRule,
  allowlist: FieldAllowlist,
): ((row: T) => boolean) | null {
  const allowed = allowlist[rule.field];
  if (!allowed) {
    throw new BadRequestError(`Field "${rule.field}" is not queryable`);
  }

  const getValue = makeGetter<T>(allowed.column);

  if (rule.operator === "null") return (row) => getValue(row) == null;
  if (rule.operator === "notNull") return (row) => getValue(row) != null;

  // Skip incomplete rules
  if (rule.value === null || rule.value === undefined || rule.value === "") return null;

  switch (rule.operator) {
    case "=":
      return (row) => {
        const v = getValue(row);
        return v != null && coerceCompare(v, rule.value, allowed) === 0;
      };
    case "!=":
      return (row) => {
        const v = getValue(row);
        return v != null && coerceCompare(v, rule.value, allowed) !== 0;
      };
    case ">":
      return (row) => {
        const v = getValue(row);
        return v != null && coerceCompare(v, rule.value, allowed) > 0;
      };
    case "<":
      return (row) => {
        const v = getValue(row);
        return v != null && coerceCompare(v, rule.value, allowed) < 0;
      };
    case ">=":
      return (row) => {
        const v = getValue(row);
        return v != null && coerceCompare(v, rule.value, allowed) >= 0;
      };
    case "<=":
      return (row) => {
        const v = getValue(row);
        return v != null && coerceCompare(v, rule.value, allowed) <= 0;
      };
    case "contains":
      return (row) => {
        const v = getValue(row);
        return v != null && String(v).toLowerCase().includes(String(rule.value).toLowerCase());
      };
    case "beginsWith":
      return (row) => {
        const v = getValue(row);
        return v != null && String(v).toLowerCase().startsWith(String(rule.value).toLowerCase());
      };
    case "in": {
      const arr = toArray(rule.value).map((v) => normalizeForCompare(v, allowed));
      if (arr.length === 0) return null;
      return (row) => {
        const v = getValue(row);
        return v != null && arr.includes(normalizeForCompare(v, allowed));
      };
    }
    case "notIn": {
      const arr = toArray(rule.value).map((v) => normalizeForCompare(v, allowed));
      if (arr.length === 0) return null;
      return (row) => {
        const v = getValue(row);
        return v != null && !arr.includes(normalizeForCompare(v, allowed));
      };
    }
    case "between": {
      const [from, to] = toBetweenPair(rule.value, allowed);
      return (row) => {
        const v = getValue(row);
        return v != null && coerceCompare(v, from, allowed) >= 0 && coerceCompare(v, to, allowed) <= 0;
      };
    }
    case "notBetween": {
      const [from, to] = toBetweenPair(rule.value, allowed);
      return (row) => {
        const v = getValue(row);
        return v != null && (coerceCompare(v, from, allowed) < 0 || coerceCompare(v, to, allowed) > 0);
      };
    }
    default:
      return null;
  }
}

/** Create a getter for dot-notation paths (e.g. "station.name") */
function makeGetter<T extends Record<string, unknown>>(column: string): (row: T) => unknown {
  const parts = column.split(".");
  if (parts.length === 1) return (row) => row[parts[0]];
  return (row) => {
    let current: unknown = row;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  };
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  return Number(v);
}

function normalizeForCompare(v: unknown, field: AllowedField): string | number {
  if (field.type === "number") return toNumber(v);
  if (field.type === "datetime") return v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  return String(v).toLowerCase();
}

function coerceCompare(rowValue: unknown, ruleValue: unknown, field: AllowedField): number {
  if (field.type === "number" || field.type === "datetime") {
    const a = toNumber(rowValue);
    const b = toNumber(ruleValue);
    return a - b;
  }
  if (field.type === "boolean") {
    const a = rowValue === true || rowValue === "true" ? 1 : 0;
    const b = ruleValue === true || ruleValue === "true" ? 1 : 0;
    return a - b;
  }
  // string / uuid — case-insensitive
  const a = String(rowValue).toLowerCase();
  const b = String(ruleValue).toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
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

function toBetweenPair(value: unknown, _field: AllowedField): [unknown, unknown] {
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
  return [arr[0], arr[1]];
}

class BadRequestError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
