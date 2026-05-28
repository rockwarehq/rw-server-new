import type { RuleGroupType, RuleType } from "./query-builder-types.js";

/**
 * Converts the query-builder query tree into json-rules-engine conditions.
 */
export const OPERATOR_MAP: Record<string, string> = {
  "=": "equal",
  "!=": "notEqual",
  "<": "lessThan",
  "<=": "lessThanInclusive",
  ">": "greaterThan",
  ">=": "greaterThanInclusive",
  in: "in",
  notIn: "notIn",
  contains: "stringContains",
  beginsWith: "stringStartsWith",
  endsWith: "stringEndsWith",
};

export const QB_OPERATORS = Object.keys(OPERATOR_MAP);

export type EngineCondition =
  | { all: EngineCondition[] }
  | { any: EngineCondition[] }
  | { fact: string; operator: string; value: unknown };

function isGroup(node: unknown): node is RuleGroupType {
  return typeof node === "object" && node !== null && "combinator" in node && "rules" in node;
}

function isRule(node: unknown): node is RuleType {
  return typeof node === "object" && node !== null && "field" in node && "operator" in node;
}

function coerceValue(operator: string, raw: unknown): unknown {
  if ((operator === "in" || operator === "notIn") && typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string" && raw !== "") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    const n = Number(raw);
    if (!Number.isNaN(n) && /^-?\d+(?:\.\d+)?$/.test(raw)) return n;
  }
  return raw;
}

export function qbToEngineConditions(group: RuleGroupType): EngineCondition {
  const key = group.combinator === "or" ? "any" : "all";
  const children = (group.rules ?? [])
    .map((r): EngineCondition | null => {
      if (isGroup(r)) return qbToEngineConditions(r);
      if (isRule(r)) {
        const mapped = OPERATOR_MAP[r.operator] ?? r.operator;
        return { fact: r.field, operator: mapped, value: coerceValue(r.operator, r.value) };
      }
      return null;
    })
    .filter((x): x is EngineCondition => x !== null);

  return { [key]: children } as EngineCondition;
}
