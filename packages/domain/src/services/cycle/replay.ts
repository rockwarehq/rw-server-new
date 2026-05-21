// ── Replay reconciliation ────────────────────────────────────────
// Handles cycles from replayed (buffered) gateway events. During a
// connection outage the server's detection timers fire and falsely
// mark the station DOWN. When the gateway reconnects it replays
// missed events as a burst.
//
// Two-phase approach:
//
// HOT PATH (server process, per replayed cycle):
//   Insert cycle + inventory only — skip state transitions, detection
//   timers, and metric cascades. Track the replay window in Redis and
//   enqueue a debounced reconciliation job.
//
// RECONCILIATION (worker process, after debounce):
//   Fix the state log (delete false DOWN entries, create correct UP
//   entries), un-archive any MetricBucketLog rows that were archived
//   during the outage, and run recalcAll to rebuild all KPIs from
//   raw data.

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import prisma from "@rw/db";
import { recalcAll } from "../metrics/recalc.js";
import { scheduleDetection } from "../facility/station/state-detection.js";
import { MetricsContext } from "../metrics/context.js";
import { bullmqConfig } from "../../config.js";

// ── Constants ───────────────────────────────────────────────────

const REPLAY_WINDOW_PREFIX = "replay-window:";
const REPLAY_WINDOW_TTL_SECONDS = 3600; // 1 hour safety net
export const REPLAY_RECONCILE_QUEUE = "replay-reconcile";
const RECONCILE_DEBOUNCE_MS = 10_000; // 10 seconds

// ── Redis client (lazy singleton) ───────────────────────────────

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    redisClient = new Redis(url);
  }
  return redisClient;
}

// ── BullMQ queue (lazy singleton) ───────────────────────────────

let reconcileQueue: Queue | null = null;

function getReconcileQueue(): Queue {
  if (!reconcileQueue) {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    reconcileQueue = new Queue(REPLAY_RECONCILE_QUEUE, {
      connection: { url, connectTimeout: bullmqConfig.connectTimeout },
    });
  }
  return reconcileQueue;
}

// ── Lua script for atomic replay window update ──────────────────

const UPDATE_WINDOW_LUA = `
local key = KEYS[1]
local ts = ARGV[1]
local siteId = ARGV[2]
local ttl = tonumber(ARGV[3])

local existing = redis.call('GET', key)
if existing then
  local data = cjson.decode(existing)
  if ts < data.minTimestamp then
    data.minTimestamp = ts
  end
  if ts > data.maxTimestamp then
    data.maxTimestamp = ts
  end
  data.cycleCount = data.cycleCount + 1
  redis.call('SET', key, cjson.encode(data), 'EX', ttl)
else
  local data = { minTimestamp = ts, maxTimestamp = ts, siteId = siteId, cycleCount = 1 }
  redis.call('SET', key, cjson.encode(data), 'EX', ttl)
end
return 1
`;

// ── Public API (server process) ─────────────────────────────────

interface ReplayWindow {
  minTimestamp: string;
  maxTimestamp: string;
  siteId: string;
  cycleCount: number;
}

/**
 * Track a replayed cycle and debounce reconciliation.
 *
 * Called from cycle.ts on the hot path for every replayed cycle.
 * Updates the replay window in Redis and enqueues (or re-debounces)
 * a reconciliation job.
 */
