// ── Atomic bucket computation ────────────────────────────────────
// Computes all KPI values for a single base-granularity bucket
// (e.g. one HOUR for one STATION) by querying raw events.
//
// This is the single source of truth for "what are the KPIs for
// this time window on this station?" Everything else (SHIFT, DAY,
// WORKCENTER, SITE) is derived by summing these base buckets.
//
// When a jobFilter is provided, cycles are filtered to that job and
// state log durations are clipped to the job's active period within
// the bucket window. This produces per-job KPIs (JOB entity buckets).
//
// Pure, stateless, idempotent — no side effects, no writes.

import prisma from "@rw/db";

// ── Types ────────────────────────────────────────────────────────

/**
 * All KPI values for a single base-granularity bucket.
 *
 * These are absolute values computed from raw events — not deltas.
 * Replacing (not incrementing) bucket KPIs with these values is
 * always safe and idempotent.
 */
export interface BucketKPIs {
  // Counting
  totalCycles: number;
  badCycles: number;
  totalItems: number;
  badItems: number;
  expectedCycles: number;
  expectedItems: number;
  // Duration (integer seconds)
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
  // Time (integer seconds)
  idealCycleSeconds: number;
  totalCycleSeconds: number;
  // Elapsed (for in-progress OEE — equals full-window values for closed buckets)
  elapsedExpectedCycles: number;
  elapsedExpectedItems: number;
  elapsedPlannedProductionSeconds: number;
  // Display: current job's standard cycle (seconds). null if unknown.
  currentStandardCycle: number | null;
}

type AdditiveKpiKey = Exclude<keyof BucketKPIs, "currentStandardCycle">;

/** A zero-valued KPI set — useful as the identity element for summation. */
export const ZERO_KPIS: Readonly<BucketKPIs> = Object.freeze({
  totalCycles: 0,
  badCycles: 0,
  totalItems: 0,
  badItems: 0,
  expectedCycles: 0,
  expectedItems: 0,
  runSeconds: 0,
  downSeconds: 0,
  plannedDownSeconds: 0,
  unplannedDownSeconds: 0,
  idealCycleSeconds: 0,
  totalCycleSeconds: 0,
  elapsedExpectedCycles: 0,
  elapsedExpectedItems: 0,
  elapsedPlannedProductionSeconds: 0,
  currentStandardCycle: null,
});

/**
 * The subset of BucketKPIs derived from state logs (not cycles).
 *
 * Note: idealCycleSeconds and totalCycleSeconds are cycle-based KPIs
 * handled by atomic increment in updateCountBased, not here.
 */
export type DurationKPIs = Pick<
  BucketKPIs,
  | "runSeconds"
  | "downSeconds"
  | "plannedDownSeconds"
  | "unplannedDownSeconds"
  | "elapsedPlannedProductionSeconds"
  | "elapsedExpectedCycles"
  | "elapsedExpectedItems"
>;

/** The subset of BucketKPIs that are count based. */
export type CountKPIs = Pick<
  BucketKPIs,
  "totalCycles" | "badCycles" | "totalItems" | "badItems" | "expectedCycles" | "expectedItems"
>;

/**
 * Keys of all additive KPI fields (summed in rollups).
 * `currentStandardCycle` is excluded because it is NOT additive —
 * rollups take the latest sub-bucket's value instead of summing.
 */
export const ADDITIVE_KPI_KEYS: ReadonlyArray<AdditiveKpiKey> = [
  "totalCycles",
  "badCycles",
  "totalItems",
  "badItems",
  "expectedCycles",
  "expectedItems",
  "runSeconds",
  "downSeconds",
  "plannedDownSeconds",
  "unplannedDownSeconds",
  "idealCycleSeconds",
  "totalCycleSeconds",
  "elapsedExpectedCycles",
  "elapsedExpectedItems",
  "elapsedPlannedProductionSeconds",
] as const;

/** @deprecated Use ADDITIVE_KPI_KEYS. Alias kept for backward compat. */
export const KPI_KEYS = ADDITIVE_KPI_KEYS;

export const DURATION_KPI_KEYS: ReadonlyArray<keyof DurationKPIs> = [
  "runSeconds",
  "downSeconds",
  "plannedDownSeconds",
  "unplannedDownSeconds",
  "elapsedPlannedProductionSeconds",
  "elapsedExpectedCycles",
  "elapsedExpectedItems",
] as const;

