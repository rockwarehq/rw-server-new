import type { EventPreprocessor } from "../pipeline/types.js";
import { extractPointReadings } from "./point-reading.js";
import type { TagSnapshotCache } from "./tag-snapshot-cache.js";
import type { TagValueSnapshot } from "./types.js";

export function createPointSnapshotPreprocessor(args: {
  tagSnapshotCache: TagSnapshotCache;
}): EventPreprocessor {
  return {
    name: "point-snapshot-cache",
    async process(event) {
      const readings = extractPointReadings(event);
      const tagSnapshots: Record<string, TagValueSnapshot> = {};

      for (const reading of readings) {
        args.tagSnapshotCache.upsertPointReading(reading);
        const snapshot = args.tagSnapshotCache.getSnapshot(reading.pointId);
        if (snapshot) {
          tagSnapshots[reading.pointId] = snapshot;
        }
      }

      return [{ ...event, tagSnapshots }];
    },
  };
}
