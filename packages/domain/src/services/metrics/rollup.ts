// ── Cascading rollups ────────────────────────────────────────────
// Derives higher-granularity and higher-entity-level buckets by
// summing base (HOUR + STATION) buckets.
//
// Rollup order:
//   1. Time rollups:   HOUR+STATION  → SHIFT+STATION, DAY+STATION
//   2. Entity rollups: *+STATION     → *+WORKCENTER, *+SITE
//
// When a jobEntity is provided (JOB rollups):
//   1. Time rollups:   HOUR+JOB  → SHIFT+JOB, DAY+JOB
//   (No entity rollups — JOB is not hierarchical)
//
// All rollups are idempotent: re-running produces the same result
// because they replace (not increment) the target bucket values.
//
// `currentStandardCycle` is NOT summed — it is taken from the
// sub-bucket with the latest startTime (the most recent hour).

import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import { type BucketKPIs, ZERO_KPIS, ADDITIVE_KPI_KEYS, sumKPIs } from "./compute.js";
import { getIncrementTargets, resolveEntityName, resolveEntityPath } from "./hierarchy.js";
import { onBucketsChanged, rowToSnapshot, type BucketChange } from "./sync.js";
import { getShiftForEntity, getLocalMidnightUTC } from "./shift.js";
import { resolveBusinessDate } from "./bucket.js";
import type { MetricsContext } from "./context.js";
import { jobEntityId } from "./cascade.js";

// ── Types ────────────────────────────────────────────────────────

type EntityType = "STATION" | "WORKCENTER" | "SITE" | "JOB";
type Granularity = "MINUTE" | "HOUR" | "SHIFT" | "DAY";

interface BucketWindow {
  startTime: Date;
  durationSeconds: number;
}