export const COUNT_KPI_KEYS: ReadonlyArray<keyof CountKPIs> = [
  "totalCycles",
  "badCycles",
  "totalItems",
  "badItems",
  "expectedCycles",
  "expectedItems",
] as const;

// ── Job filter ───────────────────────────────────────────────────

/**
 * When provided, restricts computation to a specific job on the station.
 *
 * - Cycles are filtered to those created while the job was active
 *   (by matching the jobBlobId snapshot)
 * - State log durations are clipped to the job's active period within
 *   the bucket window
 * - The job's snapshotted standardCycle is used directly for
 *   idealCycleSeconds and expectedCycles (not averaged from cycles)
 */
export interface JobFilter {
  /** The job ID to filter cycles for. */
  jobId: string;
  /** The job blob ID snapshotted at assignment time. */
  jobBlobId: string;
  /** When the job was assigned to this station. */
  jobLogStartTime: Date;
  /** When the job was removed from this station. null = still active. */
  jobLogEndTime: Date | null;
  /** Standard cycle time in seconds from the job blob snapshot. null if unknown. */
  standardCycle: number | null;
  /** Number of inventory items produced per cycle for this job. */
  itemsPerCycle: number;
}

// ── Compute ──────────────────────────────────────────────────────

/**
 * Compute all KPIs for a single base bucket from raw events.
 *
 * Queries Cycle and StationStateLog for the given station within
 * the time window [bucketStart, bucketEnd). Open state log entries
 * (endTime = null) are clipped to `min(now, bucketEnd)`, so calling
 * this for the current in-progress bucket always returns accurate
 * values as of right now.
 *
 * A cycle is attributed to the bucket that contains its `end` timestamp.
 * State log entries are clipped to bucket boundaries and their durations
 * summed by state (UP/DOWN) and reason (planned/unplanned).
 *
 * When `jobFilter` is provided, the computation is scoped to that job:
 * cycles are filtered by jobBlobId, and state log durations are clipped
 * to the job's active period within the bucket window.
 *
 * @param stationId - The station to compute for
 * @param bucketStart - Start of the time window (inclusive)
 * @param bucketDurationSeconds - Duration of the window in seconds
 * @param jobFilter - Optional job scope for JOB entity bucket computation
 * @returns All KPI values for this bucket, computed from raw events
 */