export async function trackReplayedCycle(stationId: string, siteId: string, timestamp: Date): Promise<void> {
  const redis = getRedis();
  const key = `${REPLAY_WINDOW_PREFIX}${stationId}`;
  const ts = timestamp.toISOString();

  // Atomic min/max update via Lua
  await redis.eval(UPDATE_WINDOW_LUA, 1, key, ts, siteId, REPLAY_WINDOW_TTL_SECONDS);

  // Debounce reconciliation: remove existing job, re-add with delay
  const queue = getReconcileQueue();
  const jobId = `replay-${stationId}`;

  await queue.remove(jobId);
  await queue.add(
    "reconcile",
    { stationId },
    {
      jobId,
      delay: RECONCILE_DEBOUNCE_MS,
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
}

// ── Reconciliation (worker process) ─────────────────────────────

/**
 * Reconcile a station after a replay burst.
 *
 * 1. Read + delete the replay window from Redis
 * 2. Fix state log entries (delete false DOWN, create correct UP)
 * 3. Schedule detection from latest cycle
 * 4. Un-archive affected MetricBucketLog entries
 * 5. Recompute all KPIs via recalcAll
 */
export async function reconcileReplay(stationId: string): Promise<void> {
  const redis = getRedis();
  const key = `${REPLAY_WINDOW_PREFIX}${stationId}`;

  // Atomic read + delete
  const raw = await redis.getdel(key);
  if (!raw) {
    console.log(`[replay] No replay window found for station ${stationId}, skipping`);
    return;
  }

  const window: ReplayWindow = JSON.parse(raw);
  const minTs = new Date(window.minTimestamp);
  const maxTs = new Date(window.maxTimestamp);
  const siteId = window.siteId;

  console.log(
    `[replay] Reconciling station ${stationId}: ` +
      `${window.cycleCount} replayed cycles from ${window.minTimestamp} to ${window.maxTimestamp}`,
  );

  const t0 = Date.now();

  // Fix state log entries within a transaction (advisory lock serializes
  // with concurrent cycle completions and detection transitions)
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${stationId}))::text`;
    await fixStateEntries(tx, stationId, minTs, maxTs);
  });

  // Resolve current job for detection scheduling
  const jobRows = await prisma.$queryRaw<Array<{ currentJobId: string | null }>>`
    SELECT "currentJobId" FROM "Station" WHERE id = ${stationId}::uuid
  `;
  const currentJobId = jobRows[0]?.currentJobId;

  // Re-establish detection timers from latest cycle
  if (currentJobId) {
    await scheduleDetection(stationId, currentJobId).catch((err) => {
      console.error(`[replay] Failed to schedule detection for station ${stationId}:`, err);
    });
  }

  // Un-archive any MetricBucketLog entries that were archived during the outage
  await unarchiveAffectedBuckets(stationId, siteId, minTs, maxTs);

  // Rebuild all KPIs from raw Cycle + StationStateLog data
  const ctx = new MetricsContext();
  await recalcAll(stationId, siteId, minTs, maxTs, ctx);

  const elapsed = Date.now() - t0;
  console.log(`[replay] Reconciliation complete for station ${stationId} in ${elapsed}ms`);
}

// ── State log correction ────────────────────────────────────────

type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Fix state log entries contaminated by false detection during a
 * gateway disconnection.
 *
 * Soft-deletes all state entries that overlap the replay window
 * (including the false DOWN entry created by transitionToDown which
 * converts UP→DOWN in-place, preserving the original startTime).
 *
 * Creates two replacement entries:
 * - A closed UP entry spanning [minTs, maxTs] (the station was producing)
 * - An open UP entry starting at maxTs (station is now live)
 */
async function fixStateEntries(tx: TransactionClient, stationId: string, minTs: Date, maxTs: Date): Promise<void> {
  // Soft-delete all state entries that overlap the replay window
  // OR are currently open (the false DOWN from detection timer).
  // This catches:
  //   - The false DOWN entry (startTime ≈ detection fire time)
  //   - Any SLOW transitions during disconnect
  //   - The currently open entry (regardless of startTime)
  const deleted = await tx.$executeRaw`
    UPDATE "StationStateLog"
    SET "deletedAt" = NOW(), "updatedAt" = NOW()
    WHERE "stationId" = ${stationId}
      AND "deletedAt" IS NULL
      AND (
        ("startTime" <= ${maxTs} AND ("endTime" >= ${minTs} OR "endTime" IS NULL))
        OR "endTime" IS NULL
      )
  `;

  console.log(`[replay] Soft-deleted ${deleted} state entries for station ${stationId}`);

  // Look up the active job blob for the new state entries
  const activeJob = await tx.stationJobLog.findFirst({
    where: { stationId, endTime: null },
    select: { jobBlobId: true },
    orderBy: { startTime: "desc" },
  });
  const jobBlobId = activeJob?.jobBlobId ?? null;

  // Create a closed UP entry spanning the replay window
  const blockId = randomUUID();
  await tx.$executeRaw`
    INSERT INTO "StationStateLog"
      (id, "stationId", "startTime", "endTime", state, status, "blockId", "jobBlobId", "createdAt", "updatedAt")
    VALUES
      (gen_random_uuid(), ${stationId}, ${minTs}, ${maxTs}, 'UP', 'UP', ${blockId}, ${jobBlobId}, NOW(), NOW())
  `;

  // Create an open UP entry from maxTs onward (station is live)
  await tx.$executeRaw`
    INSERT INTO "StationStateLog"
      (id, "stationId", "startTime", state, status, "blockId", "jobBlobId", "createdAt", "updatedAt")
    VALUES
      (gen_random_uuid(), ${stationId}, ${maxTs}, 'UP', 'UP', ${blockId}, ${jobBlobId}, NOW(), NOW())
  `;
}

// ── Un-archive affected metric buckets ──────────────────────────

/**
 * Move archived MetricBucketLog entries back to MetricBucket so that
 * recalcAll can recompute them. The normal 60s archive worker will
 * re-archive them once their time windows have elapsed.
 */
async function unarchiveAffectedBuckets(stationId: string, siteId: string, minTs: Date, maxTs: Date): Promise<void> {
  // Find all entity IDs that need un-archiving:
  // the station itself, its workcenter (if any), the site, and the current job
  const entityIds = [stationId, siteId];

  const station = await prisma.$queryRaw<Array<{ workcenterId: string | null; currentJobId: string | null }>>`
    SELECT "workcenterId", "currentJobId" FROM "Station" WHERE id = ${stationId}::uuid
  `;
  if (station[0]?.workcenterId) entityIds.push(station[0].workcenterId);
  if (station[0]?.currentJobId) entityIds.push(station[0].currentJobId);

  // Find archived buckets that overlap the replay window.
  // A bucket overlaps if: startTime < maxTs AND startTime + durationSeconds > minTs
  const candidates = await prisma.metricBucketLog.findMany({
    where: {
      siteId,
      entityId: { in: entityIds },
      startTime: { lt: maxTs },
    },
  });

  const minTsMs = minTs.getTime();
  const toRestore = candidates.filter((b) => {
    const endMs = b.startTime.getTime() + b.durationSeconds * 1000;
    return endMs > minTsMs;
  });

  if (toRestore.length === 0) return;

  console.log(`[replay] Un-archiving ${toRestore.length} bucket(s) for station ${stationId}`);

  // Insert back into MetricBucket (skip if already exists)
  await prisma.metricBucket.createMany({
    data: toRestore.map((row) => ({
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
    })),
    skipDuplicates: true,
  });

  // Delete from archive
  await prisma.metricBucketLog.deleteMany({
    where: { id: { in: toRestore.map((b) => b.id) } },
  });
}

// ── Startup recovery ────────────────────────────────────────────

/**
 * Re-enqueue reconciliation jobs for any replay windows that were
 * orphaned by a server restart. Called from worker.ts on startup.
 */
export async function recoverReplayWindows(): Promise<void> {
  const redis = getRedis();
  const stationIds: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${REPLAY_WINDOW_PREFIX}*`, "COUNT", 100);
    cursor = nextCursor;

    for (const key of keys) {
      stationIds.push(key.slice(REPLAY_WINDOW_PREFIX.length));
    }
  } while (cursor !== "0");

  if (stationIds.length === 0) return;

  console.log(`[replay] Recovering ${stationIds.length} replay window(s) from Redis`);

  const queue = getReconcileQueue();
  for (const stationId of stationIds) {
    const jobId = `replay-${stationId}`;
    const existing = await queue.getJob(jobId);
    if (!existing) {
      await queue.add(
        "reconcile",
        { stationId },
        {
          jobId,
          delay: RECONCILE_DEBOUNCE_MS,
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      console.log(`[replay] Re-enqueued reconciliation for station ${stationId}`);
    }
  }
}

// ── Cleanup ─────────────────────────────────────────────────────

export async function cleanup(): Promise<void> {
  if (redisClient) {
    redisClient.disconnect();
    redisClient = null;
  }
  if (reconcileQueue) {
    await reconcileQueue.close();
    reconcileQueue = null;
  }
}
