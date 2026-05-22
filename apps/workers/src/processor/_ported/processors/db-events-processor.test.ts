import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Metrics, ParsedEvent, ProcessorContext } from "../pipeline/types.js";
import { createDbEventsProcessor } from "./db-events-processor.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createPointEvent(args: {
  eventId: string;
  pointValueId: string;
  pointId: string;
  quality?: unknown;
  valueRaw?: unknown;
  previousValueRaw?: unknown;
  value?: unknown;
  previousValue?: unknown;
  timestamp?: unknown;
  gatewayTimestamp?: unknown;
}): ParsedEvent {
  const now = Date.now();
  return {
    id: args.eventId,
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
        pointValueId: args.pointValueId,
        id: args.pointId,
        quality: args.quality ?? "GOOD",
        valueRaw: args.valueRaw ?? 4960,
        previousValueRaw: args.previousValueRaw ?? 4959,
        value: args.value ?? 497,
        previousValue: args.previousValue ?? 496.9,
        timestamp: args.timestamp ?? 1770651932996,
        gatewayTimestamp: args.gatewayTimestamp ?? 1770651933000,
      },
    },
    raw: Buffer.from("{}", "utf8"),
  };
}

function createHealthEvent(id: string): ParsedEvent {
  const now = Date.now();
  return {
    id,
    topic: "/Rockware/v1/Gateway/gw-1/Health",
    metadata: {
      family: "rockware",
      version: "1",
      gatewayId: "gw-1",
      resource: "Health",
      scope: "gateway",
    },
    receivedAt: now,
    parsedAt: now,
    payload: { status: "up" },
    raw: Buffer.from("{}", "utf8"),
  };
}

