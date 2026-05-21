// ── Recomputation / update entry points ──────────────────────────
// Public API for updating metric buckets. All methods share the
// same computeBucketFromEvents + rollupBuckets pipeline.
//
// updateCountBased             — fast path: atomic increment + duration recompute
// updateDispositionBadItems    — atomic badItems increment + rollup (no KPI recompute)
// updateTimeBased              — recompute duration KPIs for a time range
// recalcAll                    — full recompute (count + duration) for a time range
//
// All methods also handle JOB entity buckets automatically when
// StationJobLog entries overlap the affected time range
// (except updateDispositionBadItems which is count-only).
//
// The granularity of the "base" bucket (HOUR, 5-MINUTE, etc.) is
// determined by the shift/entity configuration. Currently HOUR.
// When finer granularities are added, only getBaseBucketsForRange()
// needs to change — the rest of the pipeline is granularity-agnostic.
//
// All public functions accept an optional MetricsContext for per-pipeline
// caching. When provided, repeated lookups (shifts, hierarchy, etc.)
// are served from the cache instead of hitting the database.

import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import {
  computeBucketFromEvents,
  computeDurationsForBucket,
  DURATION_KPI_KEYS,
  ADDITIVE_KPI_KEYS,
  type DurationKPIs,
  type JobFilter,
} from "./compute.js";
import { rollupBuckets } from "./rollup.js";
import { getIncrementTargets } from "./hierarchy.js";
import { resolveHourBucketForEntity, getShiftForEntity } from "./shift.js";
import { onBucketsChanged, rowToSnapshot, type BucketChange } from "./sync.js";
import { ensureBuckets, getSiteTimezone, resolveBusinessDate } from "./bucket.js";
import { resolveEntityPath, resolveEntityName } from "./hierarchy.js";
import { MetricsContext } from "./context.js";
import { jobEntityId } from "./cascade.js";

// ── Types ────────────────────────────────────────────────────────

interface BucketWindow {
  startTime: Date;
  durationSeconds: number;
}

// ── Bucket range helpers ─────────────────────────────────────────

/**
 * Resolve all base-granularity bucket windows that overlap a time range.
 *
 * Walks from rangeStart to rangeEnd in bucket-sized steps, resolving
 * each bucket independently (the step size depends on the entity's
 * shift configuration at that point in time).
 */
async function getBaseBucketsForRange(
  stationId: string,
  siteId: string,
  startTime: Date,
  endTime: Date,
  timezone: string,
  ctx?: MetricsContext,
): Promise<BucketWindow[]> {
  const buckets: BucketWindow[] = [];
  const seen = new Set<number>(); // startTime ms — dedup guard
  let cursor = new Date(startTime);

  while (cursor < endTime) {
    const bucket = await resolveHourBucketForEntity("STATION", stationId, siteId, cursor, timezone, ctx);
    const startMs = bucket.startTime.getTime();

    if (!seen.has(startMs)) {
      seen.add(startMs);
      buckets.push(bucket);
    }

    // Advance cursor past this bucket
    cursor = new Date(startMs + bucket.durationSeconds * 1000);
  }

  return buckets;
}

/**
 * Resolve the single base-granularity bucket that contains a specific timestamp.
 */
export async function getBaseBucketForTimestamp(
  stationId: string,
  siteId: string,
  timestamp: Date,
  timezone: string,
  ctx?: MetricsContext,
): Promise<BucketWindow> {
  return resolveHourBucketForEntity("STATION", stationId, siteId, timestamp, timezone, ctx);
}

// ── Job log helpers ──────────────────────────────────────────────

/** StationJobLog entry with fields needed for JOB bucket computation. */
interface ActiveJobLog {
  id: string;
  stationId: string;
  jobId: string;
  jobBlobId: string;
  startTime: Date;
  endTime: Date | null;
  standardCycle: number | null;
  /** Number of inventory items produced per cycle for this job. */
  itemsPerCycle: number;
}

/**
 * Query StationJobLog entries that overlap a time range for a station.
 *
 * An entry overlaps if: startTime < rangeEnd AND (endTime > rangeStart OR endTime IS NULL)
 *
 * Also queries active JobProduct quantities to determine itemsPerCycle for each job.
 */
async function getActiveJobLogsForRange(stationId: string, rangeStart: Date, rangeEnd: Date): Promise<ActiveJobLog[]> {
  const logs = await prisma.$queryRaw<
    Array<{
      id: string;
      stationId: string;
      jobId: string;
      jobBlobId: string;
      startTime: Date;
      endTime: Date | null;
      standardCycle: number | null;
    }>
  >`
    SELECT id, "stationId", "jobId", "jobBlobId", "startTime", "endTime",
           "standardCycle"::float8 AS "standardCycle"
    FROM "StationJobLog"
    WHERE "stationId" = ${stationId}
      AND "startTime" < ${rangeEnd}
      AND ("endTime" > ${rangeStart} OR "endTime" IS NULL)
    ORDER BY "startTime" ASC
  `;

  // For each unique jobId, query active JobProduct quantities
  const uniqueJobIds = [...new Set(logs.map((l) => l.jobId))];
  const itemsPerCycleMap = new Map<string, number>();

  for (const jobId of uniqueJobIds) {
    const ipc = await queryItemsPerCycle(jobId);
    itemsPerCycleMap.set(jobId, ipc);
  }

  return logs.map((log) => ({
    ...log,
    standardCycle: log.standardCycle != null ? Number(log.standardCycle) : null,
    itemsPerCycle: itemsPerCycleMap.get(log.jobId) ?? 1,
  }));
}

/**
 * Query the total items-per-cycle for a job by summing active JobProduct quantities.
 *
 * This is queried live (not snapshotted) because products can change while a job runs.
 */
async function queryItemsPerCycle(jobId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: number }>>`
    SELECT COALESCE(SUM(jpb.quantity), 0)::int AS total
    FROM "JobProduct" jp
    JOIN "JobProductBlob" jpb ON jpb.id = jp."currentBlobId"
    WHERE jp."jobId" = ${jobId}
      AND jp."deletedAt" IS NULL
      AND jpb."isActive" = true
  `;

  const total = rows[0]?.total ?? 0;
  return total > 0 ? total : 1;
}

/**
 * Build a JobFilter from an ActiveJobLog for use with computeBucketFromEvents.
 */
function toJobFilter(log: ActiveJobLog): JobFilter {
  return {
    jobId: log.jobId,
    jobBlobId: log.jobBlobId,
    jobLogStartTime: log.startTime,
    jobLogEndTime: log.endTime,
    standardCycle: log.standardCycle,
    itemsPerCycle: log.itemsPerCycle,
  };
}

/**
 * Recompute JOB entity buckets for all active job logs that overlap
 * the given base buckets.
 *
 * For each job log × each base bucket, calls computeBucketFromEvents
 * with the job filter and upserts the JOB entity bucket.
 *
 * Returns the affected JOB bucket windows per jobId for rollup cascading.
 */