export interface RollupInput {
  stationId: string;
  siteId: string;
  /** The base-granularity bucket windows that were recomputed. */
  affectedBuckets: BucketWindow[];
  /** Site IANA timezone (used for day boundary calculation and businessDate fallback). */
  timezone: string;
  /** Business date for the affected buckets. When provided, set on rolled-up buckets. */
  businessDate?: Date | null;
  /** Business shift name for the affected buckets (e.g. "Shift 1"). */
  businessShift?: string | null;
  /**
   * Station display name and hierarchical path.
   * When provided, used for SHIFT+STATION and DAY+STATION upserts.
   * If omitted, resolved from the database.
   */
  stationEntity?: {
    stationName: string;
    stationPath: string;
  };
  /**
   * When provided, performs JOB time rollups instead of the normal
   * STATION hierarchy rollups. Only HOUR+JOB → SHIFT+JOB, DAY+JOB.
   */
  jobEntity?: {
    jobId: string;
    /** Human-readable job name (from JobBlob). */
    jobName: string;
    /** Hierarchical path: station path + `.job.{jobId}`. */
    jobPath: string;
  };
  /**
   * When true, skip the parent entity rollups (WORKCENTER and SITE).
   * Only station-level time rollups (HOUR→SHIFT, HOUR→DAY) are performed.
   * Use this when batch-processing multiple stations in the same workcenter
   * and deferring the parent rollup to after all stations are updated.
   */
  skipParentRollup?: boolean;
  /** Per-pipeline cache. When provided, shift lookups etc. are cached. */
  ctx?: MetricsContext;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Cascade rollups for a station after its base buckets were recomputed.
 *
 * Normal mode (no jobEntity):
 * 1. Determines which SHIFT and DAY windows overlap the affected base buckets
 * 2. For each: sums the HOUR+STATION buckets within that window → upserts
 * 3. Walks the entity hierarchy (workcenter chain + site) and for each
 *    affected (granularity, startTime): sums child STATION buckets → upserts
 * 4. Publishes all changed buckets via onBucketsChanged()
 *
 * JOB mode (jobEntity provided):
 * 1. Determines affected SHIFT and DAY windows (same as normal)
 * 2. Sums HOUR+JOB buckets within each window → upserts SHIFT+JOB, DAY+JOB
 * 3. No entity rollups (JOB is not hierarchical)
 */
export async function rollupBuckets(input: RollupInput): Promise<void> {
  const { stationId, siteId, affectedBuckets, timezone, stationEntity, jobEntity, skipParentRollup, ctx } = input;
  const businessDate = input.businessDate ?? null;
  const businessShift = input.businessShift ?? null;
  const changes: BucketChange[] = [];

  if (affectedBuckets.length === 0) return;

  if (jobEntity) {
    await rollupJobBuckets(
      stationId,
      siteId,
      affectedBuckets,
      timezone,
      jobEntity.jobId,
      jobEntity.jobName,
      jobEntity.jobPath,
      changes,
      businessDate,
      businessShift,
      ctx,
    );
  } else {
    await rollupStationBuckets(
      stationId,
      siteId,
      affectedBuckets,
      timezone,
      stationEntity,
      changes,
      businessDate,
      businessShift,
      skipParentRollup,
      ctx,
    );
  }

  // Publish changes
  if (changes.length > 0) {
    onBucketsChanged(changes).catch((err) => {
      console.error("[metrics:rollup] Failed to notify bucket changes:", err);
    });
  }
}

// ── Station rollups (normal mode) ────────────────────────────────

async function rollupStationBuckets(
  stationId: string,
  siteId: string,
  affectedBuckets: BucketWindow[],
  timezone: string,
  stationEntity: { stationName: string; stationPath: string } | undefined,
  changes: BucketChange[],
  businessDate: Date | null,
  businessShift: string | null,
  skipParentRollup?: boolean,
  ctx?: MetricsContext,
): Promise<void> {
  // ── 0. Resolve station name/path (query DB if not provided) ──
  let stationName: string;
  let stationPath: string;
  if (stationEntity) {
    stationName = stationEntity.stationName;
    stationPath = stationEntity.stationPath;
  } else {
    const [name, path] = await Promise.all([
      resolveEntityName("STATION", stationId, undefined, ctx),
      resolveEntityPath("STATION", stationId, siteId, undefined, ctx),
    ]);
    stationName = name;
    stationPath = path;
  }

  // ── 1. Determine affected SHIFT and DAY windows ─────────────
  const affectedShifts = await resolveAffectedShifts(stationId, siteId, affectedBuckets, ctx);
  const affectedDays = resolveAffectedDays(affectedBuckets, timezone);

  // ── 2. Time rollups: SHIFT+STATION and DAY+STATION ──────────
  // Collect all (granularity, window) pairs that need entity rollup.
  // Each entry carries the shiftInstanceId for the station's shift context.
  const stationRollupTargets: Array<{
    granularity: Granularity;
    window: BucketWindow;
    granularityName: string;
    shiftInstanceId: string | null;
    businessDate: Date | null;
    businessShift: string | null;
  }> = [];

  // Include the affected base buckets themselves for entity rollup.
  // Resolve the station's shift at each bucket's startTime to tag with shiftInstanceId.
  for (const bucket of affectedBuckets) {
    const bucketShift = await getShiftForEntity("STATION", stationId, siteId, bucket.startTime, ctx);
    stationRollupTargets.push({
      granularity: "HOUR",
      window: bucket,
      granularityName: "Hour",
      shiftInstanceId: bucketShift?.shiftInstanceId ?? null,
      businessDate,
      businessShift,
    });
  }

  for (const shift of affectedShifts) {
    // Always resolve per-shift labels from the ShiftInstance — the
    // caller's businessDate/businessShift may be from a different shift
    // when a pipeline crosses shift boundaries.
    const shiftBusinessDate = await resolveBusinessDate(shift.startTime, shift.shiftInstanceId, timezone);
    const shiftBusinessShift = shift.shiftName ?? null;
    const { kpis, currentStandardCycle, currentJobId, currentJobName } = await sumBucketsInWindowWithStdCycle(
      "STATION",
      stationId,
      "HOUR",
      shift,
    );
    const updated = await upsertBucket({
      siteId,
      entityType: "STATION",
      entityId: stationId,
      entityName: stationName,
      path: stationPath,
      granularity: "SHIFT",
      granularityName: shift.shiftName ?? "Shift",
      startTime: shift.startTime,
      durationSeconds: shift.durationSeconds,
      kpis,
      currentStandardCycle,
      currentJobId,
      currentJobName,
      shiftInstanceId: shift.shiftInstanceId,
      businessDate: shiftBusinessDate,
      businessShift: shiftBusinessShift,
    });
    if (updated) {
      changes.push(toBucketChange(updated));
    }
    stationRollupTargets.push({
      granularity: "SHIFT",
      window: shift,
      granularityName: shift.shiftName ?? "Shift",
      shiftInstanceId: shift.shiftInstanceId,
      businessDate: shiftBusinessDate,
      businessShift: shiftBusinessShift,
    });
  }

  for (const day of affectedDays) {
    const { kpis, currentStandardCycle, currentJobId, currentJobName } = await sumBucketsInWindowWithStdCycle(
      "STATION",
      stationId,
      "HOUR",
      day,
    );
    const updated = await upsertBucket({
      siteId,
      entityType: "STATION",
      entityId: stationId,
      entityName: stationName,
      path: stationPath,
      granularity: "DAY",
      granularityName: "Day",
      startTime: day.startTime,
      durationSeconds: day.durationSeconds,
      kpis,
      currentStandardCycle,
      currentJobId,
      currentJobName,
      shiftInstanceId: null,
      businessDate,
      businessShift: null,
    });
    if (updated) {
      changes.push(toBucketChange(updated));
    }
    stationRollupTargets.push({
      granularity: "DAY",
      window: day,
      granularityName: "Day",
      shiftInstanceId: null,
      businessDate,
      businessShift: null,
    });
  }

  // ── 3. Entity rollups: WORKCENTER and SITE ──────────────────
  // When skipParentRollup is true, only station-level time rollups were
  // needed (the caller will do a single parent rollup after all stations
  // in the workcenter group are updated).
  if (skipParentRollup) return;

  const targets = await getIncrementTargets(stationId, siteId, ctx);
  // targets[0] is the station itself — skip it for entity rollup
  const parentTargets = targets.filter((t) => t.entityType !== "STATION");

  for (const parent of parentTargets) {
    const childStationIds = await getChildStationIds(parent.entityType, parent.entityId, ctx);

    for (const target of stationRollupTargets) {
      const { granularity, window, granularityName, shiftInstanceId } = target;
      const kpis = await sumEntityBucketsInWindow(childStationIds, "STATION", granularity, window);

      // For HOUR and SHIFT granularity, resolve the parent entity's own shift instance.
      // The parent (WORKCENTER/SITE) may have a different shift instance than the station.
      let parentShiftInstanceId: string | null = null;
      if (shiftInstanceId != null) {
        const parentShift = await getShiftForEntity(parent.entityType, parent.entityId, siteId, window.startTime, ctx);
        parentShiftInstanceId = parentShift?.shiftInstanceId ?? null;
      }

      const updated = await upsertBucket({
        siteId,
        entityType: parent.entityType,
        entityId: parent.entityId,
        granularity,
        granularityName,
        startTime: window.startTime,
        durationSeconds: window.durationSeconds,
        kpis,
        entityName: parent.entityName,
        path: parent.path,
        shiftInstanceId: parentShiftInstanceId,
        businessDate: target.businessDate,
        businessShift: target.businessShift,
      });
      if (updated) {
        changes.push(toBucketChange(updated));
      }
    }
  }
}

// ── JOB rollups ──────────────────────────────────────────────────

/**
 * JOB time rollups: sum HOUR+JOB → SHIFT+JOB, DAY+JOB.
 *
 * Uses the station's shift schedule for determining shift/day windows
 * (JOB buckets follow the station's schedule).
 */
async function rollupJobBuckets(
  stationId: string,
  siteId: string,
  affectedBuckets: BucketWindow[],
  timezone: string,
  jobId: string,
  jobName: string,
  jobPath: string,
  changes: BucketChange[],
  businessDate: Date | null,
  _businessShift: string | null,
  ctx?: MetricsContext,
): Promise<void> {
  const affectedShifts = await resolveAffectedShifts(stationId, siteId, affectedBuckets, ctx);
  const affectedDays = resolveAffectedDays(affectedBuckets, timezone);

  // SHIFT+JOB rollups
  for (const shift of affectedShifts) {
    const shiftBusinessDate = await resolveBusinessDate(shift.startTime, shift.shiftInstanceId, timezone);
    const shiftBusinessShift = shift.shiftName ?? null;
    const compositeJobId = jobEntityId(stationId, jobId);
    const { kpis, currentStandardCycle, currentJobId, currentJobName } = await sumBucketsInWindowWithStdCycle(
      "JOB",
      compositeJobId,
      "HOUR",
      shift,
    );
    const updated = await upsertBucket({
      siteId,
      entityType: "JOB",
      entityId: compositeJobId,
      entityName: jobName,
      path: jobPath,
      granularity: "SHIFT",
      granularityName: shift.shiftName ?? "Shift",
      startTime: shift.startTime,
      durationSeconds: shift.durationSeconds,
      kpis,
      currentStandardCycle,
      currentJobId,
      currentJobName,
      shiftInstanceId: shift.shiftInstanceId,
      businessDate: shiftBusinessDate,
      businessShift: shiftBusinessShift,
    });
    if (updated) {
      changes.push(toBucketChange(updated));
    }
  }

  // DAY+JOB rollups
  for (const day of affectedDays) {
    const compositeJobId = jobEntityId(stationId, jobId);
    const { kpis, currentStandardCycle, currentJobId, currentJobName } = await sumBucketsInWindowWithStdCycle(
      "JOB",
      compositeJobId,
      "HOUR",
      day,
    );
    const updated = await upsertBucket({
      siteId,
      entityType: "JOB",
      entityId: compositeJobId,
      entityName: jobName,
      path: jobPath,
      granularity: "DAY",
      granularityName: "Day",
      startTime: day.startTime,
      durationSeconds: day.durationSeconds,
      kpis,
      currentStandardCycle,
      currentJobId,
      currentJobName,
      shiftInstanceId: null,
      businessDate,
      businessShift: null,
    });
    if (updated) {
      changes.push(toBucketChange(updated));
    }
  }
}

// ── Shift window resolution ──────────────────────────────────────

interface ShiftBucketWindow extends BucketWindow {
  shiftName: string;
  shiftInstanceId: string;
}

/**
 * Determine which shift windows are affected by the given base buckets.
 * Deduplicates by shift startTime.
 */
async function resolveAffectedShifts(
  stationId: string,
  siteId: string,
  buckets: BucketWindow[],
  ctx?: MetricsContext,
): Promise<ShiftBucketWindow[]> {
  const seen = new Map<number, ShiftBucketWindow>();

  for (const bucket of buckets) {
    // Check shift at the start of the bucket
    const shift = await getShiftForEntity("STATION", stationId, siteId, bucket.startTime, ctx);
    if (shift && !seen.has(shift.startTime.getTime())) {
      seen.set(shift.startTime.getTime(), {
        startTime: shift.startTime,
        durationSeconds: shift.durationSeconds,
        shiftName: shift.shiftName,
        shiftInstanceId: shift.shiftInstanceId,
      });
    }

    // Also check shift at the end of the bucket (might span two shifts)
    const bucketEnd = new Date(bucket.startTime.getTime() + bucket.durationSeconds * 1000 - 1);
    const endShift = await getShiftForEntity("STATION", stationId, siteId, bucketEnd, ctx);
    if (endShift && !seen.has(endShift.startTime.getTime())) {
      seen.set(endShift.startTime.getTime(), {
        startTime: endShift.startTime,
        durationSeconds: endShift.durationSeconds,
        shiftName: endShift.shiftName,
        shiftInstanceId: endShift.shiftInstanceId,
      });
    }
  }

  return Array.from(seen.values());
}

/**
 * Determine which calendar day windows are affected by the given base buckets.
 * Deduplicates by day startTime.
 */
function resolveAffectedDays(buckets: BucketWindow[], timezone: string): BucketWindow[] {
  const seen = new Map<number, BucketWindow>();

  for (const bucket of buckets) {
    const dayStart = getLocalMidnightUTC(bucket.startTime, timezone);
    if (!seen.has(dayStart.getTime())) {
      seen.set(dayStart.getTime(), {
        startTime: dayStart,
        durationSeconds: 86400,
      });
    }

    // Also check the day at the end of the bucket
    const bucketEnd = new Date(bucket.startTime.getTime() + bucket.durationSeconds * 1000 - 1);
    const endDayStart = getLocalMidnightUTC(bucketEnd, timezone);
    if (!seen.has(endDayStart.getTime())) {
      seen.set(endDayStart.getTime(), {
        startTime: endDayStart,
        durationSeconds: 86400,
      });
    }
  }

  return Array.from(seen.values());
}

// ── DB helpers ───────────────────────────────────────────────────

/** Raw row shape returned by the UNION ALL bucket query. */
interface RawBucketRow {
  source: string;
  startTime: Date;
  totalCycles: number;
  badCycles: number;
  totalItems: number;
  badItems: number;
  expectedCycles: number;
  expectedItems: number;
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
  idealCycleSeconds: number;
  totalCycleSeconds: number;
  elapsedExpectedCycles: number;
  elapsedExpectedItems: number;
  elapsedPlannedProductionSeconds: number;
  currentStandardCycle: number | null;
  currentJobId: string | null;
  currentJobName: string | null;
}

/**
 * Sum all buckets for an entity within a time window, and also resolve
 * `currentStandardCycle` from the sub-bucket with the latest startTime.
 *
 * Used for time rollups (HOUR → SHIFT, HOUR → DAY) for both STATION and JOB.
 */
async function sumBucketsInWindowWithStdCycle(
  entityType: EntityType,
  entityId: string,
  baseGranularity: Granularity,
  window: BucketWindow,
): Promise<{
  kpis: BucketKPIs;
  currentStandardCycle: number | null;
  currentJobId: string | null;
  currentJobName: string | null;
}> {
  const windowEnd = new Date(window.startTime.getTime() + window.durationSeconds * 1000);

  // Query both live and archived tables via UNION ALL, tagging the source
  // so we can prefer live rows over archived when deduplicating.
  const rows = await prisma.$queryRaw<RawBucketRow[]>`
    SELECT
      'live' AS source,
      "startTime",
      "totalCycles", "badCycles", "totalItems", "badItems",
      "expectedCycles", "expectedItems",
      "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
      "idealCycleSeconds", "totalCycleSeconds",
      "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
      "currentStandardCycle"::double precision AS "currentStandardCycle",
      "currentJobId", "currentJobName"
    FROM "MetricBucket"
    WHERE "entityType" = ${entityType}::"BucketEntityType"
      AND "entityId" = ${entityId}::uuid
      AND "granularity" = ${baseGranularity}::"BucketGranularity"
      AND "startTime" >= ${window.startTime}
      AND "startTime" < ${windowEnd}

    UNION ALL

    SELECT
      'archived' AS source,
      "startTime",
      "totalCycles", "badCycles", "totalItems", "badItems",
      "expectedCycles", "expectedItems",
      "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
      "idealCycleSeconds", "totalCycleSeconds",
      "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
      "currentStandardCycle"::double precision AS "currentStandardCycle",
      "currentJobId", "currentJobName"
    FROM "MetricBucketLog"
    WHERE "entityType" = ${entityType}::"BucketEntityType"
      AND "entityId" = ${entityId}::uuid
      AND "granularity" = ${baseGranularity}::"BucketGranularity"
      AND "startTime" >= ${window.startTime}
      AND "startTime" < ${windowEnd}

    ORDER BY "startTime" ASC, source ASC
  `;

  // Merge, preferring live over archived (by startTime dedup).
  // Rows are ordered by startTime ASC, source ASC ('archived' < 'live'),
  // but we want live to win, so we track seen startTimes.
  const seen = new Set<number>();
  const buckets: RawBucketRow[] = [];
  // First pass: collect live rows
  for (const r of rows) {
    if (r.source === "live") {
      seen.add(r.startTime.getTime());
      buckets.push(r);
    }
  }
  // Second pass: add archived rows not already covered by live
  for (const r of rows) {
    if (r.source === "archived" && !seen.has(r.startTime.getTime())) {
      buckets.push(r);
    }
  }
  buckets.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  if (buckets.length === 0) {
    return { kpis: { ...ZERO_KPIS }, currentStandardCycle: null, currentJobId: null, currentJobName: null };
  }

  const kpis = sumKPIs(buckets.map(rowToKPIs));

  // currentStandardCycle, currentJobId, currentJobName: take from the latest sub-bucket
  // that has a non-null value (same "walk backwards" pattern for all three).
  let currentStandardCycle: number | null = null;
  let currentJobId: string | null = null;
  let currentJobName: string | null = null;
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (currentStandardCycle == null && buckets[i].currentStandardCycle != null) {
      currentStandardCycle = Number(buckets[i].currentStandardCycle);
    }
    if (currentJobId == null && buckets[i].currentJobId != null) {
      currentJobId = buckets[i].currentJobId;
      currentJobName = buckets[i].currentJobName;
    }
    if (currentStandardCycle != null && currentJobId != null) break;
  }

