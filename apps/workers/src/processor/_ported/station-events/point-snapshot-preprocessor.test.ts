import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ParsedEvent } from "../pipeline/types.js";
import { createPointSnapshotPreprocessor } from "./point-snapshot-preprocessor.js";
import { TagSnapshotCache } from "./tag-snapshot-cache.js";

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
          id: "point-1",
          value: 4,
          previousValue: 3,
          quality: "GOOD",
          timestamp: now,
          gatewayTimestamp: now,
        },
      ],
    },
    raw: Buffer.from("{}", "utf8"),
  };
}

describe("point snapshot preprocessor", () => {
  test("stores latest snapshot by tag key", async () => {
    const tagSnapshotCache = new TagSnapshotCache();
    const preprocessor = createPointSnapshotPreprocessor({ tagSnapshotCache });

    const inputEvent = createPointsEvent();
    const outputEvents = await preprocessor.process(inputEvent);

    assert.equal(outputEvents.length, 1);
    assert.equal(outputEvents[0].id, inputEvent.id);
    assert.equal(tagSnapshotCache.getSnapshot("point-1")?.value, 4);
    assert.equal(tagSnapshotCache.getSnapshot("point-1")?.previousValue, 3);

    // Verify event-level snapshot was captured
    assert.equal(outputEvents[0].tagSnapshots?.["point-1"]?.value, 4);
    assert.equal(outputEvents[0].tagSnapshots?.["point-1"]?.previousValue, 3);
  });

  test("duplicate point event does not reset previousValue", async () => {
    const tagSnapshotCache = new TagSnapshotCache();
    const preprocessor = createPointSnapshotPreprocessor({ tagSnapshotCache });

    const event = createPointsEvent();
    await preprocessor.process(event);

    assert.equal(tagSnapshotCache.getSnapshot("point-1")?.value, 4);
    assert.equal(tagSnapshotCache.getSnapshot("point-1")?.previousValue, 3);

    await preprocessor.process(event);

    assert.equal(tagSnapshotCache.getSnapshot("point-1")?.value, 4);
    assert.equal(tagSnapshotCache.getSnapshot("point-1")?.previousValue, 4);
  });
});
