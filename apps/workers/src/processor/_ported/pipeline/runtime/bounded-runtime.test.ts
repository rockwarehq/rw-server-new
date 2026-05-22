import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createMetrics } from "../metrics.js";
import type { ParsedEvent, Processor } from "../types.js";
import { createBoundedRuntime } from "./bounded-runtime.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createEvent(id: string): ParsedEvent {
  const now = Date.now();
  return {
    id,
    topic: "test/topic",
    metadata: null,
    receivedAt: now,
    parsedAt: now,
    payload: { id },
    raw: Buffer.from(JSON.stringify({ id })),
  };
}

const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe("createBoundedRuntime", () => {
  test("drops oldest queued events when full", async () => {
    const metrics = createMetrics();
    const startedIds: string[] = [];

    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let firstCall = true;
    const processor: Processor = {
      name: "drop-oldest-test",
      matches: () => true,
      process: async (event) => {
        startedIds.push(event.id);
        if (firstCall) {
          firstCall = false;
          await firstStarted;
        }
      },
    };

    const runtime = createBoundedRuntime({
      processor,
      config: {
        concurrency: 1,
        queueCapacity: 2,
        overflow: "drop_oldest",
        processTimeoutMs: 2_000,
      },
      metrics,
      logger: testLogger,
    });

    await runtime.submit(createEvent("e0"));
    await runtime.submit(createEvent("e1"));
    await runtime.submit(createEvent("e2"));
    await runtime.submit(createEvent("e3"));
    await runtime.submit(createEvent("e4"));

    releaseFirst?.();
    await runtime.shutdown({ drainTimeoutMs: 2_000 });

    assert.deepEqual(startedIds, ["e0", "e3", "e4"]);

    const snapshot = metrics.getSnapshotByProcessor()[processor.name];
    assert.equal(snapshot?.droppedOldest, 2);
    assert.equal(snapshot?.processedOk, 3);
    assert.equal(snapshot?.queueDepth, 0);
  });

  test("never exceeds configured concurrency", async () => {
    const metrics = createMetrics();
    let inFlight = 0;
    let maxInFlight = 0;

    const processor: Processor = {
      name: "concurrency-test",
      matches: () => true,
      process: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(40);
        inFlight -= 1;
      },
    };

    const runtime = createBoundedRuntime({
      processor,
      config: {
        concurrency: 2,
        queueCapacity: 20,
        overflow: "drop_oldest",
        processTimeoutMs: 2_000,
      },
      metrics,
      logger: testLogger,
    });

    await Promise.all(
      Array.from({ length: 10 }, (_, index) => runtime.submit(createEvent(`c${index}`))),
    );

    await runtime.shutdown({ drainTimeoutMs: 2_000 });

    assert.ok(maxInFlight <= 2);
    assert.equal(maxInFlight, 2);

    const snapshot = metrics.getSnapshotByProcessor()[processor.name];
    assert.equal(snapshot?.processedOk, 10);
    assert.equal(snapshot?.processedFailed, 0);
  });

  test("shutdown drains queue before completing", async () => {
    const metrics = createMetrics();
    const processedIds: string[] = [];

    const processor: Processor = {
      name: "shutdown-drain-test",
      matches: () => true,
      process: async (event) => {
        await sleep(50);
        processedIds.push(event.id);
      },
    };

    const runtime = createBoundedRuntime({
      processor,
      config: {
        concurrency: 1,
        queueCapacity: 10,
        overflow: "drop_oldest",
        processTimeoutMs: 2_000,
      },
      metrics,
      logger: testLogger,
    });

    await runtime.submit(createEvent("s0"));
    await runtime.submit(createEvent("s1"));
    await runtime.submit(createEvent("s2"));

    const startedAt = Date.now();
    await runtime.shutdown({ drainTimeoutMs: 2_000 });
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(processedIds, ["s0", "s1", "s2"]);
    assert.ok(elapsedMs >= 120);

    const snapshot = metrics.getSnapshotByProcessor()[processor.name];
    assert.equal(snapshot?.queueDepth, 0);
    assert.equal(snapshot?.inFlight, 0);
  });
});