  return { kpis, currentStandardCycle, currentJobId, currentJobName };
}

/** Raw row shape returned by the entity-bucket query. */
interface RawEntityBucketRow extends RawBucketRow {
  entityId: string;
}

/**
 * Sum all buckets of a given granularity for a set of child stations
 * within a time window. Used for entity rollups (STATION → WORKCENTER/SITE).
 */
async function sumEntityBucketsInWindow(
  childEntityIds: string[],
  childEntityType: EntityType,
  granularity: Granularity,
  window: BucketWindow,
): Promise<BucketKPIs> {
  if (childEntityIds.length === 0) return { ...ZERO_KPIS };

  const entityIdArray = childEntityIds.map((id) => Prisma.sql`${id}::uuid`);

  // Query both live and archived tables, dedup preferring live over archived by entityId
  const rows = await prisma.$queryRaw<RawEntityBucketRow[]>`
    SELECT
      'live' AS source,
      "entityId",
      "startTime",
      "totalCycles", "badCycles", "totalItems", "badItems",
      "expectedCycles", "expectedItems",
      "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
      "idealCycleSeconds", "totalCycleSeconds",
      "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
      "currentStandardCycle"::double precision AS "currentStandardCycle",
      "currentJobId", "currentJobName"
    FROM "MetricBucket"
    WHERE "entityType" = ${childEntityType}::"BucketEntityType"
      AND "entityId" IN (${Prisma.join(entityIdArray)})
      AND "granularity" = ${granularity}::"BucketGranularity"
      AND "startTime" = ${window.startTime}

    UNION ALL

    SELECT
      'archived' AS source,
      "entityId",
      "startTime",
      "totalCycles", "badCycles", "totalItems", "badItems",
      "expectedCycles", "expectedItems",
      "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
      "idealCycleSeconds", "totalCycleSeconds",
      "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
      "currentStandardCycle"::double precision AS "currentStandardCycle",
      "currentJobId", "currentJobName"
    FROM "MetricBucketLog"
    WHERE "entityType" = ${childEntityType}::"BucketEntityType"
      AND "entityId" IN (${Prisma.join(entityIdArray)})
      AND "granularity" = ${granularity}::"BucketGranularity"
      AND "startTime" = ${window.startTime}
  `;

  // Merge, preferring live over archived (dedup by entityId)
  const seen = new Set<string>();
  const buckets: RawEntityBucketRow[] = [];
  for (const r of rows) {
    if (r.source === "live") {
      seen.add(r.entityId);
      buckets.push(r);
    }
  }
  for (const r of rows) {
    if (r.source === "archived" && !seen.has(r.entityId)) {
      buckets.push(r);
    }
  }

  if (buckets.length === 0) return { ...ZERO_KPIS };

  return sumKPIs(buckets.map(rowToKPIs));
}

