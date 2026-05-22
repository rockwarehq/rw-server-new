import type { TagValueSnapshot } from "./types.js";
import type {
  StationEventConditionOperator,
  StationEventTrigger,
  StationEventTriggerClause,
  StationEventTriggerCondition,
  StationEventTriggerGroup,
} from "./types.js";

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return parsed;
}

export function evaluateConditionOp(args: {
  operator: StationEventConditionOperator;
  currentValue: unknown;
  previousValue: unknown;
  threshold: unknown;
}): boolean {
  switch (args.operator) {
    case "goes_above": {
      const current = toNumber(args.currentValue);
      const previous = toNumber(args.previousValue);
      const threshold = toNumber(args.threshold);
      if (current === null || threshold === null) {
        return false;
      }
      return current > threshold && (previous === null || previous <= threshold);
    }
    case "goes_below": {
      const current = toNumber(args.currentValue);
      const previous = toNumber(args.previousValue);
      const threshold = toNumber(args.threshold);
      if (current === null || threshold === null) {
        return false;
      }
      return current < threshold && (previous === null || previous >= threshold);
    }
    case "increments_up": {
      const current = toNumber(args.currentValue);
      const previous = toNumber(args.previousValue);
      if (current === null || previous === null) {
        return false;
      }
      return current > previous;
    }
    case "increments_down": {
      const current = toNumber(args.currentValue);
      const previous = toNumber(args.previousValue);
      if (current === null || previous === null) {
        return false;
      }
      return current < previous;
    }
    case "changes_to": {
      return (
        String(args.currentValue) === String(args.threshold) &&
        args.currentValue !== args.previousValue
      );
    }
    case "any_change": {
      return args.currentValue !== args.previousValue;
    }
    default:
      return false;
  }
}

function conditionKey(condition: StationEventTriggerCondition): string {
  return condition.tagId;
}

function evaluateCondition(args: {
  condition: StationEventTriggerCondition;
  getSnapshot: (key: string) => TagValueSnapshot | undefined;
  matchedConditionIds: string[];
}): boolean {
  const key = conditionKey(args.condition);
  const snapshot = args.getSnapshot(key);
  if (!snapshot) {
    return false;
  }

  const matched = evaluateConditionOp({
    operator: args.condition.condition,
    currentValue: snapshot.value,
    previousValue: snapshot.previousValue,
    threshold: args.condition.value,
  });

  if (matched) {
    args.matchedConditionIds.push(args.condition.id);
  }

  return matched;
}

function applyOperator<T>(
  operator: "all" | "any",
  items: T[],
  evaluateItem: (item: T) => boolean,
): boolean {
  if (items.length === 0) {
    return false;
  }

  if (operator === "all") {
    for (const item of items) {
      if (!evaluateItem(item)) {
        return false;
      }
    }
    return true;
  }

  for (const item of items) {
    if (evaluateItem(item)) {
      return true;
    }
  }

  return false;
}

function evaluateClause(args: {
  clause: StationEventTriggerClause;
  getSnapshot: (key: string) => TagValueSnapshot | undefined;
  matchedConditionIds: string[];
}): boolean {
  if (args.clause.kind === "condition") {
    return evaluateCondition({
      condition: args.clause,
      getSnapshot: args.getSnapshot,
      matchedConditionIds: args.matchedConditionIds,
    });
  }

  return evaluateGroup({
    group: args.clause,
    getSnapshot: args.getSnapshot,
    matchedConditionIds: args.matchedConditionIds,
  });
}

function evaluateGroup(args: {
  group: StationEventTriggerGroup;
  getSnapshot: (key: string) => TagValueSnapshot | undefined;
  matchedConditionIds: string[];
}): boolean {
  return applyOperator(args.group.operator, args.group.conditions, (clause) =>
    evaluateClause({
      clause,
      getSnapshot: args.getSnapshot,
      matchedConditionIds: args.matchedConditionIds,
    }),
  );
}

export function evaluateTrigger(args: {
  trigger: StationEventTrigger;
  getSnapshot: (key: string) => TagValueSnapshot | undefined;
}): {
  matched: boolean;
  matchedConditionIds: string[];
} {
  const matchedConditionIds: string[] = [];
  const matched = applyOperator(args.trigger.operator, args.trigger.clauses, (clause) =>
    evaluateClause({
      clause,
      getSnapshot: args.getSnapshot,
      matchedConditionIds,
    }),
  );

  return {
    matched,
    matchedConditionIds,
  };
}
