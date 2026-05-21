// ── Metrics rollup tick ──────────────────────────────────────────
// All metric computation is deferred from the per-cycle hot path into
// a single combined tick running every 5s in the worker process.
//
// Per-cycle hot path (server process):
//   Just marks dirty buckets via Redis. Zero cascade work.
//
// Combined tick phases (worker process, every 5s):
//   1. batchCountRollup    — recompute count KPIs from Cycle table
//   2. batchDurationRollup — compute duration KPIs from StationStateLog
//   3. cascadeStationShiftDay — re-sum STATION HOUR → SHIFT/DAY
//   4. cascadeParentRollup — sum STATION → WORKCENTER/SITE
//   5. cascadeJobRollup    — recompute JOB-entity buckets
//
// Usage:
//   // Server process (called from cycle.ts):
//   batchedMetricsUpdate({ stationId, siteId, timestamp, ... });
//
//   // Worker process (called from worker.ts):
//   startDirtyBucketConsumer();

import { Redis } from "ioredis";
import {
  batchDurationRollup,
  cascadeStationShiftDay,
  cascadeJobRollup,
  cascadeParentRollup,
  syncExpectedCyclesFromJobs,
} from "./cascade.js";
import { classifyDbTimeout } from "@rw/db";

/** Interval for the combined metrics tick (ms). */
const COMBINED_TICK_MS = 5_000;

/** Parallel station queries per tick phase.
 *  Single-process shares one event loop + DB pool with HTTP + cycle workers,
 *  so lower concurrency reduces CPU spikes and connection contention. */
const TICK_CONCURRENCY = process.env.SINGLE_PROCESS ? 3 : 10;

/** Redis key for the dirty bucket list. */
const DIRTY_BUCKETS_KEY = "metrics:dirty-buckets";

// ── Types ────────────────────────────────────────────────────────

export interface MetricsUpdateRequest {
  stationId: string;
  siteId: string;
  /** Timestamp of the cycle completion (cycle.end or fallback). */
  timestamp: Date;
  /** Number of inventory items produced by this cycle. */
  itemsCount: number;
  /** Standard cycle time in seconds from the job blob (for idealCycleSeconds). Null if unknown. */
  standardCycleSeconds: number | null;
  /** Number of items produced per cycle for this job (for expectedItems). */
  itemsPerCycle: number;
  /** Actual cycle duration in seconds (start to end, clipped to bucket). */
  cycleDurationSeconds: number;
  /** If a state entry was closed during the cycle, recompute its full range. */
  closedEntry?: {
    startTime: Date;
    endTime: Date;
  };
}

// ── Redis client (shared) ────────────────────────────────────────

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    redisClient = new Redis(url);
  }
  return redisClient;
}

// ── Public API (server process) ─────────────────────────────────

/**
 * Mark a station+hour bucket as dirty. Called from the per-cycle hot path.
 * All actual metric computation is done by the combined tick in the worker.
 */
export function batchedMetricsUpdate(request: MetricsUpdateRequest): void {
  const dirty = {
    stationId: request.stationId,
    siteId: request.siteId,
    bucketStartTime: request.timestamp.toISOString(),
  };
  getRedis()
    .lpush(DIRTY_BUCKETS_KEY, JSON.stringify(dirty))
    .catch((err: unknown) => {
      console.error("[metrics:batcher] Failed to push dirty bucket to Redis:", err);
    });

  if (request.closedEntry) {
    const closedDirty = {
      stationId: request.stationId,
      siteId: request.siteId,
      bucketStartTime: request.closedEntry.startTime.toISOString(),
    };
    getRedis()
      .lpush(DIRTY_BUCKETS_KEY, JSON.stringify(closedDirty))
      .catch((err: unknown) => {
        console.error("[metrics:batcher] Failed to push closed dirty bucket to Redis:", err);
      });
  }
}

// ── Combined tick (worker process) ──────────────────────────────

/** Interval (ms) at which the observer checks whether the current tick has
 *  been running too long. Logs only — no force-reset. */
const TICK_OBSERVER_INTERVAL_MS = 10_000;

/** Threshold (ms) above which the observer logs that a tick is taking too
 *  long. Healthy ticks are ~100ms; 30s is well above any normal value but
 *  far below the client- and server-side timeouts that would close the
 *  connection. The log fires every observer interval until the tick finishes. */
const TICK_LONG_THRESHOLD_MS = 30_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let observerTimer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;
/** Wall-clock ms when the current tick started; null when no tick is in flight. */
let tickStartedAt: number | null = null;
let consumerRedis: Redis | null = null;

/**
 * Start the combined metrics tick. Call this from the worker process only.
 */
export function startDirtyBucketConsumer(): void {
  if (tickTimer) return;

  const url = process.env.REDIS_URL || "redis://localhost:6379";
  consumerRedis = new Redis(url);

  tickTimer = setInterval(() => {
    combinedTick().catch((err) => {
      const kind = classifyDbTimeout(err);
      if (kind) console.error(`[metrics:tick] DB timeout fired (${kind}); tick will retry on next interval`);
      console.error("[metrics:tick] Failed:", err);
    });
  }, COMBINED_TICK_MS);

  // Observer: log (only) when the current tick has been running unusually
  // long. Does NOT reset tickRunning — the DB-side and pg-client-side
  // timeouts (statement_timeout / query_timeout / keepAlive) own the closing.
  // This just makes the wedge visible in logs while it's happening.
  observerTimer = setInterval(() => {
    if (tickStartedAt !== null) {
      const ageMs = Date.now() - tickStartedAt;
      if (ageMs > TICK_LONG_THRESHOLD_MS) {
        console.warn(
          `[metrics:tick] tick still running after ${ageMs}ms ` + `(started ${new Date(tickStartedAt).toISOString()})`,
        );
      }
    }
  }, TICK_OBSERVER_INTERVAL_MS);

  console.log(`[metrics:batcher] Combined tick started: every ${COMBINED_TICK_MS / 1000}s`);
}