/**
 * Get all station IDs that are children of a given entity.
 *
 * - WORKCENTER: all stations directly in this workcenter + stations
 *   in descendant workcenters (uses a WITH RECURSIVE CTE)
 * - SITE: all stations in this site
 */
async function getChildStationIds(entityType: EntityType, entityId: string, ctx?: MetricsContext): Promise<string[]> {
  // Check cache
  if (ctx) {
    const cached = ctx.getChildStationIdsCached(entityType, entityId);
    if (cached) return cached;
  }

  let result: string[];

  if (entityType === "SITE") {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Station"
      WHERE "siteId" = ${entityId}::uuid
        AND "deletedAt" IS NULL
    `;
    result = rows.map((r) => r.id);
  } else if (entityType === "WORKCENTER") {
    // Collect this workcenter + all descendant workcenters, then find stations
    const wcIds = await collectDescendantWorkcenters(entityId);
    wcIds.push(entityId);

    const wcIdArray = wcIds.map((id) => Prisma.sql`${id}::uuid`);
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Station"
      WHERE "workcenterId" IN (${Prisma.join(wcIdArray)})
        AND "deletedAt" IS NULL
    `;
    result = rows.map((r) => r.id);
  } else {
    result = [];
  }

  ctx?.setChildStationIdsCached(entityType, entityId, result);
  return result;
}

