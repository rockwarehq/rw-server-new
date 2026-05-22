import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Metrics, ParsedEvent, ProcessorContext } from "../pipeline/types.js";
import { createUniqueTopicsProcessor } from "./unique-topics-processor.js";

function createEvent(topic: string): ParsedEvent {
  const now = Date.now();
  return {
    id: `${topic}:${now}`,
    topic,
    metadata: null,
    receivedAt: now,
    parsedAt: now,
    payload: { topic },
    raw: Buffer.from(JSON.stringify({ topic }), "utf8"),
  };
}

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

describe("createUniqueTopicsProcessor", () => {
  test("logs sorted unique topic list when a new topic appears", async () => {
    const infoLogs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      debug() {},
      info(message: string, meta?: Record<string, unknown>) {
        infoLogs.push({ message, meta });
      },
      warn() {},
      error() {},
    };

    const processor = createUniqueTopicsProcessor({ logger });
    const context: ProcessorContext = {
      processorName: processor.name,
      signal: new AbortController().signal,
      now: () => Date.now(),
      logger,
      metrics: testMetrics,
    };

    await processor.process(createEvent("topic/b"), context);
    await processor.process(createEvent("topic/a"), context);
    await processor.process(createEvent("topic/b"), context);
    await processor.process(createEvent("topic/c"), context);

    assert.equal(infoLogs.length, 3);
    assert.equal(infoLogs[0]?.message, "unique topics snapshot");
    assert.deepEqual(infoLogs[0]?.meta?.uniqueTopics, ["topic/b"]);
    assert.deepEqual(infoLogs[1]?.meta?.uniqueTopics, ["topic/a", "topic/b"]);
    assert.deepEqual(infoLogs[2]?.meta?.uniqueTopics, ["topic/a", "topic/b", "topic/c"]);
  });
});
