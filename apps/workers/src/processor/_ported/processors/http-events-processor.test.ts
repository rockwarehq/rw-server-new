import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Metrics, ParsedEvent, ProcessorContext } from "../pipeline/types.js";
import { createHttpEventsProcessor } from "./http-events-processor.js";

const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const testMetrics: Metrics = {
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
};

function createContext(processorName: string): ProcessorContext {
  return {
    processorName,
    signal: new AbortController().signal,
    now: () => Date.now(),
    logger: testLogger,
    metrics: testMetrics,
  };
}

function createPointEvent(id: string): ParsedEvent {
  const now = Date.now();
  return {
    id,
    topic: "/Rockware/v7/Gateway/gateway-123/Device/device-456/Points",
    metadata: {
      family: "rockware",
      version: "7",
      gatewayId: "gateway-123",
      deviceId: "device-456",
      resource: "Points",
      scope: "device",
    },
    receivedAt: now,
    parsedAt: now,
    payload: {
      point: {
        pointValueId: "0194f3f6-d64e-7e83-8764-4fd4d40f5b08",
        id: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
        quality: "GOOD",
        valueRaw: 5355,
        previousValueRaw: 5354,
        value: 5355,
        previousValue: 5354,
        timestamp: 1771349900512,
        gatewayTimestamp: 1771349900516,
      },
    },
    raw: Buffer.from(JSON.stringify({ id })),
  };
}

function createHealthEvent(id: string): ParsedEvent {
  const now = Date.now();
  return {
    id,
    topic: "/Rockware/v7/Gateway/gateway-123/Health",
    metadata: {
      family: "rockware",
      version: "7",
      gatewayId: "gateway-123",
      resource: "Health",
      scope: "gateway",
    },
    receivedAt: now,
    parsedAt: now,
    payload: { status: "up" },
    raw: Buffer.from(JSON.stringify({ id })),
  };
}