/**
 * Recursively collect all descendant workcenter IDs using a WITH RECURSIVE CTE.
 */
async function collectDescendantWorkcenters(parentId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE descendants AS (
      SELECT id FROM "Workcenter" WHERE "parentId" = ${parentId}::uuid
      UNION ALL
      SELECT w.id FROM "Workcenter" w JOIN descendants d ON w."parentId" = d.id
    )
    SELECT id FROM descendants
  `;
  return rows.map((r) => r.id);
}

// ── Upsert helper ────────────────────────────────────────────────

interface UpsertInput {
  siteId: string;
  entityType: EntityType;
  entityId: string;
  granularity: Granularity;
  granularityName: string;
  startTime: Date;
  durationSeconds: number;
  kpis: BucketKPIs;
  entityName?: string;
  path?: string;
  /** Override currentStandardCycle (for rollups that resolve it from sub-buckets). */
  currentStandardCycle?: number | null;
  /** ShiftInstance ID for this bucket. Null for DAY or when no shift exists. */
  shiftInstanceId?: string | null;
  /** Business date this bucket belongs to. */
  businessDate?: Date | null;
  /** Human-readable shift name (e.g. "Shift 1"). Null for DAY or when no shift. */
  businessShift?: string | null;
  /** Current job ID on the station. Null for WORKCENTER/SITE entities. */
  currentJobId?: string | null;
  /** Human-readable name of the current job. */
  currentJobName?: string | null;
}

/** Row shape returned by upsert RETURNING * queries. */
interface RawUpsertRow {
  id: string;
  siteId: string;
  entityType: EntityType;
  entityId: string;
  entityName: string;
  path: string;
  granularity: Granularity;
  granularityName: string;
  startTime: Date;
  durationSeconds: number;
  shiftInstanceId: string | null;
  businessDate: Date | null;
  businessShift: string | null;
  totalCycles: number;
  badCycles: number;
  totalItems: number;
  badItems: number;
  expectedCycles: number;
  expectedItems: number;
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
  idealCycleSeconds: number;
  totalCycleSeconds: number;
  elapsedExpectedCycles: number;
  elapsedExpectedItems: number;
  elapsedPlannedProductionSeconds: number;
  currentStandardCycle: number | null;
  currentJobId: string | null;
  currentJobName: string | null;
  goodCycles: number | null;
  goodItems: number | null;
  plannedProductionSeconds: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
}

/** Row shape for the skip-unchanged check (only needs KPI + metadata columns). */
interface RawExistingRow {
  source: string;
  entityName: string;
  path: string;
  totalCycles: number;
  badCycles: number;
  totalItems: number;
  badItems: number;
  expectedCycles: number;
  expectedItems: number;
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
  idealCycleSeconds: number;
  totalCycleSeconds: number;
  elapsedExpectedCycles: number;
  elapsedExpectedItems: number;
  elapsedPlannedProductionSeconds: number;
  currentStandardCycle: number | null;
  currentJobId: string | null;
  currentJobName: string | null;
}

/**
 * Upsert a MetricBucket row, replacing all KPI values.
 *
 * Performs a read-before-write check: if an existing row already has
 * identical KPI values, the write is skipped entirely to avoid
 * unnecessary DB round-trips and change notifications. This is
 * especially valuable for the 60s background worker that recomputes
 * duration KPIs and cascades rollups even when nothing has changed.
 *
 * Returns the upserted/existing row (with all fields) for change
 * notification, or null if the row exists with identical values.
 */
async function upsertBucket(input: UpsertInput) {
  const entityName = input.entityName ?? "";
  const path = input.path ?? "";
  const shiftInstanceId = input.shiftInstanceId ?? null;
  const businessDate = input.businessDate ?? null;
  const businessShift = input.businessShift ?? null;
  const currentJobId = input.currentJobId ?? null;
  const currentJobName = input.currentJobName ?? null;

  // Build the KPI data object from additive keys
  const kpiData: Record<string, number | null> = {};
  for (const key of ADDITIVE_KPI_KEYS) {
    kpiData[key] = input.kpis[key];
  }

  // currentStandardCycle: use explicit override if provided, else from kpis
  const stdCycle =
    input.currentStandardCycle !== undefined ? input.currentStandardCycle : input.kpis.currentStandardCycle;
  kpiData.currentStandardCycle = stdCycle;

  // ── Skip-unchanged check ──────────────────────────────────────
  // Read the existing row from both live and archived tables in one
  // round-trip and compare KPI values. If all match, skip the write.
  const existingRows = await prisma.$queryRaw<RawExistingRow[]>`
    SELECT
      'live' AS source,
      "entityName", "path",
      "totalCycles", "badCycles", "totalItems", "badItems",
      "expectedCycles", "expectedItems",
      "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
      "idealCycleSeconds", "totalCycleSeconds",
      "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
      "currentStandardCycle"::double precision AS "currentStandardCycle",
      "currentJobId", "currentJobName"
    FROM "MetricBucket"
    WHERE "entityType" = ${input.entityType}::"BucketEntityType"
      AND "entityId" = ${input.entityId}::uuid
      AND "granularity" = ${input.granularity}::"BucketGranularity"
      AND "startTime" = ${input.startTime}

    UNION ALL

    SELECT
      'archived' AS source,
      "entityName", "path",
      "totalCycles", "badCycles", "totalItems", "badItems",
      "expectedCycles", "expectedItems",
      "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
      "idealCycleSeconds", "totalCycleSeconds",
      "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
      "currentStandardCycle"::double precision AS "currentStandardCycle",
      "currentJobId", "currentJobName"
    FROM "MetricBucketLog"
    WHERE "entityType" = ${input.entityType}::"BucketEntityType"
      AND "entityId" = ${input.entityId}::uuid
      AND "granularity" = ${input.granularity}::"BucketGranularity"
      AND "startTime" = ${input.startTime}
  `;

  // Prefer live row over archived
  const existing = existingRows.find((r) => r.source === "live") ?? null;
  const archivedExisting = existing ? null : (existingRows.find((r) => r.source === "archived") ?? null);
  const compareTarget = existing ?? archivedExisting;

  if (compareTarget) {
    let unchanged = true;
    for (const key of ADDITIVE_KPI_KEYS) {
      if ((compareTarget as unknown as Record<string, unknown>)[key] !== kpiData[key]) {
        unchanged = false;
        break;
      }
    }
    // Also compare currentStandardCycle
    if (unchanged) {
      const existingStdCycle =
        compareTarget.currentStandardCycle != null ? Number(compareTarget.currentStandardCycle) : null;
      if (existingStdCycle !== stdCycle) unchanged = false;
    }
    // Also compare currentJobId/Name
    if (unchanged) {
      if ((compareTarget.currentJobId ?? null) !== currentJobId) unchanged = false;
      if ((compareTarget.currentJobName ?? null) !== currentJobName) unchanged = false;
    }
    // Also compare metadata that might have changed
    if (unchanged && compareTarget.entityName === entityName && compareTarget.path === path) {
      return null; // No change — skip write and change notification
    }
  }

  // If the bucket is archived, update MetricBucketLog instead.
  // Generated columns (OEE, etc.) auto-recompute.
  if (archivedExisting) {
    const rows = await prisma.$queryRaw<RawUpsertRow[]>`
      UPDATE "MetricBucketLog"
      SET
        "entityName" = ${entityName},
        "path" = ${path},
        "shiftInstanceId" = ${shiftInstanceId}::uuid,
        "businessDate" = ${businessDate}::date,
        "businessShift" = ${businessShift},
        "currentJobId" = ${currentJobId}::uuid,
        "currentJobName" = ${currentJobName},
        "totalCycles" = ${kpiData.totalCycles ?? 0}::int,
        "badCycles" = ${kpiData.badCycles ?? 0}::int,
        "totalItems" = ${kpiData.totalItems ?? 0}::int,
        "badItems" = ${kpiData.badItems ?? 0}::int,
        "expectedCycles" = ${kpiData.expectedCycles ?? 0}::int,
        "expectedItems" = ${kpiData.expectedItems ?? 0}::int,
        "runSeconds" = ${kpiData.runSeconds ?? 0}::int,
        "downSeconds" = ${kpiData.downSeconds ?? 0}::int,
        "plannedDownSeconds" = ${kpiData.plannedDownSeconds ?? 0}::int,
        "unplannedDownSeconds" = ${kpiData.unplannedDownSeconds ?? 0}::int,
        "idealCycleSeconds" = ${kpiData.idealCycleSeconds ?? 0}::int,
        "totalCycleSeconds" = ${kpiData.totalCycleSeconds ?? 0}::int,
        "elapsedExpectedCycles" = ${kpiData.elapsedExpectedCycles ?? 0}::int,
        "elapsedExpectedItems" = ${kpiData.elapsedExpectedItems ?? 0}::int,
        "elapsedPlannedProductionSeconds" = ${kpiData.elapsedPlannedProductionSeconds ?? 0}::int,
        "currentStandardCycle" = ${stdCycle}::decimal(10,2),
        "updatedAt" = NOW()
      WHERE "entityType" = ${input.entityType}::"BucketEntityType"
        AND "entityId" = ${input.entityId}::uuid
        AND "granularity" = ${input.granularity}::"BucketGranularity"
        AND "startTime" = ${input.startTime}
      RETURNING *
    `;
    return rows[0] ?? null;
  }

  // Live table: INSERT ON CONFLICT DO UPDATE (upsert)
  const rows = await prisma.$queryRaw<RawUpsertRow[]>`
    INSERT INTO "MetricBucket" (
      "id", "siteId", "entityType", "entityId", "entityName", "path",
      "granularity", "granularityName", "startTime", "durationSeconds",
      "shiftInstanceId", "businessDate", "businessShift",
      "currentJobId", "currentJobName",
      "totalCycles", "badCycles", "totalItems", "badItems",
      "expectedCycles", "expectedItems",
      "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
      "idealCycleSeconds", "totalCycleSeconds",
      "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
      "currentStandardCycle",
      "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid(),
      ${input.siteId}::uuid,
      ${input.entityType}::"BucketEntityType",
      ${input.entityId}::uuid,
      ${entityName},
      ${path},
      ${input.granularity}::"BucketGranularity",
      ${input.granularityName},
      ${input.startTime},
      ${input.durationSeconds}::int,
      ${shiftInstanceId}::uuid,
      ${businessDate}::date,
      ${businessShift},
      ${currentJobId}::uuid,
      ${currentJobName},
      ${kpiData.totalCycles ?? 0}::int,
      ${kpiData.badCycles ?? 0}::int,
      ${kpiData.totalItems ?? 0}::int,
      ${kpiData.badItems ?? 0}::int,
      ${kpiData.expectedCycles ?? 0}::int,
      ${kpiData.expectedItems ?? 0}::int,
      ${kpiData.runSeconds ?? 0}::int,
      ${kpiData.downSeconds ?? 0}::int,
      ${kpiData.plannedDownSeconds ?? 0}::int,
      ${kpiData.unplannedDownSeconds ?? 0}::int,
      ${kpiData.idealCycleSeconds ?? 0}::int,
      ${kpiData.totalCycleSeconds ?? 0}::int,
      ${kpiData.elapsedExpectedCycles ?? 0}::int,
      ${kpiData.elapsedExpectedItems ?? 0}::int,
      ${kpiData.elapsedPlannedProductionSeconds ?? 0}::int,
      ${stdCycle}::decimal(10,2),
      NOW(), NOW()
    )
    ON CONFLICT ("entityType", "entityId", "granularity", "startTime")
    DO UPDATE SET
      "entityName" = EXCLUDED."entityName",
      "path" = EXCLUDED."path",
      "shiftInstanceId" = EXCLUDED."shiftInstanceId",
      "businessDate" = EXCLUDED."businessDate",
      "businessShift" = EXCLUDED."businessShift",
      "currentJobId" = EXCLUDED."currentJobId",
      "currentJobName" = EXCLUDED."currentJobName",
      "totalCycles" = EXCLUDED."totalCycles",
      "badCycles" = EXCLUDED."badCycles",
      "totalItems" = EXCLUDED."totalItems",
      "badItems" = EXCLUDED."badItems",
      "expectedCycles" = EXCLUDED."expectedCycles",
      "expectedItems" = EXCLUDED."expectedItems",
      "runSeconds" = EXCLUDED."runSeconds",
      "downSeconds" = EXCLUDED."downSeconds",
      "plannedDownSeconds" = EXCLUDED."plannedDownSeconds",
      "unplannedDownSeconds" = EXCLUDED."unplannedDownSeconds",
      "idealCycleSeconds" = EXCLUDED."idealCycleSeconds",
      "totalCycleSeconds" = EXCLUDED."totalCycleSeconds",
      "elapsedExpectedCycles" = EXCLUDED."elapsedExpectedCycles",
      "elapsedExpectedItems" = EXCLUDED."elapsedExpectedItems",
      "elapsedPlannedProductionSeconds" = EXCLUDED."elapsedPlannedProductionSeconds",
      "currentStandardCycle" = EXCLUDED."currentStandardCycle",
      "updatedAt" = NOW()
    RETURNING *
  `;
  return rows[0] ?? null;
}

// ── Row → KPI conversion ────────────────────────────────────────

/** Extract KPI values from a MetricBucket DB row. */
function rowToKPIs(row: {
  totalCycles: number;
  badCycles: number;
  totalItems: number;
  badItems: number;
  expectedCycles: number;
  expectedItems: number;
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
  idealCycleSeconds: number;
  totalCycleSeconds: number;
  elapsedExpectedCycles: number;
  elapsedExpectedItems: number;
  elapsedPlannedProductionSeconds: number;
}): BucketKPIs {
  return {
    totalCycles: row.totalCycles,
    badCycles: row.badCycles,
    totalItems: row.totalItems,
    badItems: row.badItems,
    expectedCycles: row.expectedCycles,
    expectedItems: row.expectedItems,
    runSeconds: row.runSeconds,
    downSeconds: row.downSeconds,
    plannedDownSeconds: row.plannedDownSeconds,
    unplannedDownSeconds: row.unplannedDownSeconds,
    idealCycleSeconds: row.idealCycleSeconds,
    totalCycleSeconds: row.totalCycleSeconds,
    elapsedExpectedCycles: row.elapsedExpectedCycles,
    elapsedExpectedItems: row.elapsedExpectedItems,
    elapsedPlannedProductionSeconds: row.elapsedPlannedProductionSeconds,
    currentStandardCycle: null, // Not summed — handled separately
  };
}

// ── Change notification helper ───────────────────────────────────

/**
 * Convert a Prisma MetricBucket row (as returned by upsert) into a
 * BucketChange with a full snapshot of all KPI columns.
 */
function toBucketChange(
  row: Parameters<typeof rowToSnapshot>[0] & {
    siteId: string;
    entityType: EntityType;
    entityId: string;
    entityName: string;
    path: string;
    granularity: Granularity;
    granularityName: string;
    startTime: Date;
    durationSeconds: number;
    shiftInstanceId?: string | null;
    businessDate?: Date | null;
    businessShift?: string | null;
  },
): BucketChange {
  return {
    siteId: row.siteId,
    entityType: row.entityType,
    entityId: row.entityId,
    entityName: row.entityName,
    path: row.path,
    granularity: row.granularity,
    granularityName: row.granularityName,
    startTime: row.startTime,
    durationSeconds: row.durationSeconds,
    shiftInstanceId: row.shiftInstanceId ?? null,
    businessDate: row.businessDate ?? null,
    businessShift: row.businessShift ?? null,
    snapshot: rowToSnapshot(row),
  };
}
