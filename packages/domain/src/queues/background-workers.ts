// Worker registrations for queues whose worker bodies are co-located here.
//
// Workers exported from this module:
//   - startStaleGatewayCheck      (lives in apps/api)
//   - startMetricBucketEnsure     (lives in apps/workers/rollups)
//   - startStationEventWorker     (lives in apps/workers/processor-consumer)
//
// Producers / helpers exported and called from elsewhere:
//   - scheduleNextEnsureTick      (called by shift-change worker, both lives in rollups)
//   - runMetricBucketEnsureTick   (the tick body; also exported for direct invocation)
//
// Each `start*` is self-contained: opens its own Worker + Queue, leaves the
// others alone. apps/api boots only `startStaleGatewayCheck`; apps/workers
// boots the other two via their respective worker modes.

import { Queue, Worker } from "bullmq";
import { bullmqConfig } from "../config.js";
import prisma from "@rw/db";
import { runStationEventExecution, STATION_EVENT_EXECUTION_QUEUE } from "../services/facility/station/execution.js";
import { ensureBuckets, ensureBucketsBatch } from "../services/metrics/bucket.js";
import { archiveOldBuckets } from "../services/metrics/archive.js";
import { materializeShiftInstances } from "../services/facility/shift/materialize.js";
import { MetricsContext } from "../services/metrics/context.js";
import { jobEntityId } from "../services/metrics/cascade.js";
import { scheduleShiftChanges } from "./shift-change.js";
import { flushAllExpiredShiftUsage } from "../services/inventory/material-shift-flush.js";

const REDIS_URL = process.env.REDIS_URL;

const ENSURE_TICK_JOB_ID = "ensure-metric-buckets-next";
const ENSURE_TICK_INTERVAL_MS = 60_000;

let staleGatewayWorker: Worker | null = null;
let staleGatewayQueue: Queue | null = null;
let stationEventExecutionWorker: Worker | null = null;
let bucketEnsureWorker: Worker | null = null;
let bucketEnsureQueue: Queue | null = null;

function bullmqConnection() {
  if (!REDIS_URL) return null;
  return { url: REDIS_URL, connectTimeout: bullmqConfig.connectTimeout };
}

// ────────────────────────────────────────────────────────────────
// stale-gateway-check — apps/api
// ────────────────────────────────────────────────────────────────

export async function startStaleGatewayCheck(): Promise<void> {
  if (staleGatewayWorker) return;

  const connection = bullmqConnection();
  if (!connection) {
    console.log("[stale-gateway-check] REDIS_URL not set, skipping");
    return;
  }

  staleGatewayWorker = new Worker(
    "stale-gateway-check",
    async () => {
      const cutoff = new Date(Date.now() - 60 * 1000);
      const result = await prisma.gateway.updateMany({
        where: { status: "ONLINE", lastHeartbeat: { lt: cutoff } },
        data: { status: "OFFLINE" },
      });
      if (result.count > 0) {
        console.log(`Marked ${result.count} gateway(s) as OFFLINE`);
      }
      return { marked: result.count };
    },
    {
      connection,
      stalledInterval: bullmqConfig.stalledInterval,
      drainDelay: bullmqConfig.drainDelay,
    },
  );

  staleGatewayWorker.on("completed", (job, result) => {
    console.log(`Job ${job.id} completed`, result);
  });
  staleGatewayWorker.on("failed", (job, err) => {
    console.error(`Job ${job?.id} failed`, err);
  });

  staleGatewayQueue = new Queue("stale-gateway-check", { connection });
  await staleGatewayQueue.upsertJobScheduler(
    "check-stale-gateways",
    { every: 30000 },
    { name: "check-stale-gateways", opts: { removeOnComplete: true, removeOnFail: { count: 10 } } },
  );

  console.log("[stale-gateway-check] started");
}

export async function stopStaleGatewayCheck(): Promise<void> {
  await Promise.all([staleGatewayWorker?.close(), staleGatewayQueue?.close()]);
  staleGatewayWorker = null;
  staleGatewayQueue = null;
}

// ────────────────────────────────────────────────────────────────
// metric-bucket-ensure — apps/workers/rollups
// ────────────────────────────────────────────────────────────────

