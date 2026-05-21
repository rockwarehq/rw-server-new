// ── Metric bucket archival ───────────────────────────────────────
// Moves completed MetricBucket rows into MetricBucketLog. A bucket
// is complete when its time window has fully elapsed:
//   startTime + durationSeconds <= now  (all UTC)
//
// This keeps the active MetricBucket table small while preserving
// historical data with snapshotted OEE columns.
//
// Called from the 60-second background worker after ensure + recalc.

import prisma from "@rw/db";
import { getSiteTimezone, resolveBusinessDate } from "./bucket.js";
import { computeDurationsForBucket } from "./compute.js";
import { MetricsContext } from "./context.js";
import { rollupBuckets } from "./rollup.js";
import { getShiftForEntity } from "./shift.js";

interface FrozenBucket {
  startTime: Date;
  durationSeconds: number;
}

/**
 * Archive MetricBucket rows whose time window has fully elapsed.
 *
 * For each site, finds buckets where startTime + durationSeconds <= now
 * and moves them to MetricBucketLog.
 *
 * The operation is idempotent: running it multiple times won't create
 * duplicates because MetricBucketLog has the same unique constraint
 * and we use skipDuplicates.
 *
 * @returns Number of rows archived
 */
export async function archiveOldBuckets(ctx?: MetricsContext): Promise<number> {
  const sharedCtx = ctx ?? new MetricsContext();

  // Find all distinct sites that have active metric buckets
  const sites = await prisma.metricBucket.findMany({
    distinct: ["siteId"],
    select: { siteId: true },
  });

  let totalArchived = 0;

  for (const { siteId } of sites) {
    try {
      const archived = await archiveSiteBuckets(siteId, sharedCtx);
      totalArchived += archived;
    } catch (err) {
      console.error(`[metrics:archive] Failed to archive buckets for site ${siteId}:`, err);
    }
  }

  return totalArchived;
}

/**
 * Archive old buckets for a single site.
 *
 * Archives any MetricBucket row whose time window (startTime +
 * durationSeconds) has fully elapsed. All comparisons are in UTC —
 * no timezone logic needed.
 *
 * Before archiving, STATION-entity buckets have their duration KPIs
 * recomputed via computeDurationsForBucket() to capture last-second
 * StationStateLog edits, then rollupBuckets() refreshes the WC/SITE
 * rows in MetricBucket so the archived parent snapshots match the
 * frozen station values. JOB hour buckets are not refreshed here.
 */
