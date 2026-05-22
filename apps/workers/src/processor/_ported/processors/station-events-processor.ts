import type { ParsedEvent, Processor } from "../pipeline/types.js";
import { extractPointReadings, readingKeys } from "../station-events/point-reading.js";
import type {
  StationEventCache,
  CompiledStationEvent,
  StationEventsRpcClient,
} from "../station-events/station-event-cache.js";
import type { TagSnapshotCache } from "../station-events/tag-snapshot-cache.js";
import type { TagValueSnapshot } from "../station-events/types.js";
import { evaluateTrigger } from "../station-events/trigger-evaluator.js";

interface StationEventsProcessorConfig {
  timeoutMs: number;
  tagFetchBatchSize: number;
}

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

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildTriggerPayload(args: {
  sourceEvent: ParsedEvent;
  compiledEvent: CompiledStationEvent;
  matchedConditionIds: string[];
  getSnapshot: (key: string) => TagValueSnapshot | undefined;
  tagKeys: Set<string>;
}): Record<string, unknown> {
  const tagValues: Record<string, unknown> = {};
  for (const key of args.tagKeys) {
    const snapshot = args.getSnapshot(key);
    if (!snapshot) {
      continue;
    }

    tagValues[key] = {
      key: snapshot.key,
      pointId: snapshot.pointId,
      value: snapshot.value,
      previousValue: snapshot.previousValue,
      quality: snapshot.quality,
      timestamp: snapshot.timestamp,
      gatewayTimestamp: snapshot.gatewayTimestamp,
      processorTimestamp: snapshot.processorTimestamp,
      observedAt: snapshot.observedAt,
      source: snapshot.source,
    };
  }

  const readings = extractPointReadings(args.sourceEvent).map((reading) => ({
    pointId: reading.pointId,
    deviceId: reading.deviceId,
    value: reading.value,
    previousValue: reading.previousValue ?? null,
    quality: reading.quality,
    timestamp: reading.timestamp,
    gatewayTimestamp: reading.gatewayTimestamp,
  }));

  return {
    source: {
      eventId: args.sourceEvent.id,
      topic: args.sourceEvent.topic,
      receivedAt: new Date(args.sourceEvent.receivedAt).toISOString(),
      parsedAt: new Date(args.sourceEvent.parsedAt).toISOString(),
      metadata: args.sourceEvent.metadata,
    },
    trigger: {
      stationId: args.compiledEvent.stationId,
      eventId: args.compiledEvent.id,
      matchedConditionIds: args.matchedConditionIds,
      matchedAt: new Date().toISOString(),
    },
    points: readings,
    tagValues,
    ...(args.sourceEvent.payload.replayed === true ? { replayed: true } : {}),
  };
}

async function hydrateMissingTagSnapshots(args: {
  missingTagKeys: string[];
  rpcClient: StationEventsRpcClient;
  tagSnapshotCache: TagSnapshotCache;
  timeoutMs: number;
  tagFetchBatchSize: number;
}): Promise<void> {
  if (args.missingTagKeys.length === 0) {
    return;
  }

  for (let index = 0; index < args.missingTagKeys.length; index += args.tagFetchBatchSize) {
    const batch = args.missingTagKeys.slice(index, index + args.tagFetchBatchSize);
    const response = await withTimeout(
      args.rpcClient.getTagSnapshotsForProcessor({
        tagKeys: batch,
      }),
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
    }
  }
}

export function createStationEventsProcessor(args: {
  config: StationEventsProcessorConfig;
  stationEventCache: StationEventCache;
  tagSnapshotCache: TagSnapshotCache;
  rpcClient: StationEventsRpcClient;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}): Processor {
  return {
    name: "station-events",
    matches(event) {
      return event.metadata?.resource === "Points";
    },
    async process(event): Promise<void> {
      const readings = extractPointReadings(event);
      if (readings.length === 0) {
        return;
      }

      const lookupKeys = new Set<string>();
      for (const reading of readings) {
        for (const key of readingKeys(reading)) {
          lookupKeys.add(key);
        }
      }

      const candidateEventIds = args.stationEventCache.getCandidateEventIds(lookupKeys);
      if (candidateEventIds.length === 0) {
        return;
      }

      const candidateEvents: CompiledStationEvent[] = [];
      const requiredTagKeys = new Set<string>();
      for (const eventId of candidateEventIds) {
        const compiledEvent = args.stationEventCache.getCompiledEvent(eventId);
        if (!compiledEvent) {
          continue;
        }

        candidateEvents.push(compiledEvent);
        for (const key of compiledEvent.conditionKeys) {
          requiredTagKeys.add(key);
        }
        for (const key of compiledEvent.actionTagKeys) {
          requiredTagKeys.add(key);
        }
      }

      // Snapshot-aware lookup: prefer event-attached snapshots (captured at
      // preprocessing time) over the live cache. This prevents race conditions
      // where newer events overwrite the cache before this event is processed.
      const eventSnapshots = event.tagSnapshots ?? {};
      const getSnapshot = (key: string): TagValueSnapshot | undefined =>
        eventSnapshots[key] ?? args.tagSnapshotCache.getSnapshot(key);

      // Only hydrate keys missing from both event snapshots and live cache
      const missingKeys = [...requiredTagKeys].filter(
        (key) => !eventSnapshots[key] && !args.tagSnapshotCache.getSnapshot(key),
      );

      try {
        await hydrateMissingTagSnapshots({
          missingTagKeys: missingKeys,
          rpcClient: args.rpcClient,
          tagSnapshotCache: args.tagSnapshotCache,
          timeoutMs: args.config.timeoutMs,
          tagFetchBatchSize: args.config.tagFetchBatchSize,
        });
      } catch (error) {
        args.logger.warn("failed to hydrate missing station tag snapshots", {
          processor: "station-events",
          eventId: event.id,
          topic: event.topic,
          error: normalizeError(error),
        });
        throw error;
      }

      for (const compiledEvent of candidateEvents) {
        const evaluation = evaluateTrigger({
          trigger: compiledEvent.trigger,
          getSnapshot,
        });

        if (!evaluation.matched) {
          continue;
        }

        const payloadTagKeys = new Set<string>();
        for (const key of compiledEvent.conditionKeys) {
          payloadTagKeys.add(key);
        }
        for (const key of compiledEvent.actionTagKeys) {
          payloadTagKeys.add(key);
        }

        const payload = buildTriggerPayload({
          sourceEvent: event,
          compiledEvent,
          matchedConditionIds: evaluation.matchedConditionIds,
          getSnapshot,
          tagKeys: payloadTagKeys,
        });

        try {
          await withTimeout(
            args.rpcClient.triggerEvent({
              stationId: compiledEvent.stationId,
              eventId: compiledEvent.id,
              payload,
            }),
            args.config.timeoutMs,
            "station.triggerEvent",
          );
        } catch (error) {
          args.logger.warn("failed to trigger station event", {
            processor: "station-events",
            sourceEventId: event.id,
            stationId: compiledEvent.stationId,
            stationEventId: compiledEvent.id,
            error: normalizeError(error),
          });
          throw error;
        }

        args.logger.info("station event triggered", {
          processor: "station-events",
          sourceEventId: event.id,
          stationId: compiledEvent.stationId,
          stationEventId: compiledEvent.id,
          matchedConditionIds: evaluation.matchedConditionIds,
        });
      }
    },
  };
}
