import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import type { Metrics, ParsedEvent, ProcessorContext } from "../pipeline/types.js";
import { createFileEventsProcessor } from "./file-events-processor.js";

function createEvent(id: string, topic = "topic/test"): ParsedEvent {
  const now = Date.now();
  return {
    id,
    topic,
    metadata: null,
    receivedAt: now,
    parsedAt: now,
    payload: { id, value: 123 },
    raw: Buffer.from(JSON.stringify({ id, value: 123 }), "utf8"),
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

function createContext(logger: ProcessorContext["logger"]): ProcessorContext {
  return {
    processorName: "file-events",
    signal: new AbortController().signal,
    now: () => Date.now(),
    logger,
    metrics: testMetrics,
  };
}

describe("createFileEventsProcessor", () => {
  test("writes one NDJSON line per event", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "event-processor-"));
    const filePath = path.join(tmpDir, "events.ndjson");
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };

    try {
      const processor = createFileEventsProcessor({
        config: { filePath },
        logger,
      });

      const event = createEvent("e1", "/Rockware/v1/Gateway/gateway-1/Health");
      await processor.process(event, createContext(logger));

      const text = await readFile(filePath, "utf8");
      const lines = text.trim().split("\n");
      assert.equal(lines.length, 1);

      const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      assert.equal(first.eventId, "e1");
      assert.equal(first.topic, "/Rockware/v1/Gateway/gateway-1/Health");
      assert.equal(first.type, "mqtt_event");
      assert.equal(first.version, 1);
      assert.deepEqual(first.payload, { id: "e1", value: 123 });
      assert.equal(typeof first.timestamp, "string");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("appends multiple events", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "event-processor-"));
    const filePath = path.join(tmpDir, "events.ndjson");
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };

    try {
      const processor = createFileEventsProcessor({
        config: { filePath },
        logger,
      });

      await processor.process(createEvent("e1"), createContext(logger));
      await processor.process(createEvent("e2"), createContext(logger));

      const text = await readFile(filePath, "utf8");
      const lines = text.trim().split("\n");
      assert.equal(lines.length, 2);

      const ids = lines.map((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return parsed.eventId;
      });
      assert.deepEqual(ids, ["e1", "e2"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("logs and throws on append failure", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "event-processor-"));
    const filePath = path.join(tmpDir, "missing", "events.ndjson");
    const warnLogs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      debug() {},
      info() {},
      warn(message: string, meta?: Record<string, unknown>) {
        warnLogs.push({ message, meta });
      },
      error() {},
    };

    try {
      const processor = createFileEventsProcessor({
        config: { filePath },
        logger,
      });

      await assert.rejects(() => processor.process(createEvent("e-fail"), createContext(logger)));
      assert.equal(warnLogs.length, 1);
      assert.equal(warnLogs[0]?.message, "failed to append event to file");
      assert.equal(warnLogs[0]?.meta?.processor, "file-events");
      assert.equal(warnLogs[0]?.meta?.filePath, filePath);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