async function recomputeJobBucketsForRange(
  stationId: string,
  siteId: string,
  baseBuckets: BucketWindow[],
  timezone: string,
  businessDate: Date | null,
  businessShift: string | null,
  ctx?: MetricsContext,
): Promise<void> {
  if (baseBuckets.length === 0) return;

  // Determine the overall time range covered by the base buckets
  const rangeStart = new Date(Math.min(...baseBuckets.map((b) => b.startTime.getTime())));
  const rangeEnd = new Date(Math.max(...baseBuckets.map((b) => b.startTime.getTime() + b.durationSeconds * 1000)));

  const jobLogs = await getActiveJobLogsForRange(stationId, rangeStart, rangeEnd);
  if (jobLogs.length === 0) return;

  // Resolve the station's path once — all JOB paths are derived from it
  const stationPath = await resolveEntityPath("STATION", stationId, siteId, undefined, ctx);

  // Collect JOB bucket changes for emission
  const jobBucketChanges: BucketChange[] = [];

  // Track affected JOB buckets per jobId for rollup cascading
  const jobAffectedBuckets = new Map<
    string,
    { jobLog: ActiveJobLog; buckets: BucketWindow[]; jobPath: string; jobName: string }
  >();

  for (const jobLog of jobLogs) {
    const jobFilter = toJobFilter(jobLog);
    const affectedForJob: BucketWindow[] = [];

    // Resolve job name and path once per job log (not per bucket)
    const jobName = await resolveEntityName("JOB", jobLog.jobId, undefined, ctx);
    const jobPath = `${stationPath}.job.${jobLog.jobId}`;

    for (const bucket of baseBuckets) {
      // Check if this job log overlaps this bucket
      const bucketEndMs = bucket.startTime.getTime() + bucket.durationSeconds * 1000;
      const jobEndMs = jobLog.endTime ? jobLog.endTime.getTime() : Date.now();

      if (jobLog.startTime.getTime() >= bucketEndMs || jobEndMs <= bucket.startTime.getTime()) {
        continue; // No overlap
      }

      const kpis = await computeBucketFromEvents(stationId, bucket.startTime, bucket.durationSeconds, jobFilter);

      // Resolve the station's shift at this bucket's start to tag the JOB bucket
      const bucketShift = await getShiftForEntity("STATION", stationId, siteId, bucket.startTime, ctx);
      const shiftInstanceId = bucketShift?.shiftInstanceId ?? null;

      // Build KPI data for upsert (all additive keys + currentStandardCycle)
      const kpiData: Record<string, number | null> = {};
      for (const key of ADDITIVE_KPI_KEYS) {
        kpiData[key] = kpis[key];
      }
      kpiData.currentStandardCycle = kpis.currentStandardCycle;

      // Set currentJobId/Name on JOB buckets — the job is known from the job log
      const jobCurrentJobId = jobLog.jobId;
      const jobCurrentJobName = jobName;

      // Skip-unchanged check: read existing JOB bucket and compare
      const compositeId = jobEntityId(stationId, jobLog.jobId);
      const existingJobRows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM "MetricBucket"
        WHERE "entityType" = 'JOB'::"BucketEntityType"
          AND "entityId" = ${compositeId}
          AND granularity = 'HOUR'::"BucketGranularity"
          AND "startTime" = ${bucket.startTime}
        LIMIT 1
      `;
      const existingJob = existingJobRows[0] ?? null;

      if (existingJob && isKpiUnchanged(existingJob, kpiData)) {
        continue; // Skip write — nothing changed
      }

      // Build dynamic SET clause fragments for KPI data
      const kpiSetFragments = Object.entries(kpiData).map(([key, val]) =>
        val != null ? Prisma.sql`"${Prisma.raw(key)}" = ${val}` : Prisma.sql`"${Prisma.raw(key)}" = NULL`,
      );
      const kpiInsertCols = Object.keys(kpiData).map((k) => Prisma.raw(`"${k}"`));
      const kpiInsertVals = Object.values(kpiData).map((v) => (v != null ? Prisma.sql`${v}` : Prisma.sql`NULL`));

      const upsertedRows = await prisma.$queryRaw<
        Array<{
          totalCycles: number;
          goodCycles: number | null;
          badCycles: number;
          totalItems: number;
          goodItems: number | null;
          badItems: number;
          expectedCycles: number;
          expectedItems: number;
          runSeconds: number;
          downSeconds: number;
          plannedDownSeconds: number;
          unplannedDownSeconds: number;
          plannedProductionSeconds: number | null;
          idealCycleSeconds: number;
          totalCycleSeconds: number;
          elapsedExpectedCycles: number;
          elapsedExpectedItems: number;
          elapsedPlannedProductionSeconds: number;
          currentStandardCycle: number | null;
          availability: number | null;
          performance: number | null;
          quality: number | null;
          oee: number | null;
          shiftInstanceId: string | null;
          businessDate: Date | null;
          businessShift: string | null;
          currentJobId: string | null;
          currentJobName: string | null;
        }>
      >`
        INSERT INTO "MetricBucket" (
          id, "siteId", "entityType", "entityId", "entityName", path,
          granularity, "granularityName", "startTime", "durationSeconds",
          "shiftInstanceId", "businessDate", "businessShift",
          "currentJobId", "currentJobName",
          ${Prisma.join(kpiInsertCols)},
          "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid(), ${siteId}, 'JOB'::"BucketEntityType", ${compositeId}, ${jobName}, ${jobPath},
          'HOUR'::"BucketGranularity", 'Hour', ${bucket.startTime}, ${bucket.durationSeconds},
          ${shiftInstanceId}, ${businessDate}, ${businessShift},
          ${jobCurrentJobId}, ${jobCurrentJobName},
          ${Prisma.join(kpiInsertVals)},
          NOW(), NOW()
        )
        ON CONFLICT ("entityType", "entityId", granularity, "startTime")
        DO UPDATE SET
          "entityName" = ${jobName},
          path = ${jobPath},
          "shiftInstanceId" = ${shiftInstanceId},
          "businessDate" = ${businessDate},
          "businessShift" = ${businessShift},
          "currentJobId" = ${jobCurrentJobId},
          "currentJobName" = ${jobCurrentJobName},
          ${Prisma.join(kpiSetFragments)},
          "updatedAt" = NOW()
        RETURNING *
      `;
      const upserted = upsertedRows[0];

      jobBucketChanges.push({
        siteId,
        entityType: "JOB",
        entityId: compositeId,
        entityName: jobName,
        path: jobPath,
        granularity: "HOUR",
        granularityName: "Hour",
        startTime: bucket.startTime,
        durationSeconds: bucket.durationSeconds,
        shiftInstanceId,
        businessDate,
        businessShift,
        snapshot: rowToSnapshot(upserted),
      });

      affectedForJob.push(bucket);
    }

    if (affectedForJob.length > 0) {
      jobAffectedBuckets.set(jobLog.jobId, { jobLog, buckets: affectedForJob, jobPath, jobName });
    }
  }

  // Emit HOUR+JOB bucket changes
  if (jobBucketChanges.length > 0) {
    onBucketsChanged(jobBucketChanges).catch((err) => {
      console.error("[metrics:recalc] Failed to notify JOB bucket changes:", err);
    });
  }

  // Cascade JOB time rollups (HOUR+JOB → SHIFT+JOB, DAY+JOB)
  for (const [, { jobLog, buckets, jobPath, jobName }] of jobAffectedBuckets) {
    await rollupBuckets({
      stationId,
      siteId,
      affectedBuckets: buckets,
      timezone,
      businessDate,
      businessShift,
      jobEntity: {
        jobId: jobLog.jobId,
        jobName,
        jobPath,
      },
      ctx,
    });
  }
}

// ── Cycle increment data ─────────────────────────────────────────

/** Data needed to atomically increment count KPIs for a single cycle. */
export interface CycleIncrement {
  /** Number of inventory items produced by this cycle. */
  itemsCount: number;
  /** Standard cycle time in seconds from the job blob (for idealCycleSeconds). Null if unknown. */
  standardCycleSeconds: number | null;
  /** Number of items produced per cycle for this job (for expectedItems). */
  itemsPerCycle: number;
  /** Actual cycle duration in seconds (start to end). */
  cycleDurationSeconds: number;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Hot path: atomically increment count KPIs on the HOUR+STATION bucket
 * and ensure bucket rows exist. Returns the bucket key so the caller
 * can mark it dirty for deferred rollup processing.
 *
 * This is the minimal work needed on the cycle-completion hot path.
 * Duration recomputation, rollups, and JOB bucket updates are handled
 * separately by {@link processDirtyBuckets}.
 */
export async function incrementCountBased(
  stationId: string,
  siteId: string,
  timestamp: Date,
  increment: CycleIncrement,
  ctx?: MetricsContext,
): Promise<{ stationId: string; siteId: string; bucketStartTime: Date }> {
  const pipelineCtx = ctx ?? new MetricsContext();

  const timezone = await getSiteTimezone(siteId, pipelineCtx);
  const baseBucket = await getBaseBucketForTimestamp(stationId, siteId, timestamp, timezone, pipelineCtx);

  // Ensure bucket rows exist (for hours with zero cycles)
  await ensureBuckets({ siteId, entityType: "STATION", entityId: stationId, timestamp }, pipelineCtx);

  // Atomic increment of count KPIs on HOUR+STATION
  const idealCycleIncrement = increment.standardCycleSeconds != null ? Math.round(increment.standardCycleSeconds) : 0;
  const totalCycleIncrement = Math.round(increment.cycleDurationSeconds);

  await prisma.$executeRaw`
    UPDATE "MetricBucket"
    SET "totalCycles" = "totalCycles" + 1,
        "totalItems" = "totalItems" + ${increment.itemsCount},
        "idealCycleSeconds" = "idealCycleSeconds" + ${idealCycleIncrement},
        "totalCycleSeconds" = "totalCycleSeconds" + ${totalCycleIncrement},
        "updatedAt" = NOW()
    WHERE "entityType" = 'STATION'::"BucketEntityType"
      AND "entityId" = ${stationId}
      AND granularity = 'HOUR'::"BucketGranularity"
      AND "startTime" = ${baseBucket.startTime}
  `;

  return { stationId, siteId, bucketStartTime: baseBucket.startTime };
}

/**
 * Deferred path: recompute duration KPIs, cascade rollups, and
 * recompute JOB buckets for a set of dirty HOUR+STATION buckets.
 *
 * Batches work by site and workcenter to minimize redundant queries:
 * - Station job info and items-per-cycle are fetched in bulk
 * - Station-level rollups (HOUR→SHIFT, HOUR→DAY) run per station
 * - Parent rollups (WORKCENTER, SITE) run once per workcenter group
 *   after all stations in the group are updated
 *
 * All operations are idempotent — they read current DB state and
 * replace (not increment) derived values. Safe to call multiple
 * times or after a delay.
 */
export async function processDirtyBuckets(
  dirtyBuckets: Array<{ stationId: string; siteId: string; bucketStartTime: Date }>,
  ctx?: MetricsContext,
): Promise<void> {
  const pipelineCtx = ctx ?? new MetricsContext();

  if (dirtyBuckets.length === 0) return;

  // ── Step 1: Group dirty buckets by siteId ──────────────────────
  const bySite = new Map<string, Array<{ stationId: string; siteId: string; bucketStartTime: Date }>>();
  for (const bucket of dirtyBuckets) {
    const group = bySite.get(bucket.siteId) ?? [];
    group.push(bucket);
    bySite.set(bucket.siteId, group);
  }

  for (const [siteId, siteBuckets] of bySite) {
    const timezone = await getSiteTimezone(siteId, pipelineCtx);

    // ── Step 2: Batch fetch station info (workcenter, job, standardCycle) ──
    const stationIds = [...new Set(siteBuckets.map((b) => b.stationId))];
    const stationIdSqlArray = stationIds.map((id) => Prisma.sql`${id}::uuid`);

    // ONE query for all station job info in this site batch
    const stationInfoRows = await prisma.$queryRaw<
      Array<{
        stationId: string;
        workcenterId: string | null;
        currentJobId: string | null;
        currentJobName: string | null;
        standardCycle: number | null;
      }>
    >`
      SELECT s.id AS "stationId",
             s."workcenterId",
             s."currentJobId",
             jb.name AS "currentJobName",
             jb."standardCycle"::float8 AS "standardCycle"
      FROM "Station" s
      LEFT JOIN "Job" j ON j.id = s."currentJobId"
      LEFT JOIN "JobBlob" jb ON jb.id = j."currentBlobId"
      WHERE s.id IN (${Prisma.join(stationIdSqlArray)})
    `;
    const stationInfoMap = new Map(stationInfoRows.map((r) => [r.stationId, r]));

    // ONE query for items-per-cycle for all distinct jobIds in this site batch
    const jobIds = [...new Set(stationInfoRows.map((r) => r.currentJobId).filter((id): id is string => id != null))];
    const ipcMap = new Map<string, number>();

    if (jobIds.length > 0) {
      const jobIdSqlArray = jobIds.map((id) => Prisma.sql`${id}::uuid`);
      const ipcRows = await prisma.$queryRaw<Array<{ jobId: string; total: number }>>`
        SELECT jp."jobId", COALESCE(SUM(jpb.quantity), 0)::int AS total
        FROM "JobProduct" jp
        JOIN "JobProductBlob" jpb ON jpb.id = jp."currentBlobId"
        WHERE jp."jobId" IN (${Prisma.join(jobIdSqlArray)})
          AND jp."deletedAt" IS NULL
          AND jpb."isActive" = true
        GROUP BY jp."jobId"
      `;
      for (const row of ipcRows) {
        const total = row.total ?? 0;
        ipcMap.set(row.jobId, total > 0 ? total : 1);
      }
    }

    // ── Step 3: Group stations by workcenter for parent rollup deduplication ──
    const byWorkcenter = new Map<string | null, Set<string>>();
    for (const info of stationInfoRows) {
      const wcId = info.workcenterId ?? null;
      const group = byWorkcenter.get(wcId) ?? new Set();
      group.add(info.stationId);
      byWorkcenter.set(wcId, group);
    }

    // Track which stations+buckets were successfully processed per workcenter,
    // so we can do parent rollups once per group after all stations are done.
    const processedByWorkcenter = new Map<
      string | null,
      Array<{
        stationId: string;
        baseBucket: BucketWindow;
        timezone: string;
        businessDate: Date | null;
        businessShift: string | null;
        stationName: string;
        stationPath: string;
      }>
    >();

    // ── Step 4: Process each station bucket (duration compute + update + station-level rollup) ──
    for (const { stationId, bucketStartTime } of siteBuckets) {
      // Pause between buckets so the station event worker and other
      // consumers can acquire DB connections from the limited pool.
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        const baseBucket = await getBaseBucketForTimestamp(stationId, siteId, bucketStartTime, timezone, pipelineCtx);

        // Pre-resolve hierarchy (used by rollups)
        const targets = await getIncrementTargets(stationId, siteId, pipelineCtx);
        const shift = await getShiftForEntity("STATION", stationId, siteId, bucketStartTime, pipelineCtx);

        const businessDate = await resolveBusinessDate(bucketStartTime, shift?.shiftInstanceId ?? null, timezone);
        const businessShift = shift?.shiftName ?? null;

        // Use batch-fetched station info instead of per-station query
        const stationInfo = stationInfoMap.get(stationId);
        const currentJobId = stationInfo?.currentJobId ?? null;
        const currentJobName = stationInfo?.currentJobName ?? null;
        const standardCycleSeconds = stationInfo?.standardCycle ?? null;

        // Use batch-fetched items-per-cycle
        let itemsPerCycle = 1;
        if (currentJobId) {
          itemsPerCycle = ipcMap.get(currentJobId) ?? 1;
        }

        const durations = await computeDurationsForBucket(
          stationId,
          baseBucket.startTime,
          baseBucket.durationSeconds,
          standardCycleSeconds,
          itemsPerCycle,
        );

        const durationData: Record<string, number | null> = {};
        for (const key of DURATION_KPI_KEYS) {
          durationData[key] = durations[key];
        }
        durationData.expectedCycles = durations.expectedCycles;
        durationData.expectedItems = durations.expectedItems;
        durationData.currentStandardCycle = durations.currentStandardCycle;

        const setFragments = Object.entries(durationData).map(([key, val]) =>
          val != null ? Prisma.sql`"${Prisma.raw(key)}" = ${val}` : Prisma.sql`"${Prisma.raw(key)}" = NULL`,
        );
        setFragments.push(Prisma.sql`"currentJobId" = ${currentJobId}`);
        setFragments.push(Prisma.sql`"currentJobName" = ${currentJobName}`);

        await prisma.$executeRaw`
          UPDATE "MetricBucket"
          SET ${Prisma.join(setFragments)},
              "updatedAt" = NOW()
          WHERE "entityType" = 'STATION'::"BucketEntityType"
            AND "entityId" = ${stationId}
            AND granularity = 'HOUR'::"BucketGranularity"
            AND "startTime" = ${baseBucket.startTime}
        `;

        // Emit changes for real-time consumers
        await emitBaseBucketChanges(siteId, stationId, [baseBucket]);

        // Cascade station-level time rollups only (HOUR→SHIFT, HOUR→DAY).
        // Parent rollups (WORKCENTER, SITE) are deferred to after all
        // stations in the workcenter group are processed.
        // biome-ignore lint/style/noNonNullAssertion: STATION target is always pushed first by buildHierarchyTargets (hierarchy.ts:94)
        const stationTarget = targets.find((t) => t.entityType === "STATION")!;
        await rollupBuckets({
          stationId,
          siteId,
          affectedBuckets: [baseBucket],
          timezone,
          businessDate,
          businessShift,
          stationEntity: {
            stationName: stationTarget.entityName,
            stationPath: stationTarget.path,
          },
          skipParentRollup: true,
          ctx: pipelineCtx,
        });

        // Recompute JOB buckets
        try {
          await recomputeJobBucketsForRange(
            stationId,
            siteId,
            [baseBucket],
            timezone,
            businessDate,
            businessShift,
            pipelineCtx,
          );
        } catch (err) {
          console.error(`[metrics:recalc] Failed to recompute JOB buckets for station ${stationId}:`, err);
        }

        // Track for deferred parent rollup
        const wcId = stationInfo?.workcenterId ?? null;
        const wcGroup = processedByWorkcenter.get(wcId) ?? [];
        wcGroup.push({
          stationId,
          baseBucket,
          timezone,
          businessDate,
          businessShift,
          stationName: stationTarget.entityName,
          stationPath: stationTarget.path,
        });
        processedByWorkcenter.set(wcId, wcGroup);
      } catch (err) {
        console.error(`[metrics:recalc] Failed to process dirty bucket for station ${stationId}:`, err);
      }
    }

    // ── Step 5: Parent rollups — once per workcenter group, once for site ──
    // After all station HOUR+STATION buckets and station-level time rollups
    // are updated, run WORKCENTER and SITE entity rollups once per group.
    // We pick the last successfully processed station in each group as the
    // "representative" station and call rollupBuckets with skipParentRollup=false.
    // Since the entity rollups are idempotent sums over all child stations,
    // it doesn't matter which station triggers them — the result is the same.
    for (const [, wcStations] of processedByWorkcenter) {
      if (wcStations.length === 0) continue;

      // Use the last processed station as the representative for parent rollups
      const representative = wcStations[wcStations.length - 1];
      try {
        await rollupBuckets({
          stationId: representative.stationId,
          siteId,
          affectedBuckets: [representative.baseBucket],
          timezone: representative.timezone,
          businessDate: representative.businessDate,
          businessShift: representative.businessShift,
          stationEntity: {
            stationName: representative.stationName,
            stationPath: representative.stationPath,
          },
          skipParentRollup: false,
          ctx: pipelineCtx,
        });
      } catch (err) {
        console.error(
          `[metrics:recalc] Failed parent rollup for workcenter group (station ${representative.stationId}):`,
          err,
        );
      }
    }
  }
}

/**
 * Full synchronous path for forward-flowing cycle events.
 *
 * 1. Atomically increments count KPIs on the HOUR+STATION bucket
 * 2. Recomputes duration KPIs from state logs (no cycle re-query)
 * 3. Cascades rollups to SHIFT, DAY, WORKCENTER, SITE
 * 4. Recomputes JOB buckets for active job logs at this timestamp
 *
 * Count KPIs (totalCycles, totalItems, idealCycleSeconds, totalCycleSeconds)
 * are incremented atomically — avoiding re-querying all cycles each time.
 * Duration KPIs are recomputed from state logs via computeDurationsForBucket.
 * WORKCENTER/SITE/SHIFT buckets are derived entirely by rollup.
 *
 * Called from: cycle.ts on every cycle complete (via batcher)
 *
 * @param stationId - Station that recorded the cycle
 * @param siteId - Site the station belongs to
 * @param timestamp - When the cycle completed (cycle.end)
 * @param increment - Count data for the single cycle just completed
 * @param ctx - Optional per-pipeline cache (created automatically if omitted)
 */
export async function updateCountBased(
  stationId: string,
  siteId: string,
  timestamp: Date,
  increment: CycleIncrement,
  ctx?: MetricsContext,
): Promise<void> {
  // Create a shared context for the entire pipeline if not provided
  const pipelineCtx = ctx ?? new MetricsContext();

  const timezone = await getSiteTimezone(siteId, pipelineCtx);
  const baseBucket = await getBaseBucketForTimestamp(stationId, siteId, timestamp, timezone, pipelineCtx);

  // Ensure bucket rows exist (for hours with zero cycles)
  await ensureBuckets({ siteId, entityType: "STATION", entityId: stationId, timestamp }, pipelineCtx);

  // ── Pre-resolve hierarchy (used by rollups) ──
  const targets = await getIncrementTargets(stationId, siteId, pipelineCtx);

  const shift = await getShiftForEntity("STATION", stationId, siteId, timestamp, pipelineCtx);

  // Resolve business date and shift name for all buckets in this pipeline
  const businessDate = await resolveBusinessDate(timestamp, shift?.shiftInstanceId ?? null, timezone);
  const businessShift = shift?.shiftName ?? null;

  // Resolve current job for the station
  const stationJobRows2 = await prisma.$queryRaw<
    Array<{
      currentJobId: string | null;
      currentJobName: string | null;
    }>
  >`
    SELECT s."currentJobId",
           jb.name AS "currentJobName"
    FROM "Station" s
    LEFT JOIN "Job" j ON j.id = s."currentJobId"
    LEFT JOIN "JobBlob" jb ON jb.id = j."currentBlobId"
    WHERE s.id = ${stationId}
  `;
  const currentJobId = stationJobRows2[0]?.currentJobId ?? null;
  const currentJobName = stationJobRows2[0]?.currentJobName ?? null;

  // ── Step 1a: Atomic increment of count KPIs on HOUR+STATION ──
  // Only count KPIs are incremented (totalCycles, totalItems,
  // idealCycleSeconds, totalCycleSeconds). Since goodCycles/goodItems
  // are DB-generated columns (totalCycles - badCycles, totalItems -
  // badItems), they stay consistent automatically.
  const idealCycleIncrement = increment.standardCycleSeconds != null ? Math.round(increment.standardCycleSeconds) : 0;
  const totalCycleIncrement = Math.round(increment.cycleDurationSeconds);

  await prisma.$executeRaw`
    UPDATE "MetricBucket"
    SET "totalCycles" = "totalCycles" + 1,
        "totalItems" = "totalItems" + ${increment.itemsCount},
        "idealCycleSeconds" = "idealCycleSeconds" + ${idealCycleIncrement},
        "totalCycleSeconds" = "totalCycleSeconds" + ${totalCycleIncrement},
        "updatedAt" = NOW()
    WHERE "entityType" = 'STATION'::"BucketEntityType"
      AND "entityId" = ${stationId}
      AND granularity = 'HOUR'::"BucketGranularity"
      AND "startTime" = ${baseBucket.startTime}
  `;

  // ── Step 1b: Recompute duration KPIs from state logs ──────────
  // Duration KPIs (runSeconds, downSeconds, etc.) and derived expected
  // cycle/item counts are recomputed from StationStateLog entries.
  // This avoids re-querying all cycles — count KPIs were already
  // handled by the atomic increment above.
  const durations = await computeDurationsForBucket(
    stationId,
    baseBucket.startTime,
    baseBucket.durationSeconds,
    increment.standardCycleSeconds,
    increment.itemsPerCycle,
  );

  const durationData: Record<string, number | null> = {};
  for (const key of DURATION_KPI_KEYS) {
    durationData[key] = durations[key];
  }
  durationData.expectedCycles = durations.expectedCycles;
  durationData.expectedItems = durations.expectedItems;
  durationData.currentStandardCycle = durations.currentStandardCycle;

  const setFragments2 = Object.entries(durationData).map(([key, val]) =>
    val != null ? Prisma.sql`"${Prisma.raw(key)}" = ${val}` : Prisma.sql`"${Prisma.raw(key)}" = NULL`,
  );
  setFragments2.push(Prisma.sql`"currentJobId" = ${currentJobId}`);
  setFragments2.push(Prisma.sql`"currentJobName" = ${currentJobName}`);

  await prisma.$executeRaw`
    UPDATE "MetricBucket"
    SET ${Prisma.join(setFragments2)},
        "updatedAt" = NOW()
    WHERE "entityType" = 'STATION'::"BucketEntityType"
      AND "entityId" = ${stationId}
      AND granularity = 'HOUR'::"BucketGranularity"
      AND "startTime" = ${baseBucket.startTime}
  `;

  // Read back the HOUR+STATION bucket to get full state (including DB-generated OEE columns)
  // and emit a complete snapshot for real-time consumers.
  await emitBaseBucketChanges(siteId, stationId, [baseBucket]);

  // ── Step 2: Cascade rollups (SHIFT, DAY, WORKCENTER, SITE) ───
  // Pass pre-resolved station entity info to avoid re-querying hierarchy
  // biome-ignore lint/style/noNonNullAssertion: STATION target is always pushed first by buildHierarchyTargets (hierarchy.ts:94)
  const stationTarget = targets.find((t) => t.entityType === "STATION")!;
  await rollupBuckets({
    stationId,
    siteId,
    affectedBuckets: [baseBucket],
    timezone,
    businessDate,
    businessShift,
    stationEntity: {
      stationName: stationTarget.entityName,
      stationPath: stationTarget.path,
    },
    ctx: pipelineCtx,
  });

  // ── Step 3: Recompute JOB buckets for active job logs ─────────
  // Isolated so that a failure in JOB bucket computation doesn't
  // prevent the (already-committed) STATION/WC/SITE updates from
  // being visible. Errors are logged but do not propagate.
  try {
    await recomputeJobBucketsForRange(
      stationId,
      siteId,
      [baseBucket],
      timezone,
      businessDate,
      businessShift,
      pipelineCtx,
    );
  } catch (err) {
    console.error(`[metrics:recalc] Failed to recompute JOB buckets for station ${stationId}:`, err);
  }
}

// ── Disposition bad-items increment ──────────────────────────────

/**
 * Atomically increment `badItems` on the HOUR+STATION bucket for a
 * given timestamp, then cascade rollups to SHIFT/DAY/WORKCENTER/SITE.
 *
 * This is the lightweight fast path for ItemDispositionLog creation.
 * No duration or count KPI recomputation is performed — only the
 * `badItems` field is incremented. The DB-generated columns
 * (goodItems, quality, oee) update automatically.
 *
 * Called from: disposition log creation service (fire-and-forget).
 *
 * @param stationId - Station the disposition is attributed to
 * @param siteId - Site the station belongs to
 * @param timestamp - The log's createdAt — determines which HOUR bucket
 * @param quantity - The ItemDispositionLog.quantity to add
 * @param ctx - Optional per-pipeline cache
 */
export async function updateDispositionBadItems(
  stationId: string,
  siteId: string,
  timestamp: Date,
  quantity: number,
  ctx?: MetricsContext,
): Promise<void> {
  const pipelineCtx = ctx ?? new MetricsContext();

  const timezone = await getSiteTimezone(siteId, pipelineCtx);
  const baseBucket = await getBaseBucketForTimestamp(stationId, siteId, timestamp, timezone, pipelineCtx);

  // Ensure bucket rows exist
  await ensureBuckets({ siteId, entityType: "STATION", entityId: stationId, timestamp }, pipelineCtx);

  // ── Pre-resolve hierarchy (used by rollups) ──
  const targets = await getIncrementTargets(stationId, siteId, pipelineCtx);

  const shift = await getShiftForEntity("STATION", stationId, siteId, timestamp, pipelineCtx);
  const businessDate = await resolveBusinessDate(timestamp, shift?.shiftInstanceId ?? null, timezone);
  const businessShift = shift?.shiftName ?? null;

  // ── Step 1: Atomic increment of badItems on HOUR+STATION ──
  const liveCount = await prisma.$executeRaw`
    UPDATE "MetricBucket"
    SET "badItems" = "badItems" + ${quantity},
        "updatedAt" = NOW()
    WHERE "entityType" = 'STATION'::"BucketEntityType"
      AND "entityId" = ${stationId}
      AND granularity = 'HOUR'::"BucketGranularity"
      AND "startTime" = ${baseBucket.startTime}
  `;
  if (liveCount === 0) {
    // Bucket was archived — update MetricBucketLog instead.
    // Generated columns (quality, oee) auto-recompute.
    await prisma.$executeRaw`
      UPDATE "MetricBucketLog"
      SET "badItems" = "badItems" + ${quantity},
          "updatedAt" = NOW()
      WHERE "entityType" = 'STATION'::"BucketEntityType"
        AND "entityId" = ${stationId}
        AND granularity = 'HOUR'::"BucketGranularity"
        AND "startTime" = ${baseBucket.startTime}
    `;
  }

  // Read back and emit full snapshot (including DB-generated quality/oee)
  await emitBaseBucketChanges(siteId, stationId, [baseBucket]);

  // ── Step 2: Cascade rollups (SHIFT, DAY, WORKCENTER, SITE) ───
  // biome-ignore lint/style/noNonNullAssertion: STATION target is always pushed first by buildHierarchyTargets (hierarchy.ts:94)
  const stationTarget = targets.find((t) => t.entityType === "STATION")!;
  await rollupBuckets({
    stationId,
    siteId,
    affectedBuckets: [baseBucket],
    timezone,
    businessDate,
    businessShift,
    stationEntity: {
      stationName: stationTarget.entityName,
      stationPath: stationTarget.path,
    },
    ctx: pipelineCtx,
  });
}

// ── Duration recomputation ──────────────────────────────────────

/**
 * Recompute duration-based KPIs for a station over a time range.
 *
 * Determines which base buckets overlap the range, recomputes each
 * from StationStateLog events (no cycle re-query), and cascades rollups.
 *
 * Also recomputes JOB buckets for any active job logs in the range.
 *
 * Called from: state transitions (DOWN->UP, UP->DOWN), downtime
 * reason assignment, and the 60s background worker heartbeat.
 *
 * @param stationId - Station whose state changed
 * @param siteId - Site the station belongs to
 * @param startTime - Start of the affected range
 * @param endTime - End of the affected range
 * @param standardCycleSeconds - Standard cycle time for expected cycle calc.
 *        When not provided, falls back to the bucket's currentStandardCycle.
 * @param itemsPerCycle - Items per cycle for expected items calc.
 *        When not provided, falls back to the bucket's totalItems/totalCycles ratio.
 * @param ctx - Optional per-pipeline cache
 */
export async function updateTimeBased(
  stationId: string,
  siteId: string,
  startTime: Date,
  endTime: Date,
  standardCycleSeconds?: number | null,
  itemsPerCycle?: number,
  ctx?: MetricsContext,
): Promise<void> {
  const pipelineCtx = ctx ?? new MetricsContext();

  const timezone = await getSiteTimezone(siteId, pipelineCtx);
  const baseBuckets = await getBaseBucketsForRange(stationId, siteId, startTime, endTime, timezone, pipelineCtx);
  console.log(
    `[updateTimeBased] station=${stationId} baseBuckets=${baseBuckets.length} range=${startTime.toISOString()}..${endTime.toISOString()}`,
  );

  // Ensure bucket rows exist — but only when the buckets haven't been
  // archived yet. If rows already exist in MetricBucketLog, creating
  // new empty rows in MetricBucket would shadow the archived data
  // (the rollup merge prefers live rows, losing count KPIs).
  const archivedExistsRows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "MetricBucketLog"
    WHERE "entityType" = 'STATION'::"BucketEntityType"
      AND "entityId" = ${stationId}
      AND granularity = 'HOUR'::"BucketGranularity"
      AND "startTime" >= ${baseBuckets[0]?.startTime ?? startTime}
    LIMIT 1
  `;
  const archivedExists = archivedExistsRows[0] ?? null;
  console.log(`[updateTimeBased] archivedExists=${!!archivedExists}`);
  if (!archivedExists) {
    await ensureBuckets({ siteId, entityType: "STATION", entityId: stationId, timestamp: startTime }, pipelineCtx);
  }

  // Resolve business date for the affected range
  const shift = await getShiftForEntity("STATION", stationId, siteId, startTime, pipelineCtx);
  const businessDate = await resolveBusinessDate(startTime, shift?.shiftInstanceId ?? null, timezone);
  const businessShift = shift?.shiftName ?? null;

  // Resolve current job for the station
  const stationJobRows3 = await prisma.$queryRaw<
    Array<{
      currentJobId: string | null;
      currentJobName: string | null;
    }>
  >`
    SELECT s."currentJobId",
           jb.name AS "currentJobName"
    FROM "Station" s
    LEFT JOIN "Job" j ON j.id = s."currentJobId"
    LEFT JOIN "JobBlob" jb ON jb.id = j."currentBlobId"
    WHERE s.id = ${stationId}
  `;
  const currentJobId = stationJobRows3[0]?.currentJobId ?? null;
  const currentJobName = stationJobRows3[0]?.currentJobName ?? null;

  // Recompute duration KPIs for each affected base bucket.
  // Uses computeDurationsForBucket which only queries state logs —
  // count KPIs (totalCycles, totalItems, etc.) are not touched.
  // Skip writes when the computed values haven't changed (common when
  // the background worker re-ticks without any new state events).
  const changedBuckets: BucketWindow[] = [];
  for (const bucket of baseBuckets) {
    // Resolve standardCycle and itemsPerCycle for this bucket.
    // When not provided by the caller, fall back to the existing
    // bucket's values (set by the most recent updateCountBased call).
    let stdCycle = standardCycleSeconds ?? null;
    let ipc = itemsPerCycle ?? 1;
    if (stdCycle == null || itemsPerCycle == null) {
      const existingRows = await prisma.$queryRaw<
        Array<{
          currentStandardCycle: number | null;
          totalCycles: number;
          totalItems: number;
        }>
      >`
        (
          SELECT "currentStandardCycle"::float8 AS "currentStandardCycle",
                 "totalCycles", "totalItems"
          FROM "MetricBucket"
          WHERE "entityType" = 'STATION'::"BucketEntityType"
            AND "entityId" = ${stationId}
            AND granularity = 'HOUR'::"BucketGranularity"
            AND "startTime" = ${bucket.startTime}
          LIMIT 1
        )
        UNION ALL
        (
          SELECT "currentStandardCycle"::float8 AS "currentStandardCycle",
                 "totalCycles", "totalItems"
          FROM "MetricBucketLog"
          WHERE "entityType" = 'STATION'::"BucketEntityType"
            AND "entityId" = ${stationId}
            AND granularity = 'HOUR'::"BucketGranularity"
            AND "startTime" = ${bucket.startTime}
          LIMIT 1
        )
        LIMIT 1
      `;
      const existing = existingRows[0] ?? null;
      if (existing) {
        if (stdCycle == null && existing.currentStandardCycle != null) {
          stdCycle = Number(existing.currentStandardCycle);
        }
        if (itemsPerCycle == null && existing.totalCycles > 0) {
          ipc = Math.round(existing.totalItems / existing.totalCycles);
        }
      }
    }

    const durations = await computeDurationsForBucket(
      stationId,
      bucket.startTime,
      bucket.durationSeconds,
      stdCycle,
      ipc,
    );
    const durationData = extractDurationKPIs(durations);

    // Read existing row and compare before writing.
    // Check MetricBucketLog FIRST — if the bucket was archived, the
    // authoritative row with count KPIs lives there. Updating (or even
    // having) a MetricBucket row for an archived bucket causes the
    // rollup merge to prefer the live row's zero counts, corrupting OEE.
    const updateData = { ...durationData, currentJobId, currentJobName };

    const archivedRows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "MetricBucketLog"
      WHERE "entityType" = 'STATION'::"BucketEntityType"
        AND "entityId" = ${stationId}
        AND granularity = 'HOUR'::"BucketGranularity"
        AND "startTime" = ${bucket.startTime}
      LIMIT 1
    `;
    const archivedRow = archivedRows[0] ?? null;

    const liveRows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "MetricBucket"
      WHERE "entityType" = 'STATION'::"BucketEntityType"
        AND "entityId" = ${stationId}
        AND granularity = 'HOUR'::"BucketGranularity"
        AND "startTime" = ${bucket.startTime}
      LIMIT 1
    `;
    const liveRow = liveRows[0] ?? null;

    console.log(
      `[updateTimeBased] bucket ${bucket.startTime.toISOString()} archived=${!!archivedRow} live=${!!liveRow} durations: planned=${durationData.plannedDownSeconds} unplanned=${durationData.unplannedDownSeconds} elapsed=${durationData.elapsedPlannedProductionSeconds} run=${durationData.runSeconds}`,
    );

    // Build dynamic SET clause for updateData
    const updateFragments = Object.entries(updateData).map(([key, val]) =>
      val != null ? Prisma.sql`"${Prisma.raw(key)}" = ${val}` : Prisma.sql`"${Prisma.raw(key)}" = NULL`,
    );

    if (archivedRow) {
      if (isDurationUnchanged(archivedRow, durationData)) {
        console.log(`[updateTimeBased]   archived row unchanged — skipping`);
        continue;
      }
      console.log(
        `[updateTimeBased]   archived row CHANGED — updating MetricBucketLog, old: planned=${archivedRow.plannedDownSeconds} unplanned=${archivedRow.unplannedDownSeconds} elapsed=${archivedRow.elapsedPlannedProductionSeconds}`,
      );
      await prisma.$executeRaw`
        UPDATE "MetricBucketLog"
        SET ${Prisma.join(updateFragments)},
            "updatedAt" = NOW()
        WHERE "entityType" = 'STATION'::"BucketEntityType"
          AND "entityId" = ${stationId}
          AND granularity = 'HOUR'::"BucketGranularity"
          AND "startTime" = ${bucket.startTime}
      `;
      // Remove any phantom live rows so they can't shadow archived data in rollups
      if (liveRow) {
        console.log(`[updateTimeBased]   deleting phantom live row`);
        await prisma.$executeRaw`
          DELETE FROM "MetricBucket"
          WHERE "entityType" = 'STATION'::"BucketEntityType"
            AND "entityId" = ${stationId}
            AND granularity = 'HOUR'::"BucketGranularity"
            AND "startTime" = ${bucket.startTime}
        `;
      }
    } else if (liveRow) {
      if (isDurationUnchanged(liveRow, durationData)) {
        console.log(`[updateTimeBased]   live row unchanged — skipping`);
        continue;
      }
      console.log(`[updateTimeBased]   live row CHANGED — updating MetricBucket`);
      await prisma.$executeRaw`
        UPDATE "MetricBucket"
        SET ${Prisma.join(updateFragments)},
            "updatedAt" = NOW()
        WHERE "entityType" = 'STATION'::"BucketEntityType"
          AND "entityId" = ${stationId}
          AND granularity = 'HOUR'::"BucketGranularity"
          AND "startTime" = ${bucket.startTime}
      `;
    } else {
      console.log(`[updateTimeBased]   no row in either table — skipping`);
      continue;
    }
    changedBuckets.push(bucket);
  }

  // Only emit and cascade if something actually changed
  console.log(`[updateTimeBased] changedBuckets=${changedBuckets.length}`);
  if (changedBuckets.length === 0) {
    console.log(`[updateTimeBased] no changes — skipping rollup`);
    return;
  }
  console.log(`[updateTimeBased] cascading rollup...`);

  // Emit full snapshot for all changed HOUR+STATION buckets
  await emitBaseBucketChanges(siteId, stationId, changedBuckets);

  // Cascade rollups (only for changed buckets)
  await rollupBuckets({
    stationId,
    siteId,
    affectedBuckets: changedBuckets,
    timezone,
    businessDate,
    businessShift,
    ctx: pipelineCtx,
  });
  console.log(`[updateTimeBased] rollup complete`);

  // Recompute JOB buckets for active job logs in the range
  try {
    await recomputeJobBucketsForRange(
      stationId,
      siteId,
      baseBuckets,
      timezone,
      businessDate,
      businessShift,
      pipelineCtx,
    );
  } catch (err) {
    console.error(`[metrics:recalc] Failed to recompute JOB buckets for station ${stationId}:`, err);
  }
}

/**
 * Full recomputation of all KPIs for a station over a time range.
 *
 * Replaces both count-based and duration-based KPIs on every affected
 * base bucket by querying raw Cycle and StationStateLog events. Then
 * cascades rollups to all higher granularities and entity levels.
 *
 * Also recomputes JOB buckets for any active job logs in the range.
 *
 * This is the "nuclear" per-station option — use it when the raw events
 * themselves have changed (downtime split, job change, backfill, etc.).
 *
 * The station's parent workcenters and site are automatically updated
 * via the rollup cascade.
 *
 * @param stationId - Station to recompute
 * @param siteId - Site the station belongs to
 * @param startTime - Start of the range to recompute
 * @param endTime - End of the range to recompute
 * @param ctx - Optional per-pipeline cache
 */
export async function recalcAll(
  stationId: string,
  siteId: string,
  startTime: Date,
  endTime: Date,
  ctx?: MetricsContext,
): Promise<void> {
  const pipelineCtx = ctx ?? new MetricsContext();

  const timezone = await getSiteTimezone(siteId, pipelineCtx);
  const baseBuckets = await getBaseBucketsForRange(stationId, siteId, startTime, endTime, timezone, pipelineCtx);

  // Resolve business date for the affected range
  const shift = await getShiftForEntity("STATION", stationId, siteId, startTime, pipelineCtx);
  const businessDate = await resolveBusinessDate(startTime, shift?.shiftInstanceId ?? null, timezone);
  const businessShift = shift?.shiftName ?? null;

  // Resolve current job for the station
  const stationJobRows4 = await prisma.$queryRaw<
    Array<{
      currentJobId: string | null;
      currentJobName: string | null;
    }>
  >`
    SELECT s."currentJobId",
           jb.name AS "currentJobName"
    FROM "Station" s
    LEFT JOIN "Job" j ON j.id = s."currentJobId"
    LEFT JOIN "JobBlob" jb ON jb.id = j."currentBlobId"
    WHERE s.id = ${stationId}
  `;
  const currentJobId = stationJobRows4[0]?.currentJobId ?? null;
  const currentJobName = stationJobRows4[0]?.currentJobName ?? null;

  console.log(
    `[metrics:recalc] recalcAll for station ${stationId}: ${baseBuckets.length} base buckets ` +
      `from ${startTime.toISOString()} to ${endTime.toISOString()}`,
  );

  // Recompute ALL KPIs for each affected base bucket
  for (const bucket of baseBuckets) {
    const kpis = await computeBucketFromEvents(stationId, bucket.startTime, bucket.durationSeconds);

    // Build full KPI data including currentStandardCycle
    const kpiData: Record<string, number | null> = {};
    for (const key of ADDITIVE_KPI_KEYS) {
      kpiData[key] = kpis[key];
    }
    kpiData.currentStandardCycle = kpis.currentStandardCycle;

    // Replace all KPIs (both count and duration)
    const kpiSetFragments = Object.entries(kpiData).map(([key, val]) =>
      val != null ? Prisma.sql`"${Prisma.raw(key)}" = ${val}` : Prisma.sql`"${Prisma.raw(key)}" = NULL`,
    );
    kpiSetFragments.push(Prisma.sql`"currentJobId" = ${currentJobId}`);
    kpiSetFragments.push(Prisma.sql`"currentJobName" = ${currentJobName}`);

    await prisma.$executeRaw`
      UPDATE "MetricBucket"
      SET ${Prisma.join(kpiSetFragments)},
          "updatedAt" = NOW()
      WHERE "entityType" = 'STATION'::"BucketEntityType"
        AND "entityId" = ${stationId}
        AND granularity = 'HOUR'::"BucketGranularity"
        AND "startTime" = ${bucket.startTime}
    `;
  }

  // Emit full snapshot for all affected HOUR+STATION buckets
  await emitBaseBucketChanges(siteId, stationId, baseBuckets);

  // Cascade rollups
  await rollupBuckets({
    stationId,
    siteId,
    affectedBuckets: baseBuckets,
    timezone,
    businessDate,
    businessShift,
    ctx: pipelineCtx,
  });

  // Recompute JOB buckets for active job logs in the range
  try {
    await recomputeJobBucketsForRange(
      stationId,
      siteId,
      baseBuckets,
      timezone,
      businessDate,
      businessShift,
      pipelineCtx,
    );
  } catch (err) {
    console.error(`[metrics:recalc] Failed to recompute JOB buckets for station ${stationId}:`, err);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Extract duration-based KPI fields plus expected cycles/items and
 * currentStandardCycle for a Prisma update.
 *
 * Accepts BucketKPIs or the return type of computeDurationsForBucket.
 */
function extractDurationKPIs(
  kpis: DurationKPIs & {
    expectedCycles: number;
    expectedItems: number;
    currentStandardCycle: number | null;
  },
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const key of DURATION_KPI_KEYS) {
    result[key] = kpis[key];
  }
  result.expectedCycles = kpis.expectedCycles;
  result.expectedItems = kpis.expectedItems;
  result.currentStandardCycle = kpis.currentStandardCycle;
  return result;
}

/**
 * Check if a MetricBucket row's duration KPIs already match the new values.
 * Used to skip unnecessary writes in updateTimeBased.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isDurationUnchanged(existing: any, newData: Record<string, number | null>): boolean {
  for (const key of DURATION_KPI_KEYS) {
    if (existing[key] !== newData[key]) return false;
  }
  // Also compare expectedCycles, expectedItems, currentStandardCycle
  if (existing.expectedCycles !== newData.expectedCycles) return false;
  if (existing.expectedItems !== newData.expectedItems) return false;
  const existingStdCycle = existing.currentStandardCycle != null ? Number(existing.currentStandardCycle) : null;
  if (existingStdCycle !== newData.currentStandardCycle) return false;
  return true;
}

/**
 * Check if a MetricBucket row's KPIs (additive + currentStandardCycle)
 * already match the new values. Used to skip unnecessary JOB bucket writes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isKpiUnchanged(existing: any, newData: Record<string, number | null>): boolean {
  for (const key of ADDITIVE_KPI_KEYS) {
    if (existing[key] !== newData[key]) return false;
  }
  const existingStdCycle = existing.currentStandardCycle != null ? Number(existing.currentStandardCycle) : null;
  if (existingStdCycle !== newData.currentStandardCycle) return false;
  return true;
}

/**
 * Read back HOUR+STATION buckets after a write and emit full snapshots.
 *
 * After updateMany (which doesn't return rows), we need a findMany
 * to get the complete row including DB-generated columns (availability,
 * performance, quality, oee).
 */
export async function emitBaseBucketChanges(
  siteId: string,
  stationId: string,
  baseBuckets: BucketWindow[],
): Promise<void> {
  if (baseBuckets.length === 0) return;

  const startTimes = baseBuckets.map((b) => b.startTime);

  const rows = await prisma.$queryRaw<
    Array<{
      entityType: string;
      entityId: string;
      entityName: string;
      path: string;
      granularity: string;
      granularityName: string;
      startTime: Date;
      durationSeconds: number;
      shiftInstanceId: string | null;
      businessDate: Date | null;
      businessShift: string | null;
      totalCycles: number;
      goodCycles: number | null;
      badCycles: number;
      totalItems: number;
      goodItems: number | null;
      badItems: number;
      expectedCycles: number;
      expectedItems: number;
      runSeconds: number;
      downSeconds: number;
      plannedDownSeconds: number;
      unplannedDownSeconds: number;
      plannedProductionSeconds: number | null;
      idealCycleSeconds: number;
      totalCycleSeconds: number;
      elapsedExpectedCycles: number;
      elapsedExpectedItems: number;
      elapsedPlannedProductionSeconds: number;
      currentStandardCycle: number | null;
      availability: number | null;
      performance: number | null;
      quality: number | null;
      oee: number | null;
      currentJobId: string | null;
      currentJobName: string | null;
    }>
  >`
    SELECT "entityType", "entityId", "entityName", path,
           granularity, "granularityName", "startTime", "durationSeconds",
           "shiftInstanceId", "businessDate", "businessShift",
           "totalCycles", "goodCycles", "badCycles",
           "totalItems", "goodItems", "badItems",
           "expectedCycles", "expectedItems",
           "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
           "plannedProductionSeconds",
           "idealCycleSeconds", "totalCycleSeconds",
           "elapsedExpectedCycles", "elapsedExpectedItems",
           "elapsedPlannedProductionSeconds",
           "currentStandardCycle"::float8 AS "currentStandardCycle",
           availability::float8 AS availability,
           performance::float8 AS performance,
           quality::float8 AS quality,
           oee::float8 AS oee,
           "currentJobId", "currentJobName"
    FROM "MetricBucket"
    WHERE "entityType" = 'STATION'::"BucketEntityType"
      AND "entityId" = ${stationId}
      AND granularity = 'HOUR'::"BucketGranularity"
      AND "startTime" IN (${Prisma.join(startTimes)})
  `;

  if (rows.length === 0) return;

  const changes: BucketChange[] = rows.map((row) => ({
    siteId,
    entityType: "STATION",
    entityId: row.entityId,
    entityName: row.entityName,
    path: row.path,
    granularity: "HOUR",
    granularityName: row.granularityName,
    startTime: row.startTime,
    durationSeconds: row.durationSeconds,
    shiftInstanceId: row.shiftInstanceId ?? null,
    businessDate: row.businessDate ?? null,
    businessShift: row.businessShift ?? null,
    snapshot: rowToSnapshot(row),
  }));

  onBucketsChanged(changes).catch((err) => {
    console.error("[metrics:recalc] Failed to notify base bucket changes:", err);
  });
}
