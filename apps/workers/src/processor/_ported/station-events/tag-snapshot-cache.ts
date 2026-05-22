import type { PointReading } from "./point-reading.js";
import type { TagValueSnapshot } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function snapshotWithFallback(
  input: {
    key: string;
    pointId: string;
    value: unknown;
    previousValue?: unknown;
    quality?: "GOOD" | "BAD" | "UNKNOWN";
    timestamp?: string;
    gatewayTimestamp?: string;
    processorTimestamp?: string;
    source: "stream" | "rpc";
  },
  existing: TagValueSnapshot | undefined,
): TagValueSnapshot {
  const previousValue =
    existing !== undefined && existing.value === input.value
      ? existing.value
      : input.previousValue !== undefined
        ? input.previousValue
        : (existing?.value ?? null);

  return {
    key: input.key,
    pointId: input.pointId,
    value: input.value,
    previousValue,
    quality: input.quality,
    timestamp: input.timestamp,
    gatewayTimestamp: input.gatewayTimestamp,
    processorTimestamp: input.processorTimestamp,
    observedAt: nowIso(),
    source: input.source,
  };
}

export class TagSnapshotCache {
  private readonly snapshots: Map<string, TagValueSnapshot> = new Map();
  private readonly maxEntries: number;

  constructor(args?: { maxEntries?: number }) {
    this.maxEntries = args?.maxEntries ?? 50_000;
  }

  private trimIfNeeded(nextKey: string) {
    if (this.snapshots.has(nextKey)) {
      return;
    }

    while (this.snapshots.size >= this.maxEntries) {
      const oldestKey = this.snapshots.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.snapshots.delete(oldestKey);
    }
  }

  setSnapshot(input: {
    key: string;
    pointId: string;
    value: unknown;
    previousValue?: unknown;
    quality?: "GOOD" | "BAD" | "UNKNOWN";
    timestamp?: string;
    gatewayTimestamp?: string;
    processorTimestamp?: string;
    source: "stream" | "rpc";
  }) {
    this.trimIfNeeded(input.key);
    const existing = this.snapshots.get(input.key);
    const nextSnapshot = snapshotWithFallback(input, existing);
    this.snapshots.set(input.key, nextSnapshot);
  }

  upsertPointReading(reading: PointReading) {
    this.setSnapshot({
      key: reading.pointId,
      pointId: reading.pointId,
      value: reading.value,
      previousValue: reading.previousValue,
      quality: reading.quality,
      timestamp: reading.timestamp,
      gatewayTimestamp: reading.gatewayTimestamp,
      source: "stream",
    });
  }

  getSnapshot(key: string): TagValueSnapshot | undefined {
    return this.snapshots.get(key);
  }

  getMissingKeys(keys: Iterable<string>): string[] {
    const missing: string[] = [];
    for (const key of keys) {
      if (!this.snapshots.has(key)) {
        missing.push(key);
      }
    }
    return missing;
  }

  size(): number {
    return this.snapshots.size;
  }
}