/**
 * Stop the combined metrics tick. Call during worker shutdown.
 */
export async function stopDirtyBucketConsumer(): Promise<void> {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (observerTimer) {
    clearInterval(observerTimer);
    observerTimer = null;
  }
  if (consumerRedis) {
    consumerRedis.disconnect();
    consumerRedis = null;
  }
}

// ── Combined tick implementation ────────────────────────────────

// INVARIANT: this tick must run unconditionally on every interval.
// Duration-based KPIs (runSeconds, availability, OEE, etc.) advance with
// elapsed time alone — there is no such thing as a "clean" bucket that
// can be skipped because no events fired. Tick cost is O(active stations),
// not O(events). Do NOT add an event-driven short-circuit here (e.g. "skip
// if Redis dirty set is empty"); optimize by making each phase cheaper
// instead. See CLAUDE.md > Metrics pipeline invariants.
async function combinedTick(): Promise<void> {
  if (tickRunning) {
    const ageMs = tickStartedAt !== null ? Date.now() - tickStartedAt : 0;
    console.log(`[metrics:tick] skipped (previous still running, ${ageMs}ms)`);
    return;
  }
  tickRunning = true;
  tickStartedAt = Date.now();

  try {
    const tickStart = Date.now();
    const now = new Date();

    // Phase 1: STATION HOUR durations from StationStateLog.
    const allStations = await batchDurationRollup(now);

    const t1 = Date.now();

    if (allStations.length === 0) return;

    const CONCURRENCY = TICK_CONCURRENCY;
    const sites = [...new Set(allStations.map((s) => s.siteId))];

    // Phase 2: JOB HOUR buckets — accurate expectedCycles clipped to job window.
    // Reads StationStateLog/Cycle/StationJobLog directly, no bucket dependency,
    // so it runs before the STATION → SHIFT/DAY rollup.
    for (let i = 0; i < allStations.length; i += CONCURRENCY) {
      await Promise.all(
        allStations.slice(i, i + CONCURRENCY).map(({ stationId, siteId }) =>
          cascadeJobRollup(stationId, siteId, now).catch((err) => {
            const kind = classifyDbTimeout(err);
            if (kind)
              console.error(`[metrics:tick] DB timeout fired (${kind}) in cascadeJobRollup for station ${stationId}`);
            console.error(`[metrics:tick] Job rollup failed for station ${stationId}:`, err);
          }),
        ),
      );
    }

    const t2 = Date.now();

    // Phase 3: JOB HOUR → STATION HOUR — overwrites batchDurationRollup's
    // naive expectedCycles with the job-clipped sum.
    for (let i = 0; i < allStations.length; i += CONCURRENCY) {
      await Promise.all(
        allStations.slice(i, i + CONCURRENCY).map(({ stationId, siteId }) =>
          syncExpectedCyclesFromJobs(stationId, siteId, now).catch((err) => {
            const kind = classifyDbTimeout(err);
            if (kind)
              console.error(
                `[metrics:tick] DB timeout fired (${kind}) in syncExpectedCyclesFromJobs for station ${stationId}`,
              );
            console.error(`[metrics:tick] Sync expected failed for station ${stationId}:`, err);
          }),
        ),
      );
    }

    const t3 = Date.now();

    // Phase 4: STATION HOUR → STATION SHIFT/DAY — picks up corrected expected.
    for (let i = 0; i < allStations.length; i += CONCURRENCY) {
      await Promise.all(
        allStations.slice(i, i + CONCURRENCY).map(({ stationId, siteId }) =>
          cascadeStationShiftDay(stationId, siteId, now).catch((err) => {
            const kind = classifyDbTimeout(err);
            if (kind)
              console.error(
                `[metrics:tick] DB timeout fired (${kind}) in cascadeStationShiftDay for station ${stationId}`,
              );
            console.error(`[metrics:tick] Shift/day rollup failed for station ${stationId}:`, err);
          }),
        ),
      );
    }

    const t4 = Date.now();

    // Phase 5: STATION → WORKCENTER/SITE (all granularities).
    for (const siteId of sites) {
      try {
        await cascadeParentRollup(siteId, now);
      } catch (err) {
        const kind = classifyDbTimeout(err);
        if (kind) console.error(`[metrics:tick] DB timeout fired (${kind}) in cascadeParentRollup for site ${siteId}`);
        console.error(`[metrics:tick] Parent rollup failed for site ${siteId}:`, err);
      }
    }

    const elapsed = Date.now() - tickStart;
    if (elapsed > 3000 || allStations.length > 0) {
      console.log(
        `[metrics:tick] ${allStations.length} stations in ${elapsed}ms ` +
          `(dur=${t1 - tickStart}ms job=${t2 - t1}ms sync=${t3 - t2}ms shift/day=${t4 - t3}ms parent=${Date.now() - t4}ms)`,
      );
    }

    // Drain dirty bucket list (consumed but not needed — the tick handles everything)
    if (consumerRedis) {
      while (true) {
        const item = await consumerRedis.rpop(DIRTY_BUCKETS_KEY);
        if (!item) break;
      }
    }
  } catch (err) {
    const kind = classifyDbTimeout(err);
    if (kind) console.error(`[metrics:tick] DB timeout fired (${kind}) inside combinedTick`);
    console.error("[metrics:tick] Combined tick failed:", err);
  } finally {
    tickRunning = false;
    tickStartedAt = null;
  }
}