export async function computeBucketFromEvents(
  stationId: string,
  bucketStart: Date,
  bucketDurationSeconds: number,
  jobFilter?: JobFilter,
): Promise<BucketKPIs> {
  const bucketStartMs = bucketStart.getTime();
  const bucketEndMs = bucketStartMs + bucketDurationSeconds * 1000;
  const bucketEnd = new Date(bucketEndMs);
  const now = Date.now();

  // When computing for a job, determine the effective time window
  // where the job was active within this bucket.
  const jobClip = jobFilter ? resolveJobClip(jobFilter, bucketStartMs, bucketEndMs, now) : null;

  // If the job wasn't active in this bucket at all, return zeros
  if (jobFilter && !jobClip) {
    return { ...ZERO_KPIS };
  }

  // ── 1. Tally count-based KPIs from cycles ──────────────────
  const [cycleTally, badItems] = await Promise.all([
    queryAndTallyCycles(stationId, bucketStart, bucketEnd, bucketStartMs, bucketEndMs, jobFilter),
    // badItems is driven by ItemDispositionLog.quantity, not cycle status.
    queryDispositionBadItems(stationId, bucketStart, bucketEnd),
  ]);

  // ── 2. Tally duration-based KPIs from state logs ───────────
  const durationTally = await queryAndTallyStateLogs(
    stationId,
    bucketStart,
    bucketEnd,
    bucketStartMs,
    bucketEndMs,
    now,
    jobClip,
  );

  // ── 3. Derived KPIs ────────────────────────────────────────
  const effectiveDuration = jobClip ? jobClip.durationSeconds : bucketDurationSeconds;

  // Planned production time = effective duration - planned downtime (full window).
  // Note: plannedProductionSeconds is a DB generated column
  // (durationSeconds - plannedDownSeconds). We compute it locally only
  // to derive expectedCycles / elapsedExpectedCycles below.
  const plannedProductionSeconds = effectiveDuration - durationTally.plannedDownSeconds;

  // Elapsed planned production = runSeconds + unplannedDownSeconds.
  // Derived from the same state log data as runSeconds so the two can
  // never disagree — guaranteeing availability (run / elapsedPlanned)
  // is always <= 1.0.
  const elapsedPlannedProductionSeconds = durationTally.runSeconds + durationTally.unplannedDownSeconds;

  // Resolve standard cycle and items per cycle
  const standardCycle = resolveStandardCycle(jobFilter, cycleTally);
  const itemsPerCycle = jobFilter?.itemsPerCycle ?? resolveItemsPerCycle(cycleTally);

  // Expected cycles: full window
  let expectedCycles = 0;
  if (standardCycle != null && standardCycle > 0) {
    expectedCycles = Math.floor(plannedProductionSeconds / standardCycle);
  }

  // Expected cycles: elapsed window
  let elapsedExpectedCycles = 0;
  if (standardCycle != null && standardCycle > 0) {
    elapsedExpectedCycles = Math.floor(elapsedPlannedProductionSeconds / standardCycle);
  }

  // Expected items: full window and elapsed
  const expectedItems = expectedCycles * itemsPerCycle;
  const elapsedExpectedItems = elapsedExpectedCycles * itemsPerCycle;

  // Current standard cycle: for display
  const currentStandardCycle = standardCycle;

  return {
    totalCycles: cycleTally.totalCycles,
    badCycles: 0, // kept for DB column compat; badness is item-level via disposition logs
    totalItems: cycleTally.totalItems,
    badItems,
    expectedCycles,
    expectedItems,
    runSeconds: durationTally.runSeconds,
    downSeconds: durationTally.downSeconds,
    plannedDownSeconds: durationTally.plannedDownSeconds,
    unplannedDownSeconds: durationTally.unplannedDownSeconds,
    idealCycleSeconds: Math.round(cycleTally.idealCycleSeconds),
    totalCycleSeconds: cycleTally.totalCycleSeconds,
    elapsedExpectedCycles,
    elapsedExpectedItems,
    elapsedPlannedProductionSeconds,
    currentStandardCycle,
  };
}

/**
 * Compute only duration/time-based KPIs for a bucket from state logs.
 *
 * Unlike computeBucketFromEvents, this does NOT query cycles — count-based
 * KPIs (totalCycles, totalItems, idealCycleSeconds, totalCycleSeconds)
 * are handled by atomic increments in the caller.
 *
 * Computes: runSeconds, downSeconds, plannedDownSeconds, unplannedDownSeconds,
 * elapsedPlannedProductionSeconds, expectedCycles, expectedItems,
 * elapsedExpectedCycles, elapsedExpectedItems.
 *
 * @param stationId - The station to compute for
 * @param bucketStart - Start of the time window (inclusive)
 * @param bucketDurationSeconds - Duration of the window in seconds
 * @param standardCycle - Standard cycle time in seconds (for expected cycles)
 * @param itemsPerCycle - Items produced per cycle (for expected items)
 */
export async function computeDurationsForBucket(
  stationId: string,
  bucketStart: Date,
  bucketDurationSeconds: number,
  standardCycle: number | null,
  itemsPerCycle: number,
): Promise<DurationKPIs & { expectedCycles: number; expectedItems: number; currentStandardCycle: number | null }> {
  const bucketStartMs = bucketStart.getTime();
  const bucketEndMs = bucketStartMs + bucketDurationSeconds * 1000;
  const bucketEnd = new Date(bucketEndMs);
  const now = Date.now();

  const durationTally = await queryAndTallyStateLogs(
    stationId,
    bucketStart,
    bucketEnd,
    bucketStartMs,
    bucketEndMs,
    now,
    null, // no job clip
  );

  const plannedProductionSeconds = bucketDurationSeconds - durationTally.plannedDownSeconds;
  const elapsedPlannedProductionSeconds = durationTally.runSeconds + durationTally.unplannedDownSeconds;

  let expectedCycles = 0;
  if (standardCycle != null && standardCycle > 0) {
    expectedCycles = Math.floor(plannedProductionSeconds / standardCycle);
  }

  let elapsedExpectedCycles = 0;
  if (standardCycle != null && standardCycle > 0) {
    elapsedExpectedCycles = Math.floor(elapsedPlannedProductionSeconds / standardCycle);
  }

  const expectedItems = expectedCycles * itemsPerCycle;
  const elapsedExpectedItems = elapsedExpectedCycles * itemsPerCycle;

  return {
    runSeconds: durationTally.runSeconds,
    downSeconds: durationTally.downSeconds,
    plannedDownSeconds: durationTally.plannedDownSeconds,
    unplannedDownSeconds: durationTally.unplannedDownSeconds,
    elapsedPlannedProductionSeconds,
    elapsedExpectedCycles,
    elapsedExpectedItems,
    expectedCycles,
    expectedItems,
    currentStandardCycle: standardCycle,
  };
}

