import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ParsedEvent } from "../types.js";
import { createPointsSplitEnricher } from "./points-split-enricher.js";

function createPointsEvent(): ParsedEvent {
  const now = Date.now();
  return {
    id: "event-1",
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
      points: [
        {
          id: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
          name: "01CNT04",
          value: 4960,
          previousValue: 4959,
          quality: "GOOD",
          timestamp: 1770651932996,
          gatewayTimestamp: 1770651933000,
        },
        {
          id: "11111111-1111-1111-1111-111111111111",
          name: "02CNT04",
          value: 100,
          previousValue: 99,
          quality: "GOOD",
          timestamp: 1770651932996,
          gatewayTimestamp: 1770651933000,
        },
      ],
      gatewayRxTimestamp: 1770651933000,
      deviceTxTimestamp: 1770651933000,
      gatewayTxTimestamp: 1770651933000,
    },
    raw: Buffer.from("{}", "utf8"),
  };
}

function createHealthEvent(): ParsedEvent {
  const now = Date.now();
  return {
    id: "health-1",
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
    payload: {
      status: "up",
      timestamp: 1770651929933,
      gateway: "c69555a1-aaf8-4067-833e-40377b555180",
      version: "v1.0",
      metrics: {
        uptimeSec: 351816.654312298,
        memMb: 86,
        cpuUserMs: 1017.048922,
      },
    },
    raw: Buffer.from("{}", "utf8"),
  };
}

const testLogger = {
  warn() {},
};

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("createPointsSplitEnricher", () => {
  test("splits points payload and scales value fields", async () => {
    const queries: string[] = [];
    const enricher = createPointsSplitEnricher({
      queryClient: {
        async query(_text, values) {
          queries.push(String(values[0]));
          if (values[0] === "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0") {
            return {
              rows: [
                {
                  scaleFactor: 0.1,
                  offset: 1,
                },
              ],
            };
          }

          return {
            rows: [
              {
                scaleFactor: 2,
                offset: 5,
              },
            ],
          };
        },
      },
      logger: testLogger,
    });

    const result = await enricher.process(createPointsEvent());

    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((event) => event.id),
      ["event-1:point:0", "event-1:point:1"],
    );
    assert.deepEqual(queries, [
      "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
      "11111111-1111-1111-1111-111111111111",
    ]);

    const firstPoint = result[0]?.payload.point as Record<string, unknown>;
    assert.equal(typeof firstPoint.pointValueId, "string");
    assert.match(String(firstPoint.pointValueId), UUIDV7_PATTERN);
    assert.deepEqual(firstPoint, {
      id: "9da3d1c3-7c6d-4d2c-82a9-4c76196222d0",
      name: "01CNT04",
      value: 497,
      valueRaw: 4960,
      previousValue: 496.90000000000003,
      previousValueRaw: 4959,
      quality: "GOOD",
      timestamp: 1770651932996,
      gatewayTimestamp: 1770651933000,
      pointValueId: firstPoint.pointValueId,
    });

    const secondPoint = result[1]?.payload.point as Record<string, unknown>;
    assert.equal(typeof secondPoint.pointValueId, "string");
    assert.match(String(secondPoint.pointValueId), UUIDV7_PATTERN);
    assert.deepEqual(secondPoint, {
      id: "11111111-1111-1111-1111-111111111111",
      name: "02CNT04",
      value: 205,
      valueRaw: 100,
      previousValue: 203,
      previousValueRaw: 99,
      quality: "GOOD",
      timestamp: 1770651932996,
      gatewayTimestamp: 1770651933000,
      pointValueId: secondPoint.pointValueId,
    });

    assert.equal(result[0]?.payload.points, undefined);
    assert.equal(result[0]?.payload.gatewayRxTimestamp, 1770651933000);
  });

  test("passes through non-points events unchanged", async () => {
    const event = createHealthEvent();
    const enricher = createPointsSplitEnricher({
      queryClient: {
        async query() {
          return { rows: [] };
        },
      },
      logger: testLogger,
    });

    const result = await enricher.process(event);

    assert.equal(result.length, 1);
    assert.deepEqual(result[0], event);
  });

  test("continues dispatch when lookup fails", async () => {
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const enricher = createPointsSplitEnricher({
      queryClient: {
        async query() {
          throw new Error("db down");
        },
      },
      mode: "best_effort",
      logger: {
        warn(_message, meta) {
          warnings.push(meta);
        },
      },
    });

    const result = await enricher.process(createPointsEvent());

    assert.equal(result.length, 2);
    const firstPoint = result[0]?.payload.point as Record<string, unknown>;
    assert.equal(firstPoint.value, 4960);
    assert.equal(firstPoint.valueRaw, 4960);
    assert.equal(warnings.length, 2);
  });

  test("fails in strict mode when calibration is missing", async () => {
    const enricher = createPointsSplitEnricher({
      queryClient: {
        async query() {
          return { rows: [] };
        },
      },
      logger: testLogger,
    });

    await assert.rejects(() => enricher.process(createPointsEvent()), /missing point calibration/);
  });
});