export async function startMetricBucketEnsure(): Promise<void> {
  if (bucketEnsureWorker) return;

  const connection = bullmqConnection();
  if (!connection) {
    console.log("[metric-bucket-ensure] REDIS_URL not set, skipping");
    return;
  }

  // Self-chaining delayed job (~60s). Uses delayed jobs (not a repeating
  // scheduler) so the shift-change worker can preempt the next tick by
  // re-adding with delay: 0.
  bucketEnsureWorker = new Worker(
    "metric-bucket-ensure",
    async () => {
      try {
        return await runMetricBucketEnsureTick();
      } finally {
        await scheduleNextEnsureTick();
      }
    },
    {
      connection,
      stalledInterval: bullmqConfig.stalledInterval,
      drainDelay: bullmqConfig.drainDelay,
    },
  );

  bucketEnsureWorker.on("failed", (job, err) => {
    console.error(`[metric-bucket-ensure] Bucket ensure job ${job?.id} failed`, err);
  });

  bucketEnsureQueue = new Queue("metric-bucket-ensure", { connection });

  // Seed the first tick. Deterministic job ID makes this a no-op if another
  // instance has already seeded — safe under horizontal scaling.
  await bucketEnsureQueue.add(
    "ensure-metric-buckets",
    {},
    { jobId: ENSURE_TICK_JOB_ID, delay: 0, removeOnComplete: true, removeOnFail: { count: 10 } },
  );

  console.log("[metric-bucket-ensure] started (self-chaining, ~60s)");

  // Startup sweep: flush any expired-shift staging rows that the cycle-close
  // lazy flush + shift-change worker missed while the process was down.
  // Fire-and-forget so boot isn't blocked on it.
  flushAllExpiredShiftUsage()
    .then((results) => {
      const total = results.reduce((acc, r) => acc + r.flushedRows, 0);
      if (total > 0) {
        console.log(
          `[metric-bucket-ensure] startup sweep flushed ${total} staging row(s) across ${results.length} shift(s)`,
        );
      }
    })
    .catch((err) => console.error("[metric-bucket-ensure] startup material-shift flush failed:", err));
}

export async function stopMetricBucketEnsure(): Promise<void> {
  await Promise.all([bucketEnsureWorker?.close(), bucketEnsureQueue?.close()]);
  bucketEnsureWorker = null;
  bucketEnsureQueue = null;
}

// ── Tick body — extracted so the shift-change worker can call it directly ──

export async function runMetricBucketEnsureTick(): Promise<{ checked: number; archived: number }> {
  const now = new Date();
  const ctx = new MetricsContext();

  try {
    const { created, candidates } = await materializeShiftInstances();
    if (created > 0) {
      console.log(`[metric-bucket-ensure] Materialized ${created} shift instance(s)`);
    }

    const nowMs = now.getTime();
    const nextByScope = new Map<string, { time: Date; scopeKey: string }>();
    for (const c of candidates) {
      const scopeKey = c.workCenterId ? `wc-${c.workCenterId}` : `site-${c.siteId}`;
      for (const t of [c.startTime, c.endTime]) {
        if (t.getTime() <= nowMs) continue;
        const existing = nextByScope.get(scopeKey);
        if (!existing || t.getTime() < existing.time.getTime()) {
          nextByScope.set(scopeKey, { time: t, scopeKey });
        }
      }
    }
    if (nextByScope.size > 0) {
      await scheduleShiftChanges([...nextByScope.values()]);
    }
  } catch (err) {
    console.error("[metric-bucket-ensure] Failed to materialize shift instances:", err);
  }

  try {
    const stationsNeedingLog = await prisma.$queryRaw<
      Array<{
        stationId: string;
        siteId: string;
        jobId: string;
        jobBlobId: string;
        standardCycle: number | null;
        jobName: string;
      }>
    >`
      SELECT s.id AS "stationId", s."siteId", s."currentJobId" AS "jobId",
             j."currentBlobId" AS "jobBlobId", jb."standardCycle"::float8 AS "standardCycle",
             COALESCE(jb.name, '') AS "jobName"
      FROM "Station" s
      JOIN "Job" j ON j.id = s."currentJobId"
      LEFT JOIN "JobBlob" jb ON jb.id = j."currentBlobId"
      WHERE s."currentJobId" IS NOT NULL
        AND s."deletedAt" IS NULL
        AND j."currentBlobId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "StationJobLog" sjl
          WHERE sjl."stationId" = s.id AND sjl."endTime" IS NULL
        )
    `;

    for (const station of stationsNeedingLog) {
      await prisma.$executeRaw`
        INSERT INTO "StationJobLog" (id, "stationId", "jobId", "jobBlobId", "startTime", "standardCycle", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), ${station.stationId}::uuid, ${station.jobId}::uuid, ${station.jobBlobId}::uuid, ${now}, ${station.standardCycle}, NOW(), NOW())
      `;
      console.log(
        `[metric-bucket-ensure] Reconciled missing StationJobLog for station ${station.stationId}, job ${station.jobId}`,
      );

      await ensureBuckets(
        {
          siteId: station.siteId,
          entityType: "JOB",
          entityId: jobEntityId(station.stationId, station.jobId),
          entityName: station.jobName,
          timestamp: now,
        },
        ctx,
      );
    }
  } catch (err) {
    console.error("[metric-bucket-ensure] Failed to reconcile StationJobLog entries:", err);
  }

  const allStations = await prisma.$queryRaw<Array<{ entityId: string; siteId: string; entityName: string }>>`
    SELECT s.id AS "entityId", s."siteId", s.name AS "entityName"
    FROM "Station" s
    WHERE s."deletedAt" IS NULL
  `;

  const stationInputs = allStations.map((s) => ({
    siteId: s.siteId,
    entityType: "STATION" as const,
    entityId: s.entityId,
    entityName: s.entityName,
    timestamp: now,
  }));

  if (stationInputs.length > 0) {
    await ensureBucketsBatch(stationInputs, ctx);
  }

  const activeEntities = await prisma.$queryRaw<Array<{ entityType: string; entityId: string; siteId: string }>>`
    SELECT DISTINCT "entityType", "entityId", "siteId" FROM "MetricBucket"
    WHERE "entityType" != 'STATION'
  `;

  const ensureInputs = activeEntities.map((entity) => ({
    siteId: entity.siteId,
    entityType: entity.entityType as "STATION" | "WORKCENTER" | "SITE" | "JOB",
    entityId: entity.entityId,
    timestamp: now,
  }));

  await ensureBucketsBatch(ensureInputs, ctx);

  let archived = 0;
  try {
    archived = await archiveOldBuckets(ctx);
  } catch (err) {
    console.error("[metric-bucket-ensure] Failed to archive old buckets:", err);
  }

  try {
    const flushed = await flushAllExpiredShiftUsage();
    const total = flushed.reduce((acc, r) => acc + r.flushedRows, 0);
    if (total > 0) {
      console.log(
        `[metric-bucket-ensure] minute-tick flushed ${total} staging row(s) across ${flushed.length} shift(s)`,
      );
    }
  } catch (err) {
    console.error("[metric-bucket-ensure] Failed to flush expired shift usage:", err);
  }

  return { checked: activeEntities.length, archived };
}