// ── Standard cycle / items-per-cycle resolution ──────────────────

/**
 * Resolve the standard cycle time to use for expected cycle calculations.
 *
 * For JOB buckets: use the job's snapshotted standardCycle directly.
 * For STATION buckets: average the idealCycleSeconds from actual cycles.
 * Returns null if unknown (no job filter and no cycles).
 */
function resolveStandardCycle(jobFilter: JobFilter | undefined, cycleTally: CycleTally): number | null {
  if (jobFilter?.standardCycle != null && jobFilter.standardCycle > 0) {
    return jobFilter.standardCycle;
  }
  if (cycleTally.totalCycles > 0 && cycleTally.idealCycleSeconds > 0) {
    return cycleTally.idealCycleSeconds / cycleTally.totalCycles;
  }
  return null;
}

/**
 * Resolve items-per-cycle from actual cycle data when no JobFilter is available.
 *
 * Falls back to 1 if no cycles exist.
 */
function resolveItemsPerCycle(cycleTally: CycleTally): number {
  if (cycleTally.totalCycles > 0 && cycleTally.totalItems > 0) {
    return Math.round(cycleTally.totalItems / cycleTally.totalCycles);
  }
  return 1;
}

// ── Cycle query and tally ────────────────────────────────────────

// ── Disposition-based bad items ──────────────────────────────────

/**
 * Sum the `quantity` of ItemDispositionLog entries for a given station
 * within a time window.
 *
 * Uses the direct stationId FK and the (stationId, createdAt) index.
 * The log's createdAt determines which hour bucket it falls into.
 */
async function queryDispositionBadItems(stationId: string, bucketStart: Date, bucketEnd: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ sum: bigint | null }>>`
    SELECT COALESCE(SUM("quantity"), 0) AS "sum"
    FROM "ItemDispositionLog"
    WHERE "stationId" = ${stationId}::uuid
      AND "createdAt" >= ${bucketStart}
      AND "createdAt" < ${bucketEnd}
      AND "deletedAt" IS NULL
  `;
  return Number(rows[0]?.sum ?? 0);
}

// ── Cycle tally ─────────────────────────────────────────────────

interface CycleTally {
  totalCycles: number;
  totalItems: number;
  idealCycleSeconds: number;
  totalCycleSeconds: number;
}

/**
 * Query cycles ending in the bucket window and tally count-based KPIs.
 *
 * When a jobFilter is provided, only cycles with a matching jobBlobId
 * are included. The job's snapshotted standardCycle is used for
 * idealCycleSeconds instead of reading from each cycle's blob.
 */
