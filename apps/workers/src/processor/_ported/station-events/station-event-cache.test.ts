import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { StationEventCache } from "./station-event-cache.js";
import type { StationEventDefinition } from "./types.js";

const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function buildEvent(overrides?: Partial<StationEventDefinition>): StationEventDefinition {
  return {
    id: "evt-1",
    stationId: "station-1",
    enabled: true,
    trigger: {
      operator: "all",
      clauses: [
        {
          id: "c-1",
          kind: "condition",
          tagId: "point-a",
          condition: "goes_above",
          value: 50,
        },
        {
          id: "g-1",
          kind: "group",
          operator: "any",
          conditions: [
            {
              id: "c-2",
              kind: "condition",
              tagId: "point-b",
              deviceId: "device-1",
              condition: "any_change",
              value: null,
            },
          ],
        },
      ],
    },
    actions: [
      {
        id: "a-1",
        event: "webhook.send",
        inputs: {
          message: "{{tagValues.point-extra.value}}",
        },
      },
    ],
    ...overrides,
  };
}

describe("station event cache", () => {
  test("indexes candidate events by tag keys and action tag references", async () => {
    const cache = new StationEventCache({
      logger: testLogger,
      rpcClient: {
        async listEventsForProcessor() {
          return {
            events: [buildEvent()],
          };
        },
        async getTagSnapshotsForProcessor() {
          return { snapshots: {} };
        },
        async triggerEvent() {
          return {};
        },
      },
    });

    await cache.loadInitialSnapshot();

    assert.deepEqual(cache.getCandidateEventIds(["point-a"]), ["evt-1"]);
    assert.deepEqual(cache.getCandidateEventIds(["point-b"]), ["evt-1"]);

    const requiredKeys = cache.getAllRequiredKeys().sort();
    assert.deepEqual(requiredKeys, ["point-a", "point-b", "point-extra"]);
  });

  test("returns actionable error when initial snapshot load fails", async () => {
    const cache = new StationEventCache({
      logger: testLogger,
      rpcClient: {
        async listEventsForProcessor() {
          throw new Error("service unavailable");
        },
        async getTagSnapshotsForProcessor() {
          return { snapshots: {} };
        },
        async triggerEvent() {
          return {};
        },
      },
    });

    await assert.rejects(async () => {
      await cache.loadInitialSnapshot();
    }, /failed to load station event cache snapshot: service unavailable\./);
  });
});
