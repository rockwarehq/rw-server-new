import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ParsedEvent } from "../pipeline/types.js";
import { createStationEventsProcessor } from "./station-events-processor.js";
import { StationEventCache } from "../station-events/station-event-cache.js";
import { TagSnapshotCache } from "../station-events/tag-snapshot-cache.js";
import type { StationEventDefinition } from "../station-events/types.js";

const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function createPointEvent(): ParsedEvent {
  const now = Date.now();
  return {
    id: "evt-source-1",
    topic: "/Rockware/v1/Gateway/gw-1/Device/device-1/Points",
    metadata: {
      family: "rockware",
      version: "1",
      gatewayId: "gw-1",
      deviceId: "device-1",
      resource: "Points",
      scope: "device",
    },
    receivedAt: now,
    parsedAt: now,
    payload: {
      point: {
        id: "point-1",
        value: 11,
        previousValue: 9,
        quality: "GOOD",
        timestamp: now,
        gatewayTimestamp: now,
      },
    },
    raw: Buffer.from("{}", "utf8"),
  };
}

describe("station events processor", () => {
  test("fetches missing tag snapshots and triggers matching station event", async () => {
    const missingFetchCalls: string[][] = [];
    const triggerCalls: Array<Record<string, unknown>> = [];

    const processorEvent: StationEventDefinition = {
      id: "station-event-1",
      stationId: "station-1",
      enabled: true,
      trigger: {
        operator: "all",
        clauses: [
          {
            id: "c1",
            kind: "condition",
            tagId: "point-1",
            condition: "goes_above",
            value: 10,
          },
          {
            id: "c2",
            kind: "condition",
            tagId: "point-2",
            condition: "any_change",
            value: null,
          },
        ],
      },
      actions: [
        {
          id: "a1",
          event: "webhook.send",
          inputs: {
            body: "{{tagValues.point-2.value}}",
          },
        },
      ],
    };

    const rpcClient = {
      async listEventsForProcessor() {
        return {
          events: [processorEvent],
        };
      },
      async getTagSnapshotsForProcessor(input: { tagKeys: string[] }) {
        missingFetchCalls.push(input.tagKeys);
        return {
          snapshots: {
            "point-2": {
              pointId: "point-2",
              value: 12,
              previousValue: 11,
              quality: "GOOD" as const,
              timestamp: new Date().toISOString(),
              gatewayTimestamp: new Date().toISOString(),
              processorTimestamp: new Date().toISOString(),
            },
          },
        };
      },
      async triggerEvent(input: {
        stationId: string;
        eventId: string;
        payload: Record<string, unknown>;
      }) {
        triggerCalls.push(input);
        return {};
      },
    };

    const stationEventCache = new StationEventCache({
      logger: testLogger,
      rpcClient,
    });
    await stationEventCache.loadInitialSnapshot();

    const tagSnapshotCache = new TagSnapshotCache();
    tagSnapshotCache.upsertPointReading({
      pointId: "point-1",
      deviceId: "device-1",
      value: 11,
      previousValue: 9,
      quality: "GOOD",
    });

    const processor = createStationEventsProcessor({
      config: {
        timeoutMs: 2000,
        tagFetchBatchSize: 100,
      },
      stationEventCache,
      tagSnapshotCache,
      rpcClient,
      logger: testLogger,
    });

    await processor.process(createPointEvent(), {
      processorName: processor.name,
      signal: new AbortController().signal,
      now: () => Date.now(),
      logger: testLogger,
      metrics: {
        incParsedOk() {},
        incParseError() {},
        incSubmitted() {},
        incRejected() {},
        incProcessedOk() {},
        incProcessedFailed() {},
        incDroppedOldest() {},
        setQueueDepth() {},
        setInFlight() {},
        observeProcessLatencyMs() {},
        observeEventAgeAtStartMs() {},
        setServiceUp() {},
        getSnapshotByProcessor() {
          return {};
        },
      },
    });

    assert.equal(missingFetchCalls.length, 1);
    assert.deepEqual(missingFetchCalls[0], ["point-2"]);
    assert.equal(triggerCalls.length, 1);

    const payload = triggerCalls[0]?.payload as Record<string, unknown>;
    const tagValues = payload.tagValues as Record<string, unknown>;
    assert.ok(tagValues["point-1"]);
    assert.ok(tagValues["point-2"]);
  });

  test("does not fire trigger twice for duplicate point messages", async () => {
    const triggerCalls: Array<Record<string, unknown>> = [];

    const processorEvent: StationEventDefinition = {
      id: "station-event-dup",
      stationId: "station-dup",
      enabled: true,
      trigger: {
        operator: "all",
        clauses: [
          {
            id: "c1",
            kind: "condition",
            tagId: "point-1",
            condition: "goes_above",
            value: 0,
          },
        ],
      },
      actions: [],
    };

    const rpcClient = {
      async listEventsForProcessor() {
        return { events: [processorEvent] };
      },
      async getTagSnapshotsForProcessor() {
        return { snapshots: {} };
      },
      async triggerEvent(input: {
        stationId: string;
        eventId: string;
        payload: Record<string, unknown>;
      }) {
        triggerCalls.push(input);
        return {};
      },
    };

    const stationEventCache = new StationEventCache({
      logger: testLogger,
      rpcClient,
    });
    await stationEventCache.loadInitialSnapshot();

    const tagSnapshotCache = new TagSnapshotCache();

    const processor = createStationEventsProcessor({
      config: { timeoutMs: 2000, tagFetchBatchSize: 100 },
      stationEventCache,
      tagSnapshotCache,
      rpcClient,
      logger: testLogger,
    });

    const processContext = {
      processorName: processor.name,
      signal: new AbortController().signal,
      now: () => Date.now(),
      logger: testLogger,
      metrics: {
        incParsedOk() {},
        incParseError() {},
        incSubmitted() {},
        incRejected() {},
        incProcessedOk() {},
        incProcessedFailed() {},
        incDroppedOldest() {},
        setQueueDepth() {},
        setInFlight() {},
        observeProcessLatencyMs() {},
        observeEventAgeAtStartMs() {},
        setServiceUp() {},
        getSnapshotByProcessor() {
          return {};
        },
      },
    };

    const now = Date.now();
    const makeEvent = (id: string): ParsedEvent => ({
      id,
      topic: "/Rockware/v1/Gateway/gw-1/Device/device-1/Points",
      metadata: {
        family: "rockware",
        version: "1",
        gatewayId: "gw-1",
        deviceId: "device-1",
        resource: "Points",
        scope: "device",
      },
      receivedAt: now,
      parsedAt: now,
      payload: {
        point: {
          id: "point-1",
          value: 1,
          previousValue: 0,
          quality: "GOOD",
          timestamp: now,
          gatewayTimestamp: now,
        },
      },
      raw: Buffer.from("{}", "utf8"),
    });

    // First message: seed cache and process — should fire
    tagSnapshotCache.upsertPointReading({
      pointId: "point-1",
      deviceId: "device-1",
      value: 1,
      previousValue: 0,
      quality: "GOOD",
    });
    await processor.process(makeEvent("evt-1"), processContext);
    assert.equal(triggerCalls.length, 1, "first message should fire trigger");

    // Second duplicate message: update cache and process — should NOT fire
    tagSnapshotCache.upsertPointReading({
      pointId: "point-1",
      deviceId: "device-1",
      value: 1,
      previousValue: 0,
      quality: "GOOD",
    });
    await processor.process(makeEvent("evt-2"), processContext);
    assert.equal(triggerCalls.length, 1, "duplicate message should not fire trigger again");
  });
});
