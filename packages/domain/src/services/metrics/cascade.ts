// ── CTE-based metric cascades ────────────────────────────────────
// Single-roundtrip SQL statements that update metric buckets.
// No PL/pgSQL functions — everything is a CTE chain via prisma.$queryRaw.
//
// Batch rollups (called from 5s combined tick in worker process):
//   batchCountRollup        — recompute count KPIs from Cycle table for all active stations
//   batchDurationRollup     — compute duration KPIs from StationStateLog for all active stations
//   cascadeStationShiftDay  — re-sum STATION HOUR → SHIFT/DAY for one station
//   cascadeJobRollup        — recompute JOB-entity buckets for active jobs
//   cascadeParentRollup     — sum STATION values → WORKCENTER/SITE

import crypto from "node:crypto";
import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { onBucketsChanged, rowToSnapshot, type BucketChange } from "./sync.js";

type TransactionClient = Prisma.TransactionClient;

/**
 * Deterministic entityId for JOB-entity metric buckets.
 *
 * JOB buckets are per-station — each station×job pair gets its own
 * MetricBucket row. The composite ID avoids collisions on the unique
 * constraint (entityType, entityId, granularity, startTime) when
 * multiple stations run the same job.
 *
 * SQL equivalent: md5(station_id::text || ':job:' || job_id::text)::uuid
 */