async function queryAndTallyCycles(
  stationId: string,
  bucketStart: Date,
  bucketEnd: Date,
  bucketStartMs: number,
  bucketEndMs: number,
  jobFilter?: JobFilter,
): Promise<CycleTally> {
  // Two-query approach: fetch cycles, then batch-fetch inventory counts
  // only for matched cycle IDs.  This avoids a subquery that aggregates
  // the entire InventoryItem table.
  const cycles = jobFilter
    ? await prisma.$queryRaw<
        Array<{
          id: string;
          start: Date;
          end: Date | null;
          cycleStatus: string;
          standardCycle: number | null;
        }>
      >`
        SELECT c."id", c."start", c."end", c."cycleStatus",
               jb."standardCycle"::float8 AS "standardCycle"
        FROM "Cycle" c
        LEFT JOIN "JobBlob" jb ON jb."id" = c."jobBlobId"
        WHERE c."stationId" = ${stationId}::uuid
          AND c."end" IS NOT NULL
          AND c."end" >= ${bucketStart}
          AND c."end" < ${bucketEnd}
          AND c."deletedAt" IS NULL
          AND c."jobBlobId" = ${jobFilter.jobBlobId}::uuid
      `
    : await prisma.$queryRaw<
        Array<{
          id: string;
          start: Date;
          end: Date | null;
          cycleStatus: string;
          standardCycle: number | null;
        }>
      >`
        SELECT c."id", c."start", c."end", c."cycleStatus",
               jb."standardCycle"::float8 AS "standardCycle"
        FROM "Cycle" c
        LEFT JOIN "JobBlob" jb ON jb."id" = c."jobBlobId"
        WHERE c."stationId" = ${stationId}::uuid
          AND c."end" IS NOT NULL
          AND c."end" >= ${bucketStart}
          AND c."end" < ${bucketEnd}
          AND c."deletedAt" IS NULL
      `;

  // Batch-count inventory items scoped to only the matched cycles.
  // Uses the InventoryItem(cycleId) index — touches only relevant rows.
  const cycleIds = cycles.map((c) => c.id);
  const itemCounts =
    cycleIds.length > 0
      ? await prisma.$queryRaw<Array<{ cycleId: string; count: bigint }>>`
          SELECT "cycleId", COUNT(*)::bigint AS "count"
          FROM "InventoryItem"
          WHERE "cycleId" = ANY(${cycleIds}::uuid[])
          GROUP BY "cycleId"
        `
      : [];

  const countMap = new Map(itemCounts.map((ic) => [ic.cycleId, Number(ic.count)]));

  let totalCycles = 0;
  let totalItems = 0;
  let idealCycleSeconds = 0;
  let totalCycleMs = 0;

  for (const c of cycles) {
    totalCycles++;
    const items = countMap.get(c.id) ?? 0;
    totalItems += items;

    // For job buckets, use the job's standardCycle consistently.
    // For station buckets, use each cycle's own blob snapshot.
    if (jobFilter?.standardCycle != null) {
      idealCycleSeconds += jobFilter.standardCycle;
    } else {
      const stdCycle = c.standardCycle ? Number(c.standardCycle) : 0;
      idealCycleSeconds += stdCycle;
    }

    // Actual cycle duration, clipped to bucket boundaries.
    // Accumulate raw ms to avoid per-entry rounding drift.
    if (c.end) {
      const cycleStartMs = Math.max(c.start.getTime(), bucketStartMs);
      const cycleEndMs = Math.min(c.end.getTime(), bucketEndMs);
      totalCycleMs += Math.max(0, cycleEndMs - cycleStartMs);
    }
  }

  const totalCycleSeconds = Math.round(totalCycleMs / 1000);
  return { totalCycles, totalItems, idealCycleSeconds, totalCycleSeconds };
}

// ── State log query and tally ────────────────────────────────────

interface DurationTally {
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
}

/** Resolved clip boundaries for a job within a bucket. */
interface JobClipWindow {
  /** Effective start of the job within this bucket (ms). */
  startMs: number;
  /** Effective end of the job within this bucket (ms). */
  endMs: number;
  /** Duration of the job's active period in this bucket (seconds) — full window. */
  durationSeconds: number;
  /** Duration of the job's active period elapsed so far (clips to now). */
  elapsedDurationSeconds: number;
}

/**
 * Determine the effective time window where a job was active within a bucket.
 *
 * Returns null if the job was not active in this bucket at all.
 */
function resolveJobClip(
  jobFilter: JobFilter,
  bucketStartMs: number,
  bucketEndMs: number,
  now: number,
): JobClipWindow | null {
  const jobStartMs = jobFilter.jobLogStartTime.getTime();
  const jobEndMs = jobFilter.jobLogEndTime ? jobFilter.jobLogEndTime.getTime() : Math.min(now, bucketEndMs);

  // Clamp to bucket boundaries
  const effectiveStartMs = Math.max(jobStartMs, bucketStartMs);
  const effectiveEndMs = Math.min(jobEndMs, bucketEndMs);

  if (effectiveStartMs >= effectiveEndMs) return null;

  // Elapsed: clip end to now (for in-progress jobs in the current bucket)
  const elapsedEndMs = Math.min(effectiveEndMs, now);
  const elapsedDurationSeconds = Math.max(0, (elapsedEndMs - effectiveStartMs) / 1000);

  return {
    startMs: effectiveStartMs,
    endMs: effectiveEndMs,
    durationSeconds: (effectiveEndMs - effectiveStartMs) / 1000,
    elapsedDurationSeconds,
  };
}