describe("createHttpEventsProcessor", () => {
  test("publishes point values via RPC ingest", async () => {
    const ingested: Array<unknown> = [];
    const processor = createHttpEventsProcessor({
      config: {
        eventsUrl: "https://workspace.example.test",
        timeoutMs: 2_000,
        authToken: "secret-token",
      },
      logger: testLogger,
      ingestClient: {
        async ingest(input) {
          ingested.push(input);
        },
      },
    });

    await processor.process(createPointEvent("e-success"), createContext(processor.name));

    assert.equal(ingested.length, 1);
    assert.deepEqual(ingested[0], {
      events: [
        {
          id: "0194f3f6-d64e-7e83-8764-4fd4d40f5b08",
          type: "PointValue",
          gatewayId: "gateway-123",
          payload: {
            pointId: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
            quality: "GOOD",
            valueRaw: 5355,
            previousValueRaw: 5354,
            value: 5355,
            previousValue: 5354,
            timestamp: 1771349900512,
            gatewayTimestamp: 1771349900516,
          },
        },
      ],
    });
  });

  test("forwards replayed flag when present", async () => {
    const ingested: Array<unknown> = [];
    const processor = createHttpEventsProcessor({
      config: {
        eventsUrl: "https://workspace.example.test",
        timeoutMs: 2_000,
        authToken: "secret-token",
      },
      logger: testLogger,
      ingestClient: {
        async ingest(input) {
          ingested.push(input);
        },
      },
    });

    const event = createPointEvent("e-replayed");
    (event.payload as Record<string, unknown>).replayed = true;

    await processor.process(event, createContext(processor.name));

    assert.equal(ingested.length, 1);
    const payload = (ingested[0] as { events: Array<{ payload: { replayed?: boolean } }> })
      .events[0]?.payload;
    assert.equal(payload?.replayed, true);
  });

  test("omits replayed flag when not present", async () => {
    const ingested: Array<unknown> = [];
    const processor = createHttpEventsProcessor({
      config: {
        eventsUrl: "https://workspace.example.test",
        timeoutMs: 2_000,
        authToken: "secret-token",
      },
      logger: testLogger,
      ingestClient: {
        async ingest(input) {
          ingested.push(input);
        },
      },
    });

    await processor.process(createPointEvent("e-not-replayed"), createContext(processor.name));

    assert.equal(ingested.length, 1);
    const payload = (ingested[0] as { events: Array<{ payload: { replayed?: boolean } }> })
      .events[0]?.payload;
    assert.equal(payload?.replayed, undefined);
  });

  test("matches points events only", () => {
    const processor = createHttpEventsProcessor({
      config: {
        eventsUrl: "https://workspace.example.test",
        timeoutMs: 2_000,
        authToken: "secret-token",
      },
      logger: testLogger,
      ingestClient: {
        async ingest() {},
      },
    });

    assert.equal(processor.matches(createPointEvent("e-points")), true);
    assert.equal(processor.matches(createHealthEvent("e-health")), false);
  });

  test("normalizes quality to UNKNOWN when unsupported", async () => {
    const ingested: Array<unknown> = [];
    const event = createPointEvent("e-quality");
    event.payload = {
      point: {
        pointValueId: "0194f3f6-d64f-7f34-a345-c931d2b56a12",
        id: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
        quality: "NOISE",
        valueRaw: 5355,
        previousValueRaw: 5354,
        value: 5355,
        previousValue: 5354,
        timestamp: 1771349900512,
        gatewayTimestamp: 1771349900516,
      },
    };

    const processor = createHttpEventsProcessor({
      config: {
        eventsUrl: "https://workspace.example.test",
        timeoutMs: 2_000,
        authToken: "secret-token",
      },
      logger: testLogger,
      ingestClient: {
        async ingest(input) {
          ingested.push(input);
        },
      },
    });

    await processor.process(event, createContext(processor.name));

    assert.equal(ingested.length, 1);
    assert.equal(
      (ingested[0] as { events: Array<{ payload: { quality: string } }> }).events[0]?.payload
        .quality,
      "UNKNOWN",
    );
  });

  test("skips invalid point payloads without publishing", async () => {
    let ingestCallCount = 0;
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const processor = createHttpEventsProcessor({
      config: {
        eventsUrl: "https://workspace.example.test",
        timeoutMs: 2_000,
        authToken: "secret-token",
      },
      logger: {
        debug() {},
        info() {},
        warn(_message, meta) {
          warnings.push(meta);
        },
        error() {},
      },
      ingestClient: {
        async ingest() {
          ingestCallCount += 1;
        },
      },
    });

    const invalidEvent = createPointEvent("e-invalid");
    (invalidEvent.payload as Record<string, unknown>).point = {
      pointValueId: "0194f3f6-d650-708f-ae53-f491d9d52524",
      id: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
      valueRaw: 1,
      gatewayTimestamp: 1771349900516,
    };

    await processor.process(invalidEvent, createContext(processor.name));

    assert.equal(ingestCallCount, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.reason, "timestamp_missing");
  });

  test("skips publish when gatewayId is missing", async () => {
    let ingestCallCount = 0;
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const processor = createHttpEventsProcessor({
      config: {
        eventsUrl: "https://workspace.example.test",
        timeoutMs: 2_000,
        authToken: "secret-token",
      },
      logger: {
        debug() {},
        info() {},
        warn(_message, meta) {
          warnings.push(meta);
        },
        error() {},
      },
      ingestClient: {
        async ingest() {
          ingestCallCount += 1;
        },
      },
    });

    const event = createPointEvent("e-no-gateway");
    event.metadata = null;

    await processor.process(event, createContext(processor.name));

    assert.equal(ingestCallCount, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.reason, "gateway_id_missing");
  });

  test("throws when ingest fails", async () => {
    const processor = createHttpEventsProcessor({
      config: {
        eventsUrl: "https://workspace.example.test",
        timeoutMs: 2_000,
        authToken: "secret-token",
      },
      logger: testLogger,
      ingestClient: {
        async ingest() {
          throw new Error("rpc failed");
        },
      },
    });

    await assert.rejects(
      () => processor.process(createPointEvent("e-fail"), createContext(processor.name)),
      /rpc failed/,
    );
  });

  test("throws when ingest times out", async () => {
    const processor = createHttpEventsProcessor({
      config: {
        eventsUrl: "https://workspace.example.test",
        timeoutMs: 10,
        authToken: "secret-token",
      },
      logger: testLogger,
      ingestClient: {
        async ingest() {
          await new Promise(() => {});
        },
      },
    });

    await assert.rejects(
      () => processor.process(createPointEvent("e-timeout"), createContext(processor.name)),
      /workspace rpc ingest timed out/,
    );
  });
});