export function jobEntityId(stationId: string, jobId: string): string {
  return crypto
    .createHash("md5")
    .update(`${stationId}:job:${jobId}`)
    .digest("hex")
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

/** Shape returned by RETURNING * from MetricBucket, with float8 casts. */
export interface BucketRow {
  entityType: string;
  entityId: string;
  entityName: string;
  path: string;
  granularity: string;
  granularityName: string;
  siteId: string;
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
}

function emitRows(rows: BucketRow[]): void {
  if (rows.length === 0) return;
  const changes: BucketChange[] = rows.map((row) => ({
    siteId: row.siteId,
    entityType: row.entityType as "STATION",
    entityId: row.entityId,
    entityName: row.entityName,
    path: row.path,
    granularity: row.granularity as "HOUR",
    granularityName: row.granularityName,
    startTime: row.startTime,
    durationSeconds: row.durationSeconds,
    shiftInstanceId: row.shiftInstanceId,
    businessDate: row.businessDate,
    businessShift: row.businessShift,
    snapshot: rowToSnapshot(row),
  }));
  onBucketsChanged(changes).catch((err) => {
    console.error("[cascade] Failed to emit bucket changes:", err);
  });
}

// ── HOUR-only count increment (per-cycle hot path) ──────────────

/**
 * Atomically increment count KPIs on the STATION HOUR bucket only.
 * No shift lookup, no SHIFT/DAY re-sum — just one UPDATE on one row.
 * SHIFT/DAY are handled by the 5s combined tick.
 */
export async function incrementHourCounts(
  client: TransactionClient | typeof prisma,
  stationId: string,
  _siteId: string,
  timestamp: Date,
  cycles: number,
  items: number,
  idealSeconds: number,
  totalCycleSeconds: number,
): Promise<void> {
  const rows = await client.$queryRaw<BucketRow[]>`
    UPDATE "MetricBucket" mb
    SET "totalCycles" = mb."totalCycles" + ${cycles}::int,
        "totalItems" = mb."totalItems" + ${items}::int,
        "idealCycleSeconds" = mb."idealCycleSeconds" + ${idealSeconds}::int,
        "totalCycleSeconds" = mb."totalCycleSeconds" + ${totalCycleSeconds}::int,
        "updatedAt" = NOW()
    WHERE mb."entityType" = 'STATION'::"BucketEntityType"
      AND mb."entityId" = ${stationId}::uuid
      AND mb.granularity = 'HOUR'::"BucketGranularity"
      AND mb."startTime" <= ${timestamp}::timestamptz
      AND mb."startTime" + mb."durationSeconds" * INTERVAL '1 second' > ${timestamp}::timestamptz
    RETURNING mb."entityType", mb."entityId"::text, mb."entityName", mb.path, mb.granularity::text, mb."granularityName",
              mb."siteId"::text, mb."startTime", mb."durationSeconds", mb."shiftInstanceId"::text, mb."businessDate", mb."businessShift",
              mb."totalCycles", mb."goodCycles", mb."badCycles", mb."totalItems", mb."goodItems", mb."badItems",
              mb."expectedCycles", mb."expectedItems", mb."runSeconds", mb."downSeconds",
              mb."plannedDownSeconds", mb."unplannedDownSeconds", mb."plannedProductionSeconds",
              mb."idealCycleSeconds", mb."totalCycleSeconds",
              mb."elapsedExpectedCycles", mb."elapsedExpectedItems", mb."elapsedPlannedProductionSeconds",
              mb."currentStandardCycle"::float8 AS "currentStandardCycle",
              mb.availability::float8 AS availability, mb.performance::float8 AS performance,
              mb.quality::float8 AS quality, mb.oee::float8 AS oee,
              mb."currentJobId"::text, mb."currentJobName"
  `;
  emitRows(rows);
}

// ── Job rollup ──────────────────────────────────────────────────

/**
 * Recompute JOB-entity HOUR bucket for the current job on a station,
 * then roll up to JOB SHIFT. Counts cycles and computes durations
 * clipped to the job's active period within the hour.
 */
export async function cascadeJobRollup(stationId: string, siteId: string, timestamp: Date): Promise<void> {
  const rows = await prisma.$queryRaw<BucketRow[]>`
    WITH
    -- Resolve the STATION HOUR bucket containing this tick's timestamp.
    -- JOB HOUR must align with STATION HOUR (they share shift-boundary
    -- partial hours), otherwise JOB SHIFT sums would miss the minutes
    -- that land in a pre-shift wall-clock bucket.
    target_bucket AS (
      SELECT "startTime" AS hour_start,
             "startTime" + "durationSeconds" * INTERVAL '1 second' AS hour_end,
             "durationSeconds" AS duration_seconds
      FROM "MetricBucket"
      WHERE "entityType" = 'STATION'::"BucketEntityType"
        AND "entityId" = ${stationId}::uuid
        AND granularity = 'HOUR'::"BucketGranularity"
        AND "startTime" <= ${timestamp}::timestamptz
        AND "startTime" + "durationSeconds" * INTERVAL '1 second' > ${timestamp}::timestamptz
      LIMIT 1
    ),
    params AS (
      SELECT
        ${stationId}::uuid AS station_id,
        ${siteId}::uuid AS site_id,
        tb.hour_start,
        tb.hour_end,
        tb.duration_seconds,
        NOW() AS v_now
      FROM target_bucket tb
    ),
    active_job AS (
      SELECT sjl."jobId", sjl."jobBlobId", sjl."startTime" AS job_start,
             sjl."endTime" AS job_end, sjl."standardCycle"::float8 AS std_cycle
      FROM "StationJobLog" sjl, params p
      WHERE sjl."stationId" = p.station_id
        AND sjl."startTime" < p.hour_end
        AND (sjl."endTime" > p.hour_start OR sjl."endTime" IS NULL)
      ORDER BY sjl."startTime" DESC LIMIT 1
    ),
    job_meta AS (
      SELECT aj.*,
        COALESCE((SELECT jb.name FROM "JobBlob" jb WHERE jb.id = aj."jobBlobId"), '') AS job_name,
        COALESCE((SELECT SUM(jpb.quantity)::int FROM "JobProduct" jp JOIN "JobProductBlob" jpb ON jpb.id = jp."currentBlobId" WHERE jp."jobId" = aj."jobId" AND jp."deletedAt" IS NULL AND jpb."isActive" = true), 1) AS items_per_cycle,
        COALESCE((SELECT mb.path FROM "MetricBucket" mb WHERE mb."entityType" = 'STATION' AND mb."entityId" = (SELECT station_id FROM params) AND mb.granularity = 'HOUR' AND mb."startTime" = (SELECT hour_start FROM params) LIMIT 1), 'site.' || (SELECT site_id FROM params) || '.station.' || (SELECT station_id FROM params)) || '.job.' || aj."jobId" AS job_path,
        md5((SELECT station_id FROM params)::text || ':job:' || aj."jobId"::text)::uuid AS job_entity_id
      FROM active_job aj
    ),
    shift_info AS (
      SELECT si.id AS shift_id, si."startTime" AS shift_start, si."endTime" AS shift_end, si."shiftName",
             si."businessDate"
      FROM "ShiftInstance" si
      LEFT JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
      WHERE si."startTime" <= (SELECT hour_start FROM params)
        AND si."endTime" > (SELECT hour_start FROM params)
        AND si."siteId" = (SELECT site_id FROM params)
        AND (
          si."workCenterId" = (SELECT "workcenterId" FROM "Station" WHERE id = (SELECT station_id FROM params))
          OR (si."workCenterId" IS NULL AND NOT EXISTS (
            SELECT 1 FROM "ShiftInstance" si2
            WHERE si2."startTime" <= (SELECT hour_start FROM params) AND si2."endTime" > (SELECT hour_start FROM params)
              AND si2."siteId" = (SELECT site_id FROM params)
              AND si2."workCenterId" = (SELECT "workcenterId" FROM "Station" WHERE id = (SELECT station_id FROM params))
          ))
        )
      ORDER BY sa."rotationStartDate" DESC NULLS LAST LIMIT 1
    ),
    -- Count cycles for this job in this hour
    cycle_stats AS (
      SELECT
        COUNT(*)::int AS total_cycles,
        COALESCE(SUM((SELECT COUNT(*)::int FROM "InventoryItem" ii WHERE ii."cycleId" = c.id)), 0)::int AS total_items,
        COALESCE(SUM(CASE WHEN jm.std_cycle > 0 THEN ROUND(jm.std_cycle)::int ELSE 0 END), 0)::int AS ideal_cycle_seconds,
        COALESCE(SUM(EXTRACT(EPOCH FROM (c."end" - c.start))::int), 0)::int AS total_cycle_seconds
      FROM "Cycle" c, params p, job_meta jm
      WHERE c."stationId" = p.station_id
        AND c."jobBlobId" = jm."jobBlobId"
        AND c."end" IS NOT NULL
        AND c."end" >= p.hour_start AND c."end" < p.hour_end
    ),
    -- Narrow state rows to those overlapping the current hour.
    -- UNION splits so closed entries seek (stationId, endTime) and open
    -- entries hit the partial unique index — "OR endTime IS NULL" alone
    -- can't be seeked and forces a full per-station history scan.
    state_slice AS (
      SELECT ssl.id, ssl."stationId", ssl."startTime", ssl."endTime", ssl.state, ssl."statusReasonId"
      FROM "StationStateLog" ssl, params p
      WHERE ssl."stationId" = p.station_id
        AND ssl."deletedAt" IS NULL
        AND ssl."endTime" >= p.hour_start
      UNION ALL
      SELECT ssl.id, ssl."stationId", ssl."startTime", ssl."endTime", ssl.state, ssl."statusReasonId"
      FROM "StationStateLog" ssl, params p
      WHERE ssl."stationId" = p.station_id
        AND ssl."deletedAt" IS NULL
        AND ssl."endTime" IS NULL
    ),
    -- Compute durations clipped to job window within hour
    job_dur AS (
      SELECT
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'UP' THEN EXTRACT(EPOCH FROM (
          LEAST(COALESCE(ssl."endTime", p.v_now), LEAST(p.hour_end, p.v_now, COALESCE(jm.job_end, p.v_now)))
          - GREATEST(ssl."startTime", p.hour_start, jm.job_start)
        )) ELSE 0 END))::int, 0) AS run_seconds,
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' THEN EXTRACT(EPOCH FROM (
          LEAST(COALESCE(ssl."endTime", p.v_now), LEAST(p.hour_end, p.v_now, COALESCE(jm.job_end, p.v_now)))
          - GREATEST(ssl."startTime", p.hour_start, jm.job_start)
        )) ELSE 0 END))::int, 0) AS down_seconds,
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' AND sr."isPlannedDown" = true THEN EXTRACT(EPOCH FROM (
          LEAST(COALESCE(ssl."endTime", p.v_now), LEAST(p.hour_end, p.v_now, COALESCE(jm.job_end, p.v_now)))
          - GREATEST(ssl."startTime", p.hour_start, jm.job_start)
        )) ELSE 0 END))::int, 0) AS planned_down_seconds,
        COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' AND (sr."isPlannedDown" IS NULL OR sr."isPlannedDown" = false) THEN EXTRACT(EPOCH FROM (
          LEAST(COALESCE(ssl."endTime", p.v_now), LEAST(p.hour_end, p.v_now, COALESCE(jm.job_end, p.v_now)))
          - GREATEST(ssl."startTime", p.hour_start, jm.job_start)
        )) ELSE 0 END))::int, 0) AS unplanned_down_seconds
      FROM state_slice ssl
      LEFT JOIN "StatusReason" sr ON sr.id = ssl."statusReasonId"
      CROSS JOIN params p
      CROSS JOIN job_meta jm
      WHERE ssl."startTime" < LEAST(p.hour_end, p.v_now, COALESCE(jm.job_end, p.v_now))
        AND (ssl."endTime" > GREATEST(p.hour_start, jm.job_start) OR ssl."endTime" IS NULL)
    ),
    job_derived AS (
      SELECT jd.*,
        jd.run_seconds + jd.unplanned_down_seconds AS elapsed_planned,
        CASE WHEN jm.std_cycle > 0 THEN FLOOR((EXTRACT(EPOCH FROM (LEAST(p.hour_end, p.v_now, COALESCE(jm.job_end, p.v_now)) - GREATEST(p.hour_start, jm.job_start)))::int - jd.planned_down_seconds) / jm.std_cycle)::int ELSE 0 END AS expected_cycles,
        CASE WHEN jm.std_cycle > 0 THEN FLOOR((jd.run_seconds + jd.unplanned_down_seconds) / jm.std_cycle)::int ELSE 0 END AS elapsed_expected_cycles,
        jm.std_cycle, jm.items_per_cycle, jm."jobId", jm.job_name, jm.job_path, jm.job_entity_id
      FROM job_dur jd, job_meta jm, params p
    ),
    -- Upsert JOB HOUR bucket
    upsert_job_hour AS (
      INSERT INTO "MetricBucket" (
        id, "siteId", "entityType", "entityId", granularity, "startTime", "durationSeconds",
        "entityName", "granularityName", path,
        "totalCycles", "badCycles", "totalItems", "badItems",
        "idealCycleSeconds", "totalCycleSeconds",
        "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
        "expectedCycles", "expectedItems", "elapsedExpectedCycles", "elapsedExpectedItems",
        "elapsedPlannedProductionSeconds", "currentStandardCycle",
        "currentJobId", "currentJobName",
        "shiftInstanceId", "businessDate", "businessShift",
        "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(), p.site_id, 'JOB'::"BucketEntityType", jd.job_entity_id, 'HOUR'::"BucketGranularity", p.hour_start, p.duration_seconds,
        jd.job_name, 'Hour', jd.job_path,
        cs.total_cycles, 0, cs.total_items, 0,
        cs.ideal_cycle_seconds, cs.total_cycle_seconds,
        jd.run_seconds, jd.down_seconds, jd.planned_down_seconds, jd.unplanned_down_seconds,
        jd.expected_cycles, jd.expected_cycles * jd.items_per_cycle,
        jd.elapsed_expected_cycles, jd.elapsed_expected_cycles * jd.items_per_cycle,
        jd.elapsed_planned, jd.std_cycle,
        jd."jobId", jd.job_name,
        si.shift_id, si."businessDate", si."shiftName",
        NOW(), NOW()
      FROM job_derived jd, cycle_stats cs, params p
      LEFT JOIN shift_info si ON true
      WHERE jd."jobId" IS NOT NULL
      ON CONFLICT ("entityType", "entityId", granularity, "startTime") DO UPDATE SET
        "totalCycles" = EXCLUDED."totalCycles", "totalItems" = EXCLUDED."totalItems",
        "idealCycleSeconds" = EXCLUDED."idealCycleSeconds", "totalCycleSeconds" = EXCLUDED."totalCycleSeconds",
        "runSeconds" = EXCLUDED."runSeconds", "downSeconds" = EXCLUDED."downSeconds",
        "plannedDownSeconds" = EXCLUDED."plannedDownSeconds", "unplannedDownSeconds" = EXCLUDED."unplannedDownSeconds",
        "expectedCycles" = EXCLUDED."expectedCycles", "expectedItems" = EXCLUDED."expectedItems",
        "elapsedExpectedCycles" = EXCLUDED."elapsedExpectedCycles", "elapsedExpectedItems" = EXCLUDED."elapsedExpectedItems",
        "elapsedPlannedProductionSeconds" = EXCLUDED."elapsedPlannedProductionSeconds",
        "currentStandardCycle" = EXCLUDED."currentStandardCycle",
        "currentJobId" = EXCLUDED."currentJobId", "currentJobName" = EXCLUDED."currentJobName",
        "updatedAt" = NOW()
      RETURNING *
    ),
    -- Re-sum JOB HOUR → JOB SHIFT
    job_shift_sum AS (
      SELECT
        SUM("totalCycles")::int AS "totalCycles", SUM("totalItems")::int AS "totalItems",
        SUM("badCycles")::int AS "badCycles", SUM("badItems")::int AS "badItems",
        SUM("idealCycleSeconds")::int AS "idealCycleSeconds", SUM("totalCycleSeconds")::int AS "totalCycleSeconds",
        SUM("runSeconds")::int AS "runSeconds", SUM("downSeconds")::int AS "downSeconds",
        SUM("plannedDownSeconds")::int AS "plannedDownSeconds", SUM("unplannedDownSeconds")::int AS "unplannedDownSeconds",
        SUM("expectedCycles")::int AS "expectedCycles", SUM("expectedItems")::int AS "expectedItems",
        SUM("elapsedExpectedCycles")::int AS "elapsedExpectedCycles", SUM("elapsedExpectedItems")::int AS "elapsedExpectedItems",
        SUM("elapsedPlannedProductionSeconds")::int AS "elapsedPlannedProductionSeconds",
        SUM("durationSeconds")::int AS "durationSeconds"
      FROM "MetricBucket", job_derived jd, shift_info si
      WHERE "entityType" = 'JOB' AND "entityId" = jd.job_entity_id
        AND granularity = 'HOUR' AND "startTime" >= si.shift_start AND "startTime" < si.shift_end
    ),
    upsert_job_shift AS (
      INSERT INTO "MetricBucket" (
        id, "siteId", "entityType", "entityId", granularity, "startTime", "durationSeconds",
        "entityName", "granularityName", path,
        "totalCycles", "badCycles", "totalItems", "badItems",
        "idealCycleSeconds", "totalCycleSeconds",
        "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
        "expectedCycles", "expectedItems", "elapsedExpectedCycles", "elapsedExpectedItems",
        "elapsedPlannedProductionSeconds", "currentStandardCycle",
        "currentJobId", "currentJobName",
        "shiftInstanceId", "businessDate", "businessShift",
        "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(), p.site_id, 'JOB'::"BucketEntityType", jd.job_entity_id, 'SHIFT'::"BucketGranularity",
        si.shift_start, EXTRACT(EPOCH FROM (si.shift_end - si.shift_start))::int,
        jd.job_name, COALESCE(si."shiftName", 'Shift'), jd.job_path,
        js."totalCycles", js."badCycles", js."totalItems", js."badItems",
        js."idealCycleSeconds", js."totalCycleSeconds",
        js."runSeconds", js."downSeconds", js."plannedDownSeconds", js."unplannedDownSeconds",
        js."expectedCycles", js."expectedItems", js."elapsedExpectedCycles", js."elapsedExpectedItems",
        js."elapsedPlannedProductionSeconds", jd.std_cycle,
        jd."jobId", jd.job_name,
        si.shift_id, si."businessDate", si."shiftName",
        NOW(), NOW()
      FROM job_shift_sum js, job_derived jd, params p
      LEFT JOIN shift_info si ON true
      WHERE jd."jobId" IS NOT NULL AND si.shift_start IS NOT NULL AND js."totalCycles" IS NOT NULL
      ON CONFLICT ("entityType", "entityId", granularity, "startTime") DO UPDATE SET
        "totalCycles" = EXCLUDED."totalCycles", "totalItems" = EXCLUDED."totalItems",
        "badCycles" = EXCLUDED."badCycles", "badItems" = EXCLUDED."badItems",
        "idealCycleSeconds" = EXCLUDED."idealCycleSeconds", "totalCycleSeconds" = EXCLUDED."totalCycleSeconds",
        "runSeconds" = EXCLUDED."runSeconds", "downSeconds" = EXCLUDED."downSeconds",
        "plannedDownSeconds" = EXCLUDED."plannedDownSeconds", "unplannedDownSeconds" = EXCLUDED."unplannedDownSeconds",
        "expectedCycles" = EXCLUDED."expectedCycles", "expectedItems" = EXCLUDED."expectedItems",
        "elapsedExpectedCycles" = EXCLUDED."elapsedExpectedCycles", "elapsedExpectedItems" = EXCLUDED."elapsedExpectedItems",
        "elapsedPlannedProductionSeconds" = EXCLUDED."elapsedPlannedProductionSeconds",
        "currentStandardCycle" = EXCLUDED."currentStandardCycle",
        "currentJobId" = EXCLUDED."currentJobId", "currentJobName" = EXCLUDED."currentJobName",
        "updatedAt" = NOW()
      RETURNING *
    )
    SELECT "entityType", "entityId"::text, "entityName", path, granularity::text, "granularityName",
           "siteId"::text, "startTime", "durationSeconds", "shiftInstanceId"::text, "businessDate", "businessShift",
           "totalCycles", "goodCycles", "badCycles", "totalItems", "goodItems", "badItems",
           "expectedCycles", "expectedItems", "runSeconds", "downSeconds",
           "plannedDownSeconds", "unplannedDownSeconds", "plannedProductionSeconds",
           "idealCycleSeconds", "totalCycleSeconds",
           "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
           "currentStandardCycle"::float8 AS "currentStandardCycle",
           availability::float8 AS availability, performance::float8 AS performance,
           quality::float8 AS quality, oee::float8 AS oee,
           "currentJobId"::text, "currentJobName"
    FROM upsert_job_hour
    UNION ALL
    SELECT "entityType", "entityId"::text, "entityName", path, granularity::text, "granularityName",
           "siteId"::text, "startTime", "durationSeconds", "shiftInstanceId"::text, "businessDate", "businessShift",
           "totalCycles", "goodCycles", "badCycles", "totalItems", "goodItems", "badItems",
           "expectedCycles", "expectedItems", "runSeconds", "downSeconds",
           "plannedDownSeconds", "unplannedDownSeconds", "plannedProductionSeconds",
           "idealCycleSeconds", "totalCycleSeconds",
           "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
           "currentStandardCycle"::float8 AS "currentStandardCycle",
           availability::float8 AS availability, performance::float8 AS performance,
           quality::float8 AS quality, oee::float8 AS oee,
           "currentJobId"::text, "currentJobName"
    FROM upsert_job_shift
  `;
  emitRows(rows);
}

// ── Sync expectedCycles from JOB → STATION ─────────────────────

/**
 * After cascadeJobRollup writes accurate per-job expectedCycles to JOB HOUR
 * buckets, sum them back to the STATION HOUR bucket. This handles multi-job
 * hours correctly — each job's expectedCycles is computed from its own
 * standardCycle and time window within the hour.
 *
 * Also syncs elapsedExpectedCycles, expectedItems, elapsedExpectedItems,
 * and currentStandardCycle (from the most recent job).
 */
export async function syncExpectedCyclesFromJobs(stationId: string, siteId: string, timestamp: Date): Promise<void> {
  await prisma.$executeRaw`
    WITH
    -- Resolve the STATION HOUR bucket; JOB HOUR aligns with STATION HOUR
    -- (see cascadeJobRollup), so we match JOB HOUR by this startTime.
    target_bucket AS (
      SELECT "startTime" AS hour_start
      FROM "MetricBucket"
      WHERE "entityType" = 'STATION'::"BucketEntityType"
        AND "entityId" = ${stationId}::uuid
        AND granularity = 'HOUR'::"BucketGranularity"
        AND "startTime" <= ${timestamp}::timestamptz
        AND "startTime" + "durationSeconds" * INTERVAL '1 second' > ${timestamp}::timestamptz
      LIMIT 1
    ),
    params AS (
      SELECT ${stationId}::uuid AS station_id, tb.hour_start
      FROM target_bucket tb
    ),
    job_sums AS (
      SELECT
        COALESCE(SUM(jb."expectedCycles"), 0)::int AS expected_cycles,
        COALESCE(SUM(jb."expectedItems"), 0)::int AS expected_items,
        COALESCE(SUM(jb."elapsedExpectedCycles"), 0)::int AS elapsed_expected_cycles,
        COALESCE(SUM(jb."elapsedExpectedItems"), 0)::int AS elapsed_expected_items,
        (SELECT jb2."currentStandardCycle" FROM "MetricBucket" jb2
         WHERE jb2."entityType" = 'JOB' AND jb2.granularity = 'HOUR'
           AND jb2."startTime" = (SELECT hour_start FROM params)
           AND jb2."siteId" = ${siteId}::uuid
           AND jb2."entityId" = md5((SELECT station_id FROM params)::text || ':job:' || (SELECT s."currentJobId" FROM "Station" s WHERE s.id = (SELECT station_id FROM params))::text)::uuid
         LIMIT 1) AS current_std_cycle
      FROM "MetricBucket" jb
      JOIN "StationJobLog" sjl ON sjl."jobId" = jb."currentJobId"
        AND sjl."stationId" = (SELECT station_id FROM params)
        AND sjl."startTime" < (SELECT hour_start FROM params) + INTERVAL '1 hour'
        AND (sjl."endTime" > (SELECT hour_start FROM params) OR sjl."endTime" IS NULL)
      WHERE jb."entityType" = 'JOB'
        AND jb.granularity = 'HOUR'
        AND jb."startTime" = (SELECT hour_start FROM params)
        AND jb."siteId" = ${siteId}::uuid
        AND jb."entityId" = md5((SELECT station_id FROM params)::text || ':job:' || sjl."jobId"::text)::uuid
    )
    UPDATE "MetricBucket" mb
    SET "expectedCycles" = js.expected_cycles,
        "expectedItems" = js.expected_items,
        "elapsedExpectedCycles" = js.elapsed_expected_cycles,
        "elapsedExpectedItems" = js.elapsed_expected_items,
        "currentStandardCycle" = COALESCE(js.current_std_cycle, mb."currentStandardCycle"),
        "updatedAt" = NOW()
    FROM job_sums js, params p
    WHERE mb."entityType" = 'STATION'
      AND mb."entityId" = p.station_id
      AND mb.granularity = 'HOUR'
      AND mb."startTime" <= ${timestamp}::timestamptz
      AND mb."startTime" + mb."durationSeconds" * INTERVAL '1 second' > ${timestamp}::timestamptz
  `;
}

// ── Batch count rollup ──────────────────────────────────────────

/**
 * Batch recompute count KPIs from the Cycle table for ALL active stations
 * in one SQL roundtrip, then write per-station in parallel.
 *
 * Replaces the old per-cycle cascadeCountRollup — counts are now derived
 * from source tables (idempotent, no drift from missed increments).
 *
 * Returns the list of stations processed.
 */
export async function batchCountRollup(timestamp: Date): Promise<Array<{ stationId: string; siteId: string }>> {
  // Phase 1: One query — count cycles + items for all active stations in current hour
  const counts = await prisma.$queryRaw<
    Array<{
      station_id: string;
      site_id: string;
      std_cycle: number | null;
      items_per_cycle: number;
      total_cycles: number;
      bad_cycles: number;
      total_items: number;
      bad_items: number;
      total_cycle_seconds: number;
      ideal_cycle_seconds: number;
    }>
  >`
    WITH
    open_stations AS (
      SELECT DISTINCT ON (ssl."stationId")
        ssl."stationId" AS station_id,
        s."siteId" AS site_id,
        (SELECT jb."standardCycle"::float8
         FROM "Job" j JOIN "JobBlob" jb ON jb.id = j."currentBlobId"
         WHERE j.id = s."currentJobId") AS std_cycle,
        (SELECT COALESCE((SELECT SUM(jpb.quantity)::int
         FROM "JobProduct" jp JOIN "JobProductBlob" jpb ON jpb.id = jp."currentBlobId"
         WHERE jp."jobId" = s."currentJobId" AND jp."deletedAt" IS NULL AND jpb."isActive" = true), 1)) AS items_per_cycle
      FROM "StationStateLog" ssl
      JOIN "Station" s ON s.id = ssl."stationId"
      WHERE ssl."endTime" IS NULL AND ssl."deletedAt" IS NULL
      ORDER BY ssl."stationId"
    ),
    -- Resolve each station's current STATION HOUR bucket via containment.
    -- Hours are shift-aligned when the site has a schedule, so we can't
    -- use a single wall-clock [hour_start, hour_end) window across all
    -- stations — count Cycles within each station's actual bucket bounds.
    station_buckets AS (
      SELECT os.station_id,
             mb."startTime" AS hour_start,
             mb."startTime" + mb."durationSeconds" * INTERVAL '1 second' AS hour_end
      FROM open_stations os
      JOIN "MetricBucket" mb ON mb."entityType" = 'STATION'::"BucketEntityType"
        AND mb."entityId" = os.station_id
        AND mb.granularity = 'HOUR'::"BucketGranularity"
        AND mb."startTime" <= ${timestamp}::timestamptz
        AND mb."startTime" + mb."durationSeconds" * INTERVAL '1 second' > ${timestamp}::timestamptz
    ),
    cycle_counts AS (
      SELECT c."stationId" AS station_id,
        COUNT(*)::int AS total_cycles,
        COUNT(*) FILTER (WHERE c."cycleStatus" != 'GOOD')::int AS bad_cycles,
        COALESCE(SUM(EXTRACT(EPOCH FROM (c."end" - c.start)))::int, 0) AS total_cycle_seconds
      FROM "Cycle" c
      JOIN station_buckets sb ON sb.station_id = c."stationId"
      WHERE c."end" >= sb.hour_start AND c."end" < sb.hour_end
      GROUP BY c."stationId"
    ),
    item_counts AS (
      SELECT c."stationId" AS station_id,
        COUNT(ii.id)::int AS total_items,
        COUNT(ii.id) FILTER (WHERE c."cycleStatus" != 'GOOD')::int AS bad_items
      FROM "Cycle" c
      JOIN station_buckets sb ON sb.station_id = c."stationId"
      JOIN "InventoryItem" ii ON ii."cycleId" = c.id
      WHERE c."end" >= sb.hour_start AND c."end" < sb.hour_end
      GROUP BY c."stationId"
    )
    SELECT os.station_id::text, os.site_id::text, os.std_cycle, os.items_per_cycle,
           COALESCE(cc.total_cycles, 0)::int AS total_cycles,
           COALESCE(cc.bad_cycles, 0)::int AS bad_cycles,
           COALESCE(ic.total_items, 0)::int AS total_items,
           COALESCE(ic.bad_items, 0)::int AS bad_items,
           COALESCE(cc.total_cycle_seconds, 0)::int AS total_cycle_seconds,
           CASE WHEN os.std_cycle > 0 THEN (COALESCE(cc.total_cycles, 0) * os.std_cycle)::int ELSE 0 END AS ideal_cycle_seconds
    FROM open_stations os
    LEFT JOIN cycle_counts cc ON cc.station_id = os.station_id
    LEFT JOIN item_counts ic ON ic.station_id = os.station_id
  `;

  if (counts.length === 0) return [];

  // Phase 2: Write per-station in parallel (no cross-station locking)
  const CONCURRENCY = 10;
  for (let i = 0; i < counts.length; i += CONCURRENCY) {
    await Promise.all(
      counts.slice(i, i + CONCURRENCY).map(async (c) => {
        try {
          const rows = await prisma.$queryRaw<BucketRow[]>`
          WITH
          upd_hour AS (
            UPDATE "MetricBucket" mb SET
              "totalCycles" = ${c.total_cycles}::int,
              "badCycles" = ${c.bad_cycles}::int,
              "totalItems" = ${c.total_items}::int,
              "badItems" = ${c.bad_items}::int,
              "idealCycleSeconds" = ${c.ideal_cycle_seconds}::int,
              "totalCycleSeconds" = ${c.total_cycle_seconds}::int,
              "updatedAt" = NOW()
            WHERE mb."entityType" = 'STATION'::"BucketEntityType"
              AND mb."entityId" = ${c.station_id}::uuid
              AND mb.granularity = 'HOUR'::"BucketGranularity"
              AND mb."startTime" <= ${timestamp}::timestamptz
              AND mb."startTime" + mb."durationSeconds" * INTERVAL '1 second' > ${timestamp}::timestamptz
            RETURNING mb.*
          )
          SELECT "entityType", "entityId"::text, "entityName", path, granularity::text, "granularityName",
                 "siteId"::text, "startTime", "durationSeconds", "shiftInstanceId"::text, "businessDate", "businessShift",
                 "totalCycles", "goodCycles", "badCycles", "totalItems", "goodItems", "badItems",
                 "expectedCycles", "expectedItems", "runSeconds", "downSeconds",
                 "plannedDownSeconds", "unplannedDownSeconds", "plannedProductionSeconds",
                 "idealCycleSeconds", "totalCycleSeconds",
                 "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
                 "currentStandardCycle"::float8 AS "currentStandardCycle",
                 availability::float8 AS availability, performance::float8 AS performance,
                 quality::float8 AS quality, oee::float8 AS oee,
                 "currentJobId"::text, "currentJobName"
          FROM upd_hour
        `;
          emitRows(rows);
        } catch (err) {
          console.error(`[metrics:batch-count] Write failed for station ${c.station_id}:`, err);
        }
      }),
    );
  }

  return counts.map((c) => ({ stationId: c.station_id, siteId: c.site_id }));
}

// ── Batch duration tick ─────────────────────────────────────────

/**
 * Batch compute duration KPIs for ALL stations with open state entries
 * in one SQL roundtrip (one StationStateLog scan instead of N), then
 * write per-station in parallel (avoids multi-row lock deadlocks with
 * concurrent cycle cascades).
 *
 * Returns the list of stations processed so the caller can run job rollups.
 */
export async function batchDurationRollup(timestamp: Date): Promise<Array<{ stationId: string; siteId: string }>> {
  // Phase 1: Get active stations + derive standardCycle from accumulated HOUR bucket
  // (idealCycleSeconds / totalCycles gives weighted avg across all jobs in the hour)
  const stations = await prisma.$queryRaw<
    Array<{
      station_id: string;
      site_id: string;
      std_cycle: number | null;
      items_per_cycle: number;
    }>
  >`
    SELECT DISTINCT ON (ssl."stationId")
      ssl."stationId"::text AS station_id,
      s."siteId"::text AS site_id,
      CASE WHEN mb."totalCycles" > 0 AND mb."idealCycleSeconds" > 0
        THEN (mb."idealCycleSeconds"::float8 / mb."totalCycles"::float8)
        ELSE (SELECT jb."standardCycle"::float8
              FROM "Job" j JOIN "JobBlob" jb ON jb.id = j."currentBlobId"
              WHERE j.id = s."currentJobId")
      END AS std_cycle,
      CASE WHEN mb."totalCycles" > 0 AND mb."totalItems" > 0
        THEN ROUND(mb."totalItems"::float8 / mb."totalCycles"::float8)::int
        ELSE COALESCE((SELECT SUM(jpb.quantity)::int
              FROM "JobProduct" jp JOIN "JobProductBlob" jpb ON jpb.id = jp."currentBlobId"
              WHERE jp."jobId" = s."currentJobId" AND jp."deletedAt" IS NULL AND jpb."isActive" = true), 1)
      END AS items_per_cycle
    FROM "StationStateLog" ssl
    JOIN "Station" s ON s.id = ssl."stationId"
    LEFT JOIN "MetricBucket" mb ON mb."entityType" = 'STATION' AND mb."entityId" = ssl."stationId"
      AND mb.granularity = 'HOUR'
      AND mb."startTime" <= ${timestamp}::timestamptz
      AND mb."startTime" + mb."durationSeconds" * INTERVAL '1 second' > ${timestamp}::timestamptz
    WHERE ssl."endTime" IS NULL AND ssl."deletedAt" IS NULL
    ORDER BY ssl."stationId"
  `;

  if (stations.length === 0) return [];

  // Phase 2: Compute durations + write per-station in parallel.
  // Each query uses the (stationId, startTime) index for efficient time-range lookup
  // instead of scanning the full StationStateLog table.
  const CONCURRENCY = 10;
  for (let i = 0; i < stations.length; i += CONCURRENCY) {
    await Promise.all(
      stations.slice(i, i + CONCURRENCY).map(async (s) => {
        try {
          const rows = await prisma.$queryRaw<BucketRow[]>`
          WITH
          -- Resolve the exact STATION HOUR bucket that contains the tick
          -- timestamp. Buckets are shift-aligned when a shift schedule
          -- exists (e.g. start at :30 past, partial at shift boundaries),
          -- so use containment rather than date_trunc('hour', ...).
          target_bucket AS (
            SELECT "startTime", "durationSeconds",
                   "startTime" + "durationSeconds" * INTERVAL '1 second' AS end_time
            FROM "MetricBucket"
            WHERE "entityType" = 'STATION'::"BucketEntityType"
              AND "entityId" = ${s.station_id}::uuid
              AND granularity = 'HOUR'::"BucketGranularity"
              AND "startTime" <= ${timestamp}::timestamptz
              AND "startTime" + "durationSeconds" * INTERVAL '1 second' > ${timestamp}::timestamptz
            LIMIT 1
          ),
          params AS (
            SELECT
              tb."startTime" AS hour_start,
              tb.end_time AS hour_end,
              tb."durationSeconds" AS duration_seconds,
              NOW() AS v_now
            FROM target_bucket tb
          ),
          -- Narrow to state entries overlapping the current hour.
          -- UNION so closed entries seek (stationId, endTime) and open
          -- entries hit the partial unique index.
          state_slice AS (
            SELECT ssl.id, ssl."stationId", ssl."startTime", ssl."endTime", ssl.state, ssl."statusReasonId"
            FROM "StationStateLog" ssl, params p
            WHERE ssl."stationId" = ${s.station_id}::uuid
              AND ssl."deletedAt" IS NULL
              AND ssl."endTime" >= p.hour_start
            UNION ALL
            SELECT ssl.id, ssl."stationId", ssl."startTime", ssl."endTime", ssl.state, ssl."statusReasonId"
            FROM "StationStateLog" ssl
            WHERE ssl."stationId" = ${s.station_id}::uuid
              AND ssl."deletedAt" IS NULL
              AND ssl."endTime" IS NULL
          ),
          dur AS (
            SELECT
              COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'UP' THEN EXTRACT(EPOCH FROM (LEAST(COALESCE(ssl."endTime", p.v_now), LEAST(p.hour_end, p.v_now)) - GREATEST(ssl."startTime", p.hour_start))) ELSE 0 END))::int, 0) AS run_seconds,
              COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' THEN EXTRACT(EPOCH FROM (LEAST(COALESCE(ssl."endTime", p.v_now), LEAST(p.hour_end, p.v_now)) - GREATEST(ssl."startTime", p.hour_start))) ELSE 0 END))::int, 0) AS down_seconds,
              COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' AND sr."isPlannedDown" = true THEN EXTRACT(EPOCH FROM (LEAST(COALESCE(ssl."endTime", p.v_now), LEAST(p.hour_end, p.v_now)) - GREATEST(ssl."startTime", p.hour_start))) ELSE 0 END))::int, 0) AS planned_down_seconds,
              COALESCE(ROUND(SUM(CASE WHEN ssl.state = 'DOWN' AND (sr."isPlannedDown" IS NULL OR sr."isPlannedDown" = false) THEN EXTRACT(EPOCH FROM (LEAST(COALESCE(ssl."endTime", p.v_now), LEAST(p.hour_end, p.v_now)) - GREATEST(ssl."startTime", p.hour_start))) ELSE 0 END))::int, 0) AS unplanned_down_seconds
            FROM state_slice ssl
            LEFT JOIN "StatusReason" sr ON sr.id = ssl."statusReasonId"
            CROSS JOIN params p
            WHERE ssl."startTime" < LEAST(p.hour_end, p.v_now)
              AND (ssl."endTime" > p.hour_start OR ssl."endTime" IS NULL)
          ),
          derived AS (
            SELECT d.*,
              d.run_seconds + d.unplanned_down_seconds AS elapsed_planned,
              CASE WHEN ${s.std_cycle ?? 0}::float8 > 0 THEN FLOOR((p.duration_seconds - d.planned_down_seconds) / ${s.std_cycle ?? 0}::float8)::int ELSE 0 END AS expected_cycles,
              CASE WHEN ${s.std_cycle ?? 0}::float8 > 0 THEN FLOOR((d.run_seconds + d.unplanned_down_seconds) / ${s.std_cycle ?? 0}::float8)::int ELSE 0 END AS elapsed_expected_cycles
            FROM dur d, params p
          ),
          upd_hour AS (
            UPDATE "MetricBucket" mb SET
              "runSeconds" = d.run_seconds, "downSeconds" = d.down_seconds,
              "plannedDownSeconds" = d.planned_down_seconds, "unplannedDownSeconds" = d.unplanned_down_seconds,
              "elapsedPlannedProductionSeconds" = d.elapsed_planned,
              "expectedCycles" = d.expected_cycles, "expectedItems" = d.expected_cycles * ${s.items_per_cycle}::int,
              "elapsedExpectedCycles" = d.elapsed_expected_cycles, "elapsedExpectedItems" = d.elapsed_expected_cycles * ${s.items_per_cycle}::int,
              "currentStandardCycle" = ${s.std_cycle ?? 0}::float8, "updatedAt" = NOW()
            FROM derived d, params p
            WHERE mb."entityType" = 'STATION'::"BucketEntityType"
              AND mb."entityId" = ${s.station_id}::uuid
              AND mb.granularity = 'HOUR'::"BucketGranularity"
              AND mb."startTime" = p.hour_start
            RETURNING mb.*
          )
          SELECT "entityType", "entityId"::text, "entityName", path, granularity::text, "granularityName",
                 "siteId"::text, "startTime", "durationSeconds", "shiftInstanceId"::text, "businessDate", "businessShift",
                 "totalCycles", "goodCycles", "badCycles", "totalItems", "goodItems", "badItems",
                 "expectedCycles", "expectedItems", "runSeconds", "downSeconds",
                 "plannedDownSeconds", "unplannedDownSeconds", "plannedProductionSeconds",
                 "idealCycleSeconds", "totalCycleSeconds",
                 "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
                 "currentStandardCycle"::float8 AS "currentStandardCycle",
                 availability::float8 AS availability, performance::float8 AS performance,
                 quality::float8 AS quality, oee::float8 AS oee,
                 "currentJobId"::text, "currentJobName"
          FROM upd_hour
        `;
          emitRows(rows);
        } catch (err) {
          console.error(`[metrics:batch-duration] Failed for station ${s.station_id}:`, err);
        }
      }),
    );
  }

  return stations.map((s) => ({ stationId: s.station_id, siteId: s.site_id }));
}

// ── Station SHIFT/DAY rollup ────────────────────────────────────

/**
 * Re-sum STATION HOUR buckets → SHIFT and DAY for a single station.
 * Combines count + duration fields in one CTE (single shift lookup).
 * Called from the 5s combined tick after batch count + duration writes.
 *
 * The UPDATE is guarded by an IS DISTINCT FROM predicate so rows whose
 * summed values match the stored row are skipped — no write, no updatedAt
 * bump, no SSE emission. Keeps the stream quiet for stations with no
 * activity and avoids churn on completed shifts/days.
 */
export async function cascadeStationShiftDay(stationId: string, siteId: string, timestamp: Date): Promise<void> {
  const rows = await prisma.$queryRaw<BucketRow[]>`
    WITH
    params AS (
      SELECT
        ${stationId}::uuid AS station_id,
        ${siteId}::uuid AS site_id,
        ${timestamp}::timestamptz AS bucket_ts,
        (SELECT COALESCE(timezone, 'UTC') FROM "Site" WHERE id = ${siteId}::uuid) AS tz
    ),
    shift_info AS (
      SELECT si."startTime" AS shift_start, si."endTime" AS shift_end
      FROM "ShiftInstance" si
      LEFT JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
      WHERE si."startTime" <= (SELECT bucket_ts FROM params)
        AND si."endTime" > (SELECT bucket_ts FROM params)
        AND si."siteId" = (SELECT site_id FROM params)
        AND (
          si."workCenterId" = (SELECT "workcenterId" FROM "Station" WHERE id = (SELECT station_id FROM params))
          OR (si."workCenterId" IS NULL AND NOT EXISTS (
            SELECT 1 FROM "ShiftInstance" si2
            WHERE si2."startTime" <= (SELECT bucket_ts FROM params) AND si2."endTime" > (SELECT bucket_ts FROM params)
              AND si2."siteId" = (SELECT site_id FROM params)
              AND si2."workCenterId" = (SELECT "workcenterId" FROM "Station" WHERE id = (SELECT station_id FROM params))
          ))
        )
      ORDER BY sa."rotationStartDate" DESC NULLS LAST LIMIT 1
    ),
    -- Re-sum ALL HOUR → SHIFT (count + duration fields)
    shift_sums AS (
      SELECT
        SUM(mb."totalCycles")::int AS "totalCycles", SUM(mb."totalItems")::int AS "totalItems",
        SUM(mb."badCycles")::int AS "badCycles", SUM(mb."badItems")::int AS "badItems",
        SUM(mb."idealCycleSeconds")::int AS "idealCycleSeconds", SUM(mb."totalCycleSeconds")::int AS "totalCycleSeconds",
        SUM(mb."runSeconds")::int AS "runSeconds", SUM(mb."downSeconds")::int AS "downSeconds",
        SUM(mb."plannedDownSeconds")::int AS "plannedDownSeconds", SUM(mb."unplannedDownSeconds")::int AS "unplannedDownSeconds",
        SUM(mb."expectedCycles")::int AS "expectedCycles", SUM(mb."expectedItems")::int AS "expectedItems",
        SUM(mb."elapsedExpectedCycles")::int AS "elapsedExpectedCycles", SUM(mb."elapsedExpectedItems")::int AS "elapsedExpectedItems",
        SUM(mb."elapsedPlannedProductionSeconds")::int AS "elapsedPlannedProductionSeconds",
        SUM(mb."durationSeconds")::int AS "durationSeconds"
      FROM "MetricBucket" mb, shift_info si
      WHERE mb."entityType" = 'STATION'::"BucketEntityType"
        AND mb."entityId" = (SELECT station_id FROM params)
        AND mb.granularity = 'HOUR'::"BucketGranularity"
        AND mb."startTime" >= si.shift_start AND mb."startTime" < si.shift_end
    ),
    upd_shift AS (
      UPDATE "MetricBucket" mb
      SET "totalCycles" = ss."totalCycles", "totalItems" = ss."totalItems",
          "badCycles" = ss."badCycles", "badItems" = ss."badItems",
          "idealCycleSeconds" = ss."idealCycleSeconds", "totalCycleSeconds" = ss."totalCycleSeconds",
          "runSeconds" = ss."runSeconds", "downSeconds" = ss."downSeconds",
          "plannedDownSeconds" = ss."plannedDownSeconds", "unplannedDownSeconds" = ss."unplannedDownSeconds",
          "expectedCycles" = ss."expectedCycles", "expectedItems" = ss."expectedItems",
          "elapsedExpectedCycles" = ss."elapsedExpectedCycles", "elapsedExpectedItems" = ss."elapsedExpectedItems",
          "elapsedPlannedProductionSeconds" = ss."elapsedPlannedProductionSeconds",
          "durationSeconds" = ss."durationSeconds", "updatedAt" = NOW()
      FROM shift_sums ss, shift_info si
      WHERE mb."entityType" = 'STATION'::"BucketEntityType"
        AND mb."entityId" = (SELECT station_id FROM params)
        AND mb.granularity = 'SHIFT'::"BucketGranularity"
        AND mb."startTime" = si.shift_start
        AND (
          mb."totalCycles"                     IS DISTINCT FROM ss."totalCycles" OR
          mb."totalItems"                      IS DISTINCT FROM ss."totalItems" OR
          mb."badCycles"                       IS DISTINCT FROM ss."badCycles" OR
          mb."badItems"                        IS DISTINCT FROM ss."badItems" OR
          mb."idealCycleSeconds"               IS DISTINCT FROM ss."idealCycleSeconds" OR
          mb."totalCycleSeconds"               IS DISTINCT FROM ss."totalCycleSeconds" OR
          mb."runSeconds"                      IS DISTINCT FROM ss."runSeconds" OR
          mb."downSeconds"                     IS DISTINCT FROM ss."downSeconds" OR
          mb."plannedDownSeconds"              IS DISTINCT FROM ss."plannedDownSeconds" OR
          mb."unplannedDownSeconds"            IS DISTINCT FROM ss."unplannedDownSeconds" OR
          mb."expectedCycles"                  IS DISTINCT FROM ss."expectedCycles" OR
          mb."expectedItems"                   IS DISTINCT FROM ss."expectedItems" OR
          mb."elapsedExpectedCycles"           IS DISTINCT FROM ss."elapsedExpectedCycles" OR
          mb."elapsedExpectedItems"            IS DISTINCT FROM ss."elapsedExpectedItems" OR
          mb."elapsedPlannedProductionSeconds" IS DISTINCT FROM ss."elapsedPlannedProductionSeconds" OR
          mb."durationSeconds"                 IS DISTINCT FROM ss."durationSeconds"
        )
      RETURNING mb.*
    ),
    -- Re-sum ALL HOUR → DAY (count + duration fields)
    day_sums AS (
      SELECT
        SUM(mb."totalCycles")::int AS "totalCycles", SUM(mb."totalItems")::int AS "totalItems",
        SUM(mb."badCycles")::int AS "badCycles", SUM(mb."badItems")::int AS "badItems",
        SUM(mb."idealCycleSeconds")::int AS "idealCycleSeconds", SUM(mb."totalCycleSeconds")::int AS "totalCycleSeconds",
        SUM(mb."runSeconds")::int AS "runSeconds", SUM(mb."downSeconds")::int AS "downSeconds",
        SUM(mb."plannedDownSeconds")::int AS "plannedDownSeconds", SUM(mb."unplannedDownSeconds")::int AS "unplannedDownSeconds",
        SUM(mb."expectedCycles")::int AS "expectedCycles", SUM(mb."expectedItems")::int AS "expectedItems",
        SUM(mb."elapsedExpectedCycles")::int AS "elapsedExpectedCycles", SUM(mb."elapsedExpectedItems")::int AS "elapsedExpectedItems",
        SUM(mb."elapsedPlannedProductionSeconds")::int AS "elapsedPlannedProductionSeconds",
        SUM(mb."durationSeconds")::int AS "durationSeconds"
      FROM "MetricBucket" mb, params p
      WHERE mb."entityType" = 'STATION'::"BucketEntityType"
        AND mb."entityId" = (SELECT station_id FROM params)
        AND mb.granularity = 'HOUR'::"BucketGranularity"
        AND mb."startTime" >= date_trunc('day', (SELECT bucket_ts FROM params) AT TIME ZONE (SELECT tz FROM params)) AT TIME ZONE (SELECT tz FROM params)
        AND mb."startTime" < (date_trunc('day', (SELECT bucket_ts FROM params) AT TIME ZONE (SELECT tz FROM params)) + INTERVAL '1 day') AT TIME ZONE (SELECT tz FROM params)
    ),
    upd_day AS (
      UPDATE "MetricBucket" mb
      SET "totalCycles" = ds."totalCycles", "totalItems" = ds."totalItems",
          "badCycles" = ds."badCycles", "badItems" = ds."badItems",
          "idealCycleSeconds" = ds."idealCycleSeconds", "totalCycleSeconds" = ds."totalCycleSeconds",
          "runSeconds" = ds."runSeconds", "downSeconds" = ds."downSeconds",
          "plannedDownSeconds" = ds."plannedDownSeconds", "unplannedDownSeconds" = ds."unplannedDownSeconds",
          "expectedCycles" = ds."expectedCycles", "expectedItems" = ds."expectedItems",
          "elapsedExpectedCycles" = ds."elapsedExpectedCycles", "elapsedExpectedItems" = ds."elapsedExpectedItems",
          "elapsedPlannedProductionSeconds" = ds."elapsedPlannedProductionSeconds",
          "durationSeconds" = ds."durationSeconds", "updatedAt" = NOW()
      FROM day_sums ds, params p
      WHERE mb."entityType" = 'STATION'::"BucketEntityType"
        AND mb."entityId" = (SELECT station_id FROM params)
        AND mb.granularity = 'DAY'::"BucketGranularity"
        AND mb."startTime" = date_trunc('day', (SELECT bucket_ts FROM params) AT TIME ZONE (SELECT tz FROM params)) AT TIME ZONE (SELECT tz FROM params)
        AND (
          mb."totalCycles"                     IS DISTINCT FROM ds."totalCycles" OR
          mb."totalItems"                      IS DISTINCT FROM ds."totalItems" OR
          mb."badCycles"                       IS DISTINCT FROM ds."badCycles" OR
          mb."badItems"                        IS DISTINCT FROM ds."badItems" OR
          mb."idealCycleSeconds"               IS DISTINCT FROM ds."idealCycleSeconds" OR
          mb."totalCycleSeconds"               IS DISTINCT FROM ds."totalCycleSeconds" OR
          mb."runSeconds"                      IS DISTINCT FROM ds."runSeconds" OR
          mb."downSeconds"                     IS DISTINCT FROM ds."downSeconds" OR
          mb."plannedDownSeconds"              IS DISTINCT FROM ds."plannedDownSeconds" OR
          mb."unplannedDownSeconds"            IS DISTINCT FROM ds."unplannedDownSeconds" OR
          mb."expectedCycles"                  IS DISTINCT FROM ds."expectedCycles" OR
          mb."expectedItems"                   IS DISTINCT FROM ds."expectedItems" OR
          mb."elapsedExpectedCycles"           IS DISTINCT FROM ds."elapsedExpectedCycles" OR
          mb."elapsedExpectedItems"            IS DISTINCT FROM ds."elapsedExpectedItems" OR
          mb."elapsedPlannedProductionSeconds" IS DISTINCT FROM ds."elapsedPlannedProductionSeconds" OR
          mb."durationSeconds"                 IS DISTINCT FROM ds."durationSeconds"
        )
      RETURNING mb.*
    )
    SELECT "entityType", "entityId"::text, "entityName", path, granularity::text, "granularityName",
           "siteId"::text, "startTime", "durationSeconds", "shiftInstanceId"::text, "businessDate", "businessShift",
           "totalCycles", "goodCycles", "badCycles", "totalItems", "goodItems", "badItems",
           "expectedCycles", "expectedItems", "runSeconds", "downSeconds",
           "plannedDownSeconds", "unplannedDownSeconds", "plannedProductionSeconds",
           "idealCycleSeconds", "totalCycleSeconds",
           "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
           "currentStandardCycle"::float8 AS "currentStandardCycle",
           availability::float8 AS availability, performance::float8 AS performance,
           quality::float8 AS quality, oee::float8 AS oee,
           "currentJobId"::text, "currentJobName"
    FROM upd_shift
    UNION ALL
    SELECT "entityType", "entityId"::text, "entityName", path, granularity::text, "granularityName",
           "siteId"::text, "startTime", "durationSeconds", "shiftInstanceId"::text, "businessDate", "businessShift",
           "totalCycles", "goodCycles", "badCycles", "totalItems", "goodItems", "badItems",
           "expectedCycles", "expectedItems", "runSeconds", "downSeconds",
           "plannedDownSeconds", "unplannedDownSeconds", "plannedProductionSeconds",
           "idealCycleSeconds", "totalCycleSeconds",
           "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
           "currentStandardCycle"::float8 AS "currentStandardCycle",
           availability::float8 AS availability, performance::float8 AS performance,
           quality::float8 AS quality, oee::float8 AS oee,
           "currentJobId"::text, "currentJobName"
    FROM upd_day
  `;
  emitRows(rows);
}

// ── Parent rollup (WORKCENTER + SITE) ──────────────────────────

/**
 * Sum STATION-level bucket values → WORKCENTER and SITE parent buckets
 * for all granularities (HOUR, SHIFT, DAY) in a single SQL statement.
 * Covers current + previous hour to ensure completed hours get correct
 * final values before archival.
 *
 * The UPDATE is guarded by an IS DISTINCT FROM predicate so rows whose
 * summed values match the stored row are skipped — no write, no updatedAt
 * bump, no SSE emission. Without this guard, every parent row within the
 * 24-hour window (including completed prior shifts) re-emits every tick,
 * which looks like `shiftInstanceId` churn to downstream consumers.
 *
 * Called from a 5s tick in the worker process.
 */
export async function cascadeParentRollup(siteId: string, timestamp: Date): Promise<void> {
  const rows = await prisma.$queryRaw<BucketRow[]>`
    WITH RECURSIVE
    params AS (
      SELECT
        ${siteId}::uuid AS site_id,
        date_trunc('hour', ${timestamp}::timestamptz) AS hour_start,
        (SELECT COALESCE(timezone, 'UTC') FROM "Site" WHERE id = ${siteId}::uuid) AS tz
    ),
    all_stations AS (
      SELECT id AS station_id, "workcenterId" AS wc_id
      FROM "Station"
      WHERE "siteId" = (SELECT site_id FROM params)
        AND "deletedAt" IS NULL
    ),
    station_ancestors AS (
      SELECT s.station_id, s.wc_id AS ancestor_wc_id
      FROM all_stations s WHERE s.wc_id IS NOT NULL
      UNION ALL
      SELECT sa.station_id, w."parentId"
      FROM station_ancestors sa
      JOIN "Workcenter" w ON w.id = sa.ancestor_wc_id
      WHERE w."parentId" IS NOT NULL
    ),
    parent_sums AS (
      -- WORKCENTER: sum descendant station buckets
      SELECT 'WORKCENTER'::"BucketEntityType" AS et, sa.ancestor_wc_id AS eid,
             mb.granularity, mb."startTime",
             SUM(mb."totalCycles")::int AS "totalCycles",
             SUM(mb."badCycles")::int AS "badCycles",
             SUM(mb."totalItems")::int AS "totalItems",
             SUM(mb."badItems")::int AS "badItems",
             SUM(mb."idealCycleSeconds")::int AS "idealCycleSeconds",
             SUM(mb."totalCycleSeconds")::int AS "totalCycleSeconds",
             SUM(mb."runSeconds")::int AS "runSeconds",
             SUM(mb."downSeconds")::int AS "downSeconds",
             SUM(mb."plannedDownSeconds")::int AS "plannedDownSeconds",
             SUM(mb."unplannedDownSeconds")::int AS "unplannedDownSeconds",
             SUM(mb."expectedCycles")::int AS "expectedCycles",
             SUM(mb."expectedItems")::int AS "expectedItems",
             SUM(mb."elapsedExpectedCycles")::int AS "elapsedExpectedCycles",
             SUM(mb."elapsedExpectedItems")::int AS "elapsedExpectedItems",
             SUM(mb."elapsedPlannedProductionSeconds")::int AS "elapsedPlannedProductionSeconds"
      FROM station_ancestors sa
      JOIN "MetricBucket" mb ON mb."entityId" = sa.station_id
        AND mb."entityType" = 'STATION'::"BucketEntityType"
        AND mb."startTime" >= (SELECT hour_start FROM params) - INTERVAL '24 hours'
      GROUP BY sa.ancestor_wc_id, mb.granularity, mb."startTime"

      UNION ALL

      -- SITE: sum ALL station buckets (including those without workcenter)
      SELECT 'SITE'::"BucketEntityType" AS et, (SELECT site_id FROM params) AS eid,
             mb.granularity, mb."startTime",
             SUM(mb."totalCycles")::int,
             SUM(mb."badCycles")::int,
             SUM(mb."totalItems")::int,
             SUM(mb."badItems")::int,
             SUM(mb."idealCycleSeconds")::int,
             SUM(mb."totalCycleSeconds")::int,
             SUM(mb."runSeconds")::int,
             SUM(mb."downSeconds")::int,
             SUM(mb."plannedDownSeconds")::int,
             SUM(mb."unplannedDownSeconds")::int,
             SUM(mb."expectedCycles")::int,
             SUM(mb."expectedItems")::int,
             SUM(mb."elapsedExpectedCycles")::int,
             SUM(mb."elapsedExpectedItems")::int,
             SUM(mb."elapsedPlannedProductionSeconds")::int
      FROM all_stations s
      JOIN "MetricBucket" mb ON mb."entityId" = s.station_id
        AND mb."entityType" = 'STATION'::"BucketEntityType"
        AND mb."startTime" >= (SELECT hour_start FROM params) - INTERVAL '24 hours'
      GROUP BY mb.granularity, mb."startTime"
    ),
    upd_parents AS (
      UPDATE "MetricBucket" mb SET
        "totalCycles" = ps."totalCycles",
        "badCycles" = ps."badCycles",
        "totalItems" = ps."totalItems",
        "badItems" = ps."badItems",
        "idealCycleSeconds" = ps."idealCycleSeconds",
        "totalCycleSeconds" = ps."totalCycleSeconds",
        "runSeconds" = ps."runSeconds",
        "downSeconds" = ps."downSeconds",
        "plannedDownSeconds" = ps."plannedDownSeconds",
        "unplannedDownSeconds" = ps."unplannedDownSeconds",
        "expectedCycles" = ps."expectedCycles",
        "expectedItems" = ps."expectedItems",
        "elapsedExpectedCycles" = ps."elapsedExpectedCycles",
        "elapsedExpectedItems" = ps."elapsedExpectedItems",
        "elapsedPlannedProductionSeconds" = ps."elapsedPlannedProductionSeconds",
        "currentStandardCycle" = NULL,
        "currentJobId" = NULL,
        "currentJobName" = NULL,
        "updatedAt" = NOW()
      FROM parent_sums ps
      WHERE mb."entityType" = ps.et
        AND mb."entityId" = ps.eid
        AND mb.granularity = ps.granularity
        AND mb."startTime" = ps."startTime"
        AND (
          mb."totalCycles"                     IS DISTINCT FROM ps."totalCycles" OR
          mb."badCycles"                       IS DISTINCT FROM ps."badCycles" OR
          mb."totalItems"                      IS DISTINCT FROM ps."totalItems" OR
          mb."badItems"                        IS DISTINCT FROM ps."badItems" OR
          mb."idealCycleSeconds"               IS DISTINCT FROM ps."idealCycleSeconds" OR
          mb."totalCycleSeconds"               IS DISTINCT FROM ps."totalCycleSeconds" OR
          mb."runSeconds"                      IS DISTINCT FROM ps."runSeconds" OR
          mb."downSeconds"                     IS DISTINCT FROM ps."downSeconds" OR
          mb."plannedDownSeconds"              IS DISTINCT FROM ps."plannedDownSeconds" OR
          mb."unplannedDownSeconds"            IS DISTINCT FROM ps."unplannedDownSeconds" OR
          mb."expectedCycles"                  IS DISTINCT FROM ps."expectedCycles" OR
          mb."expectedItems"                   IS DISTINCT FROM ps."expectedItems" OR
          mb."elapsedExpectedCycles"           IS DISTINCT FROM ps."elapsedExpectedCycles" OR
          mb."elapsedExpectedItems"            IS DISTINCT FROM ps."elapsedExpectedItems" OR
          mb."elapsedPlannedProductionSeconds" IS DISTINCT FROM ps."elapsedPlannedProductionSeconds" OR
          mb."currentStandardCycle"            IS NOT NULL OR
          mb."currentJobId"                    IS NOT NULL OR
          mb."currentJobName"                  IS NOT NULL
        )
      RETURNING mb.*
    )
    SELECT "entityType", "entityId"::text, "entityName", path, granularity::text, "granularityName",
           "siteId"::text, "startTime", "durationSeconds", "shiftInstanceId"::text, "businessDate", "businessShift",
           "totalCycles", "goodCycles", "badCycles", "totalItems", "goodItems", "badItems",
           "expectedCycles", "expectedItems", "runSeconds", "downSeconds",
           "plannedDownSeconds", "unplannedDownSeconds", "plannedProductionSeconds",
           "idealCycleSeconds", "totalCycleSeconds",
           "elapsedExpectedCycles", "elapsedExpectedItems", "elapsedPlannedProductionSeconds",
           "currentStandardCycle"::float8 AS "currentStandardCycle",
           availability::float8 AS availability, performance::float8 AS performance,
           quality::float8 AS quality, oee::float8 AS oee,
           "currentJobId"::text, "currentJobName"
    FROM upd_parents
  `;

  emitRows(rows);
}