async function archiveSiteBuckets(siteId: string, ctx: MetricsContext): Promise<number> {
  const now = new Date();

  // Archive buckets whose time window has fully elapsed (UTC).
  // A bucket is complete when startTime + durationSeconds <= now.
  // We first fetch candidates that started at least 24h ago (to limit
  // the query), then filter precisely by end time.
  const cutoff = new Date(now.getTime() - 86_400_000);
  const candidates = await prisma.metricBucket.findMany({
    where: {
      siteId,
      startTime: { lt: cutoff },
    },
  });

  const nowMs = now.getTime();
  const oldBuckets = candidates.filter((row) => {
    const endMs = row.startTime.getTime() + row.durationSeconds * 1000;
    return endMs <= nowMs;
  });

  if (oldBuckets.length === 0) return 0;

  // ── Freeze STATION buckets with accurate durations ──────────────
  // Before archiving, recompute duration KPIs for STATION-entity
  // buckets using computeDurationsForBucket(). This ensures the
  // archived snapshot has durations accurate to the second rather
  // than stale values from the last periodic recalc.
  const stationBuckets = oldBuckets.filter((row) => row.entityType === "STATION");
  const frozenByStation = new Map<string, FrozenBucket[]>();

  for (const bucket of stationBuckets) {
    try {
      const standardCycle = bucket.currentStandardCycle != null ? Number(bucket.currentStandardCycle) : null;

      const d = await computeDurationsForBucket(
        bucket.entityId,
        bucket.startTime,
        bucket.durationSeconds,
        standardCycle,
        1,
      );

      await prisma.metricBucket.update({
        where: { id: bucket.id },
        data: {
          runSeconds: d.runSeconds,
          downSeconds: d.downSeconds,
          plannedDownSeconds: d.plannedDownSeconds,
          unplannedDownSeconds: d.unplannedDownSeconds,
          elapsedPlannedProductionSeconds: d.elapsedPlannedProductionSeconds,
          expectedCycles: d.expectedCycles,
          expectedItems: d.expectedItems,
          elapsedExpectedCycles: d.elapsedExpectedCycles,
          elapsedExpectedItems: d.elapsedExpectedItems,
        },
      });

      const list = frozenByStation.get(bucket.entityId) ?? [];
      list.push({ startTime: bucket.startTime, durationSeconds: bucket.durationSeconds });
      frozenByStation.set(bucket.entityId, list);
    } catch (err) {
      console.error(
        `[metrics:archive] Failed to freeze durations for STATION bucket ${bucket.id} (entity ${bucket.entityId}):`,
        err,
      );
      // Continue with archiving using the existing (potentially stale) values
    }
  }

  // ── Cascade rollups so WC/SITE rows reflect the frozen station values ──
  // Without this, parent rows in the same archive batch get copied to
  // MetricBucketLog with pre-freeze values and never reconcile.
  if (frozenByStation.size > 0) {
    const timezone = await getSiteTimezone(siteId, ctx);

    for (const [stationId, buckets] of frozenByStation) {
      try {
        const earliest = buckets.reduce((acc, b) => (b.startTime < acc.startTime ? b : acc));
        const shift = await getShiftForEntity("STATION", stationId, siteId, earliest.startTime, ctx);
        const businessDate = await resolveBusinessDate(earliest.startTime, shift?.shiftInstanceId ?? null, timezone);
        const businessShift = shift?.shiftName ?? null;

        await rollupBuckets({
          stationId,
          siteId,
          affectedBuckets: buckets,
          timezone,
          businessDate,
          businessShift,
          ctx,
        });
      } catch (err) {
        console.error(`[metrics:archive] Failed to roll up parents for station ${stationId} pre-archive:`, err);
        // Continue — STATION row is already frozen; parents stay at last-tick values
      }
    }
  }

  // Re-read the rows by ID so logRows carries the freshly-rolled-up parent KPIs
  // alongside the frozen STATION values.
  const archivedIds = oldBuckets.map((row) => row.id);
  const refreshed = await prisma.metricBucket.findMany({
    where: { id: { in: archivedIds } },
  });

  // Copy raw (additive) fields to MetricBucketLog. Generated columns
  // (goodCycles, goodItems, plannedProductionSeconds, availability,
  // performance, quality, oee) auto-compute from the raw fields —
  // we must NOT include them in the insert data.
  const logRows = refreshed.map((row) => ({
    id: row.id,
    siteId: row.siteId,
    entityType: row.entityType,
    entityId: row.entityId,
    entityName: row.entityName,
    path: row.path,
    granularity: row.granularity,
    granularityName: row.granularityName,
    startTime: row.startTime,
    durationSeconds: row.durationSeconds,
    shiftInstanceId: row.shiftInstanceId,
    businessDate: row.businessDate,
    businessShift: row.businessShift,
    totalCycles: row.totalCycles,
    expectedCycles: row.expectedCycles,
    badCycles: row.badCycles,
    totalItems: row.totalItems,
    badItems: row.badItems,
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
    currentStandardCycle: row.currentStandardCycle,
    currentJobId: row.currentJobId,
    currentJobName: row.currentJobName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  // Insert into log table (skipDuplicates for idempotency)
  const { count } = await prisma.metricBucketLog.createMany({
    data: logRows,
    skipDuplicates: true,
  });

  // Delete the archived rows from the active table.
  // Use the exact IDs from the filtered set so we never delete
  // buckets whose time window hasn't elapsed yet (overnight shifts).
  const deleted = await prisma.metricBucket.deleteMany({
    where: { id: { in: archivedIds } },
  });

  if (count > 0 || deleted.count > 0) {
    console.log(`[metrics:archive] Site ${siteId}: archived ${count} rows, deleted ${deleted.count} from active table`);
  }

  return count;
}