const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const testMetrics: Metrics = {
  incParsedOk() {},
  incParseError() {},
  incSubmitted(_processorName) {},
  incRejected(_processorName) {},
  incProcessedOk(_processorName) {},
  incProcessedFailed(_processorName) {},
  incDroppedOldest(_processorName) {},
  setQueueDepth(_processorName, _value) {},
  setInFlight(_processorName, _value) {},
  observeProcessLatencyMs(_processorName, _value) {},
  observeEventAgeAtStartMs(_processorName, _value) {},
  setServiceUp(_value) {},
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

describe("createDbEventsProcessor", () => {
  test("flushes on batch size and resolves after commit", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    let releaseQuery: (() => void) | undefined;
    let queryStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });

    const processor = createDbEventsProcessor({
      config: {
        table: "public.PointValue",
        insertTimeoutMs: 2_000,
        batchWindowMs: 500,
        batchMaxRows: 2,
      },
      queryClient: {
        async query(text, values) {
          queries.push({ text, values });
          queryStarted?.();
          await new Promise<void>((resolve) => {
            releaseQuery = resolve;
          });
        },
      },
      logger: testLogger,
    });

    const context = createContext(processor.name);
    const first = processor.process(
      createPointEvent({
        eventId: "e1",
        pointValueId: "0194f3f6-d64e-7e83-8764-4fd4d40f5b08",
        pointId: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
      }),
      context,
    );
    const second = processor.process(
      createPointEvent({
        eventId: "e2",
        pointValueId: "0194f3f6-d64f-7f34-a345-c931d2b56a12",
        pointId: "11111111-1111-4111-8111-111111111111",
      }),
      context,
    );

    await started;

    let resolvedEarly = false;
    const allDone = Promise.all([first, second]).then(() => {
      resolvedEarly = true;
    });
    await sleep(20);
    assert.equal(resolvedEarly, false);

    releaseQuery?.();
    await allDone;

    assert.equal(queries.length, 1);
    assert.match(queries[0]?.text ?? "", /INSERT INTO "public"\."PointValue"/);
    assert.match(queries[0]?.text ?? "", /ON CONFLICT \(id\) DO NOTHING/);
    assert.equal(queries[0]?.values.length, 18);
  });

  test("flushes on time window when batch is not full", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const processor = createDbEventsProcessor({
      config: {
        table: "PointValue",
        insertTimeoutMs: 2_000,
        batchWindowMs: 25,
        batchMaxRows: 10,
      },
      queryClient: {
        async query(text, values) {
          queries.push({ text, values });
        },
      },
      logger: testLogger,
    });

    const startedAt = Date.now();
    await processor.process(
      createPointEvent({
        eventId: "e-window",
        pointValueId: "0194f3f6-d650-708f-ae53-f491d9d52524",
        pointId: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
      }),
      createContext(processor.name),
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(queries.length, 1);
    assert.ok(elapsedMs >= 20);
  });

  test("rejects event promises when batch insert fails", async () => {
    const processor = createDbEventsProcessor({
      config: {
        table: "PointValue",
        insertTimeoutMs: 2_000,
        batchWindowMs: 0,
        batchMaxRows: 10,
      },
      queryClient: {
        async query() {
          throw new Error("insert failed");
        },
      },
      logger: testLogger,
    });

    await assert.rejects(
      () =>
        processor.process(
          createPointEvent({
            eventId: "e-fail",
            pointValueId: "0194f3f6-d651-70d4-9b18-c7ef65a7de67",
            pointId: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
          }),
          createContext(processor.name),
        ),
      /insert failed/,
    );
  });

  test("flushPending forces commit before window elapses", async () => {
    let queryCount = 0;
    const processor = createDbEventsProcessor({
      config: {
        table: "PointValue",
        insertTimeoutMs: 2_000,
        batchWindowMs: 10_000,
        batchMaxRows: 10,
      },
      queryClient: {
        async query() {
          queryCount += 1;
        },
      },
      logger: testLogger,
    });

    const eventPromise = processor.process(
      createPointEvent({
        eventId: "e-shutdown",
        pointValueId: "0194f3f6-d652-72db-9cc2-5f648ea85b15",
        pointId: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
      }),
      createContext(processor.name),
    );
    await sleep(10);
    await processor.flushPending();
    await eventPromise;

    assert.equal(queryCount, 1);
  });

  test("normalizes unknown quality to UNKNOWN", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const processor = createDbEventsProcessor({
      config: {
        table: "PointValue",
        insertTimeoutMs: 2_000,
        batchWindowMs: 0,
        batchMaxRows: 10,
      },
      queryClient: {
        async query(text, values) {
          queries.push({ text, values });
        },
      },
      logger: testLogger,
    });

    await processor.process(
      createPointEvent({
        eventId: "e-quality",
        pointValueId: "0194f3f6-d653-77ac-a2a3-268ecf33baf1",
        pointId: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
        quality: "NOISE",
      }),
      createContext(processor.name),
    );

    assert.equal(queries.length, 1);
    assert.equal(queries[0]?.values[2], "UNKNOWN");
  });

  test("skips invalid point rows and resolves without querying when none are valid", async () => {
    let queryCount = 0;
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const processor = createDbEventsProcessor({
      config: {
        table: "PointValue",
        insertTimeoutMs: 2_000,
        batchWindowMs: 0,
        batchMaxRows: 10,
      },
      queryClient: {
        async query() {
          queryCount += 1;
        },
      },
      logger: {
        debug() {},
        info() {},
        warn(_message, meta) {
          warnings.push(meta);
        },
        error() {},
      },
    });

    await processor.process(
      createPointEvent({
        eventId: "e-invalid",
        pointValueId: "not-a-uuid",
        pointId: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
      }),
      createContext(processor.name),
    );

    assert.equal(queryCount, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.reason, "point_value_id_invalid");
  });

  test("matches points events only", () => {
    const processor = createDbEventsProcessor({
      config: {
        table: "PointValue",
        insertTimeoutMs: 2_000,
        batchWindowMs: 0,
        batchMaxRows: 10,
      },
      queryClient: {
        async query() {},
      },
      logger: testLogger,
    });

    assert.equal(
      processor.matches(
        createPointEvent({
          eventId: "e-points",
          pointValueId: "0194f3f6-d654-7693-ad91-a95bbec4218f",
          pointId: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
        }),
      ),
      true,
    );
    assert.equal(processor.matches(createHealthEvent("e-health")), false);
  });

  test("validates table identifier", () => {
    assert.throws(
      () =>
        createDbEventsProcessor({
          config: {
            table: "public.Point-Value",
            insertTimeoutMs: 2_000,
            batchWindowMs: 100,
            batchMaxRows: 10,
          },
          queryClient: {
            async query() {},
          },
          logger: testLogger,
        }),
      /DB_EVENTS_TABLE/,
    );
  });
});