/**
 * Schedule the next metric-bucket-ensure tick. Used by the shift-change
 * worker (with delayMs=0) to preempt the next tick after publishing live
 * events. Both callers live in the same node process (rollups), so this is
 * a direct in-process function call rather than a cross-process enqueue.
 */
export async function scheduleNextEnsureTick(delayMs = ENSURE_TICK_INTERVAL_MS): Promise<void> {
  if (!bucketEnsureQueue) return;
  try {
    await bucketEnsureQueue.remove(ENSURE_TICK_JOB_ID);
  } catch {
    // Job may not exist or may be active — both are fine
  }
  await bucketEnsureQueue.add(
    "ensure-metric-buckets",
    {},
    { jobId: ENSURE_TICK_JOB_ID, delay: delayMs, removeOnComplete: true, removeOnFail: { count: 10 } },
  );
}

// ────────────────────────────────────────────────────────────────
// station-event-execution — apps/workers/processor-consumer
// ────────────────────────────────────────────────────────────────

export async function startStationEventWorker(): Promise<void> {
  if (stationEventExecutionWorker) return;

  const connection = bullmqConnection();
  if (!connection) {
    console.log("[station-event-execution] REDIS_URL not set, skipping");
    return;
  }

  stationEventExecutionWorker = new Worker(
    STATION_EVENT_EXECUTION_QUEUE,
    async (job) => {
      const executionId = job.data.executionId as string | undefined;
      if (!executionId) {
        throw new Error("executionId is required");
      }
      const result = await runStationEventExecution(executionId);
      if ("error" in result) {
        throw new Error(result.error);
      }
      return result.data;
    },
    {
      connection,
      concurrency: 10,
      stalledInterval: bullmqConfig.stalledInterval,
      drainDelay: bullmqConfig.drainDelay,
    },
  );

  stationEventExecutionWorker.on("completed", (job, result) => {
    console.log(`Station event job ${job.id} completed`, result);
  });
  stationEventExecutionWorker.on("failed", (job, err) => {
    console.error(`Station event job ${job?.id} failed`, err);
  });

  console.log("[station-event-execution] started (concurrency 10)");
}

export async function stopStationEventWorker(): Promise<void> {
  await stationEventExecutionWorker?.close();
  stationEventExecutionWorker = null;
}
