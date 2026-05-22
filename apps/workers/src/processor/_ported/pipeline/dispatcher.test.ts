import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createDispatcher } from "./dispatcher.js";
import type {
  EventPreprocessor,
  Metrics,
  ParsedEvent,
  Processor,
  ProcessorRuntimeEntry,
  RuntimeSnapshot,
  RuntimeSubmitResult,
} from "./types.js";

function createEvent(id: string): ParsedEvent {
  const now = Date.now();
  return {
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
    payload: { points: [] },
    raw: Buffer.from("{}", "utf8"),
  };
}

function createMetricsRecorder() {
  const submitted: string[] = [];
  const rejected: string[] = [];

  const metrics: Metrics = {
    incParsedOk() {},
    incParseError() {},
    incSubmitted(processorName) {
      submitted.push(processorName);
    },
    incRejected(processorName) {
      rejected.push(processorName);
    },
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

  return { metrics, submitted, rejected };
}

function createRuntimeEntry(args: {
  processor: Processor;
  submit: (event: ParsedEvent) => Promise<RuntimeSubmitResult>;
}): ProcessorRuntimeEntry {
  const snapshot: RuntimeSnapshot = {
    processorName: args.processor.name,
    queueDepth: 0,
    inFlight: 0,
    concurrency: 1,
    queueCapacity: 1,
  };

  return {
    processor: args.processor,
    runtime: {
      processor: args.processor,
      submit(event) {
        return args.submit(event);
      },
      snapshot() {
        return snapshot;
      },
      async shutdown() {},
    },
  };
}

const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe("createDispatcher", () => {
  test("runs preprocessors before processor matching", async () => {
    const order: string[] = [];
    const preprocessor: EventPreprocessor = {
      name: "pre",
      async process(event) {
        order.push("pre");
        return [
          {
            ...event,
            payload: {
              ...event.payload,
              enriched: true,
            },
          },
        ];
      },
    };

    const processor: Processor = {
      name: "p1",
      matches(event) {
        order.push("match");
        return event.payload.enriched === true;
      },
      async process() {},
    };

    const seenIds: string[] = [];
    const entry = createRuntimeEntry({
      processor,
      async submit(event) {
        order.push("submit");
        seenIds.push(event.id);
        return { accepted: true };
      },
    });

    const { metrics, submitted } = createMetricsRecorder();
    const dispatcher = createDispatcher({
      entries: [entry],
      logger: testLogger,
      metrics,
      preprocessors: [preprocessor],
    });

    await dispatcher.dispatch(createEvent("e-1"));

    assert.deepEqual(order, ["pre", "match", "submit"]);
    assert.deepEqual(seenIds, ["e-1"]);
    assert.deepEqual(submitted, ["p1"]);
  });

  test("dispatches all events emitted by preprocessors", async () => {
    const preprocessor: EventPreprocessor = {
      name: "split",
      async process(event) {
        return [
          { ...event, id: `${event.id}:0`, payload: { part: 0 } },
          { ...event, id: `${event.id}:1`, payload: { part: 1 } },
        ];
      },
    };

    const submittedIds: string[] = [];
    const processor: Processor = {
      name: "p2",
      matches: () => true,
      async process() {},
    };

    const entry = createRuntimeEntry({
      processor,
      async submit(event) {
        submittedIds.push(event.id);
        return { accepted: true };
      },
    });

    const { metrics, submitted } = createMetricsRecorder();
    const dispatcher = createDispatcher({
      entries: [entry],
      logger: testLogger,
      metrics,
      preprocessors: [preprocessor],
    });

    await dispatcher.dispatch(createEvent("e-2"));

    assert.deepEqual(submittedIds, ["e-2:0", "e-2:1"]);
    assert.deepEqual(submitted, ["p2", "p2"]);
  });

  test("falls back to original event in best_effort mode", async () => {
    const preprocessor: EventPreprocessor = {
      name: "broken",
      failureMode: "best_effort",
      async process() {
        throw new Error("boom");
      },
    };

    const submittedIds: string[] = [];
    const processor: Processor = {
      name: "p3",
      matches: () => true,
      async process() {},
    };

    const entry = createRuntimeEntry({
      processor,
      async submit(event) {
        submittedIds.push(event.id);
        return { accepted: true };
      },
    });

    const { metrics } = createMetricsRecorder();
    const dispatcher = createDispatcher({
      entries: [entry],
      logger: testLogger,
      metrics,
      preprocessors: [preprocessor],
    });

    await dispatcher.dispatch(createEvent("e-3"));

    assert.deepEqual(submittedIds, ["e-3"]);
  });

  test("throws in strict mode when preprocessor fails", async () => {
    const preprocessor: EventPreprocessor = {
      name: "broken-strict",
      async process() {
        throw new Error("boom");
      },
    };

    const processor: Processor = {
      name: "p4",
      matches: () => true,
      async process() {},
    };

    const entry = createRuntimeEntry({
      processor,
      async submit() {
        return { accepted: true };
      },
    });

    const { metrics } = createMetricsRecorder();
    const dispatcher = createDispatcher({
      entries: [entry],
      logger: testLogger,
      metrics,
      preprocessors: [preprocessor],
    });

    await assert.rejects(() => dispatcher.dispatch(createEvent("e-4")), /boom/);
  });
});
