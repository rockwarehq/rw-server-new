import { EventPublisher } from "@orpc/server";
import { Redis } from "ioredis";
import { METRIC_CATALOG_REGISTRY } from "../metric-catalog/index.js";
import type { BucketChange } from "../metrics/sync.js";

export type MetricChangeEvent = BucketChange;

export type MetricValuePrimitive = number | string | boolean | null;

export interface MetricValueEvent {
  siteId: string;
  entityType: "STATION" | "WORKCENTER" | "SITE" | "JOB";
  entityId: string;
  metricKey: string;
  args?: Record<string, unknown>;
  sourceType: "bucket" | "live";
  value: MetricValuePrimitive;
  observedAt: Date;
  entityName: string;
  path: string;
  granularity?: "MINUTE" | "HOUR" | "SHIFT" | "DAY";
  granularityName?: string;
  startTime?: Date;
  durationSeconds?: number;
  shiftInstanceId?: string | null;
  businessDate?: Date | null;
  businessShift?: string | null;
}

interface MetricEventMap {
  change: MetricChangeEvent;
  value: MetricValueEvent;
}

const metricsPublisher = new EventPublisher<MetricEventMap>({
  maxBufferedEvents: 500,
});

const BUCKET_VALUE_KEYS = METRIC_CATALOG_REGISTRY.filter(
  (definition) => !definition.granularities.some((granularity) => granularity === "LIVE"),
).map((definition) => definition.key);

// Default publish funcs write to the local in-process EventPublisher. In the
// monorepo split, workers (rollups + processor-consumer) publish and api
// subscribes; initMetricsBridge swaps these to/from Redis pub/sub.
//
// Bucket value events are NOT sent over the wire — they're fully derivable from
// the bucket `change` snapshot. Every "change" reaching the LOCAL bus is
// expanded into one value event per bucket metric key via emitLocalBucketValues,
// so the ~20x fan-out runs in-process on the subscriber instead of multiplying
// Redis pub/sub traffic. See buildBucketValueEvents below.
let publishChangeFn: (event: MetricChangeEvent) => void = (event) => {
  metricsPublisher.publish("change", event);
  emitLocalBucketValues(event);
};
let publishValueFn: (event: MetricValueEvent) => void = (event) => {
  metricsPublisher.publish("value", event);
};

export function publishMetricChange(change: MetricChangeEvent): void {
  publishChangeFn(change);
}

export function subscribeMetricChanges(options?: { signal?: AbortSignal }) {
  return metricsPublisher.subscribe("change", options);
}

export function publishMetricValueChange(change: MetricValueEvent): void {
  publishValueFn(change);
}

// Derive the per-metric bucket value events from a single bucket change. Pure —
// every field comes from the change/snapshot, so this can run anywhere the
// change is available (notably the api subscriber) without extra Redis traffic.
function buildBucketValueEvents(change: MetricChangeEvent): MetricValueEvent[] {
  const snapshot = change.snapshot as unknown as Record<string, MetricValuePrimitive>;
  const observedAt = new Date();

  return BUCKET_VALUE_KEYS.map((metricKey) => ({
    siteId: change.siteId,
    entityType: change.entityType,
    entityId: change.entityId,
    metricKey,
    args: { granularity: change.granularity },
    sourceType: "bucket",
    value: snapshot[metricKey] ?? null,
    observedAt,
    entityName: change.entityName,
    path: change.path,
    granularity: change.granularity,
    granularityName: change.granularityName,
    startTime: change.startTime,
    durationSeconds: change.durationSeconds,
    shiftInstanceId: change.shiftInstanceId,
    businessDate: change.businessDate,
    businessShift: change.businessShift,
  }));
}

// Expand a bucket change into value events on the LOCAL in-process bus only.
// Never routes through publishValueFn, so the expansion can't bounce back out
// over Redis.
function emitLocalBucketValues(change: MetricChangeEvent): void {
  for (const value of buildBucketValueEvents(change)) {
    metricsPublisher.publish("value", value);
  }
}

export function subscribeMetricValueChanges(options?: { signal?: AbortSignal }) {
  return metricsPublisher.subscribe("value", options);
}

// ── Cross-process bridge (Redis pub/sub) ────────────────────────────────
// Mirrors @rw/infra/events-bus.initEventsBridge. Required for the SSE
// pipeline in the monorepo split: rollups (in apps/workers) publishes
// metric changes that api (separate process) feeds into oRPC subscribers
// for frontend live updates like current-shift-recap.

const METRIC_EVENTS_CHANNEL = "metric-events";

type BridgedMetricEvent = { type: "change"; payload: MetricChangeEvent } | { type: "value"; payload: MetricValueEvent };

// JSON loses Date types. Revive the known Date fields on each event shape.
function reviveChangeDates(e: MetricChangeEvent): MetricChangeEvent {
  if (e.startTime) e.startTime = new Date(e.startTime as unknown as string);
  if (e.businessDate) e.businessDate = new Date(e.businessDate as unknown as string);
  return e;
}

function reviveValueDates(e: MetricValueEvent): MetricValueEvent {
  if (e.observedAt) e.observedAt = new Date(e.observedAt as unknown as string);
  if (e.startTime) e.startTime = new Date(e.startTime as unknown as string);
  if (e.businessDate) e.businessDate = new Date(e.businessDate as unknown as string);
  return e;
}

// Modes match @rw/infra/events-bus initEventsBridge — see that file for
// details on when to use publisher / subscriber / both. apps/api should use
// `both` once it's horizontally scaled (its own metric publishes need to
// reach SSE clients on other machines too).
export async function initMetricsBridge(mode: "publisher" | "subscriber" | "both"): Promise<() => Promise<void>> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log("[metrics-bus] REDIS_URL not set, skipping bridge");
    return async () => {};
  }

  const cleanups: Array<() => void> = [];

  if (mode === "publisher" || mode === "both") {
    const pub = new Redis(redisUrl);
    publishChangeFn = (event) => {
      pub.publish(METRIC_EVENTS_CHANNEL, JSON.stringify({ type: "change", payload: event })).catch((err: unknown) => {
        console.error("[metrics-bus] Failed to publish change to Redis:", err);
      });
    };
    publishValueFn = (event) => {
      pub.publish(METRIC_EVENTS_CHANNEL, JSON.stringify({ type: "value", payload: event })).catch((err: unknown) => {
        console.error("[metrics-bus] Failed to publish value to Redis:", err);
      });
    };
    console.log(`[metrics-bus] Publishing metric events via Redis (mode=${mode})`);
    cleanups.push(() => pub.disconnect());
  }

  if (mode === "subscriber" || mode === "both") {
    const sub = new Redis(redisUrl);
    sub.subscribe(METRIC_EVENTS_CHANNEL).catch((err: unknown) => {
      console.error("[metrics-bus] Failed to subscribe:", err);
    });
    sub.on("message", (_channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message) as BridgedMetricEvent;
        if (parsed.type === "change") {
          // Only `change` events cross the wire now; regenerate the per-metric
          // bucket value stream locally so SSE value subscribers are unaffected.
          const change = reviveChangeDates(parsed.payload);
          metricsPublisher.publish("change", change);
          emitLocalBucketValues(change);
        } else {
          metricsPublisher.publish("value", reviveValueDates(parsed.payload));
        }
      } catch (err) {
        console.error("[metrics-bus] Failed to parse event from Redis:", err);
      }
    });
    console.log(`[metrics-bus] Subscribing to metric events via Redis (mode=${mode})`);
    cleanups.push(() => sub.disconnect());
  }

  return async () => {
    for (const c of cleanups) c();
  };
}