/**
 * Query state log entries overlapping the bucket window and tally
 * duration-based KPIs.
 *
 * When a jobClip is provided, state log entries are further clipped
 * to the job's active period within the bucket. This means only the
 * time the station spent in each state while the job was running is
 * counted toward the job's KPIs.
 */
async function queryAndTallyStateLogs(
  stationId: string,
  bucketStart: Date,
  bucketEnd: Date,
  bucketStartMs: number,
  bucketEndMs: number,
  now: number,
  jobClip: JobClipWindow | null,
): Promise<DurationTally> {
  const stateLogs = await prisma.$queryRaw<
    Array<{
      startTime: Date;
      endTime: Date | null;
      state: string;
      isPlannedDown: boolean | null;
    }>
  >`
    SELECT ssl."startTime", ssl."endTime", ssl."state",
           sr."isPlannedDown"
    FROM "StationStateLog" ssl
    LEFT JOIN "StatusReason" sr ON sr."id" = ssl."statusReasonId"
    WHERE ssl."stationId" = ${stationId}::uuid
      AND ssl."deletedAt" IS NULL
      AND ssl."startTime" < ${bucketEnd}
      AND (ssl."endTime" > ${bucketStart} OR ssl."endTime" IS NULL)
  `;

  // Accumulate raw milliseconds to avoid per-entry rounding drift.
  // A single round at the end preserves sub-second fractions across
  // hundreds of entries (e.g. 190 × 0.1s ≈ 19s that was previously lost).
  let runMs = 0;
  let downMs = 0;
  let plannedDownMs = 0;
  let unplannedDownMs = 0;

  // Determine the effective outer bounds for clipping
  const clipStartMs = jobClip ? jobClip.startMs : bucketStartMs;
  const clipEndMs = jobClip ? jobClip.endMs : bucketEndMs;

  for (const entry of stateLogs) {
    // Clip entry to bucket boundaries (and job boundaries if applicable)
    const effectiveStartMs = Math.max(entry.startTime.getTime(), clipStartMs);
    const effectiveEndMs = entry.endTime ? Math.min(entry.endTime.getTime(), clipEndMs) : Math.min(now, clipEndMs);

    const ms = Math.max(0, effectiveEndMs - effectiveStartMs);

    if (ms === 0) continue;

    if (entry.state === "UP") {
      runMs += ms;
    } else {
      // DOWN
      downMs += ms;
      if (entry.isPlannedDown) {
        plannedDownMs += ms;
      } else {
        unplannedDownMs += ms;
      }
    }
  }

  return {
    runSeconds: Math.round(runMs / 1000),
    downSeconds: Math.round(downMs / 1000),
    plannedDownSeconds: Math.round(plannedDownMs / 1000),
    unplannedDownSeconds: Math.round(unplannedDownMs / 1000),
  };
}

// ── Summation helper ─────────────────────────────────────────────

/**
 * Sum multiple BucketKPIs into a single aggregate.
 *
 * Used by rollup logic to derive higher granularities (SHIFT from HOURs)
 * and higher entity levels (WORKCENTER from STATIONs).
 *
 * Note: `expectedCycles`, `expectedItems`, and `plannedProductionSeconds`
 * are additive because each sub-bucket computes them independently based
 * on its own time window and planned downtime. Summing them gives the
 * correct total for the parent bucket.
 *
 * `currentStandardCycle` is NOT summed — it is handled separately by the
 * rollup layer (takes the latest sub-bucket's value).
 */
export function sumKPIs(buckets: ReadonlyArray<BucketKPIs>): BucketKPIs {
  const result = { ...ZERO_KPIS };
  for (const b of buckets) {
    for (const key of ADDITIVE_KPI_KEYS) {
      result[key] += b[key];
    }
  }
  return result;
}
