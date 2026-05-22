import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { evaluateConditionOp, evaluateTrigger } from "./trigger-evaluator.js";
import type { StationEventTrigger } from "./types.js";

describe("trigger evaluator", () => {
  test("supports threshold crossing operators", () => {
    assert.equal(
      evaluateConditionOp({
        operator: "goes_above",
        currentValue: 101,
        previousValue: 99,
        threshold: 100,
      }),
      true,
    );

    assert.equal(
      evaluateConditionOp({
        operator: "goes_below",
        currentValue: 18,
        previousValue: 22,
        threshold: 20,
      }),
      true,
    );
  });

  test("supports change operators", () => {
    assert.equal(
      evaluateConditionOp({
        operator: "increments_up",
        currentValue: 8,
        previousValue: 5,
        threshold: null,
      }),
      true,
    );

    assert.equal(
      evaluateConditionOp({
        operator: "changes_to",
        currentValue: "fault",
        previousValue: "running",
        threshold: "fault",
      }),
      true,
    );

    assert.equal(
      evaluateConditionOp({
        operator: "any_change",
        currentValue: "on",
        previousValue: "off",
        threshold: null,
      }),
      true,
    );
  });

  test("evaluates nested trigger groups", () => {
    const trigger: StationEventTrigger = {
      operator: "all",
      clauses: [
        {
          id: "c1",
          kind: "condition",
          tagId: "p1",
          condition: "goes_above",
          value: 100,
        },
        {
          id: "g1",
          kind: "group",
          operator: "any",
          conditions: [
            {
              id: "c2",
              kind: "condition",
              tagId: "p2",
              condition: "any_change",
              value: null,
            },
            {
              id: "c3",
              kind: "condition",
              tagId: "p3",
              condition: "changes_to",
              value: "fault",
            },
          ],
        },
      ],
    };

    const snapshots = {
      p1: { value: 101, previousValue: 99 },
      p2: { value: 1, previousValue: 1 },
      p3: { value: "fault", previousValue: "running" },
    };

    const result = evaluateTrigger({
      trigger,
      getSnapshot: (key) => {
        const snapshot = snapshots[key as keyof typeof snapshots];
        if (!snapshot) {
          return undefined;
        }
        return {
          key,
          pointId: key,
          value: snapshot.value,
          previousValue: snapshot.previousValue,
          observedAt: new Date().toISOString(),
          source: "stream",
        };
      },
    });

    assert.equal(result.matched, true);
    assert.deepEqual(result.matchedConditionIds.sort(), ["c1", "c3"]);
  });
});
