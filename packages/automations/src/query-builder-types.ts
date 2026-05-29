// Minimal vendored subset of react-querybuilder's query tree types.
//
// The UI authors conditions with react-querybuilder; the backend only needs the
// shape to evaluate them, so we vendor these two interfaces instead of pulling a
// React library into the server. The shapes are structurally compatible with
// react-querybuilder's `RuleGroupType` / `RuleType`.

export interface RuleType {
  field: string;
  operator: string;
  value: unknown;
}

export interface RuleGroupType {
  combinator: string; // "and" | "or"
  rules: Array<RuleGroupType | RuleType>;
  not?: boolean;
}
