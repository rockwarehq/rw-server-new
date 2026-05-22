import type { Logger } from "../pipeline/types.js";
import type { StationEventsRpcClient } from "./station-event-cache.js";
import type { TagSnapshotCache } from "./tag-snapshot-cache.js";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function hydrateMissingTagSnapshots(args: {
  rpcClient: StationEventsRpcClient;
  tagSnapshotCache: TagSnapshotCache;
  tagKeys: string[];
  timeoutMs: number;
  batchSize: number;
  logger: Logger;
  reason: string;
}): Promise<number> {
  const uniqueKeys = Array.from(new Set(args.tagKeys));
  const missingKeys = args.tagSnapshotCache.getMissingKeys(uniqueKeys);
  if (missingKeys.length === 0) {
    return 0;
  }

  let loaded = 0;
  for (let index = 0; index < missingKeys.length; index += args.batchSize) {
    const batch = missingKeys.slice(index, index + args.batchSize);
    const response = await withTimeout(
      args.rpcClient.getTagSnapshotsForProcessor({ tagKeys: batch }),
      args.timeoutMs,
      "station.getTagSnapshotsForProcessor",
    );

    for (const [key, snapshot] of Object.entries(response.snapshots)) {
      args.tagSnapshotCache.setSnapshot({
        key,
        pointId: snapshot.pointId,
        value: snapshot.value,
        previousValue: snapshot.previousValue,
        quality: snapshot.quality,
        timestamp: snapshot.timestamp,
        gatewayTimestamp: snapshot.gatewayTimestamp,
        processorTimestamp: snapshot.processorTimestamp,
        source: "rpc",
      });
      loaded += 1;
    }
  }

  args.logger.info("tag snapshot cache hydrated", {
    cache: "tag-snapshots",
    reason: args.reason,
    requested: missingKeys.length,
    loaded,
  });

  return loaded;
}
