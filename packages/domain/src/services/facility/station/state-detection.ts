import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import {
  scheduleDetection as enqueueDetectionJob,
  cancelDetection as dequeueDetection,
} from "../../../queues/station-detection.js";

type TransactionClient = Prisma.TransactionClient;

/**
 * Result of {@link prepareDetection}: the BullMQ payload that
 * {@link enqueueDetection} consumes. `cancel: true` means there is no
 * detection to schedule and any existing timers should be dequeued.
 */
export type PreparedDetection =
  | { stationId: string; cancel: true }
  | { stationId: string; cancel: false; slowStartAfter: Date | null; downStartAfter: Date | null };

/**
 * DB-only half of detection scheduling. Reads the station/job blob
 * config and computes the slow/down fire times. Accepts a transaction
 * client so the reads can ride inside the cycle-complete transaction.
 */
export async function prepareDetection(
  client: TransactionClient | typeof prisma,
  stationId: string,
  jobId: string,
): Promise<PreparedDetection> {
  const [stationWithBlob, jobWithBlob] = await Promise.all([
    client.stationBlob.findFirst({
      where: {
        station: { id: stationId },
        currentOfStation: { isNot: null },
      },
      select: {
        slowDetect: true,
        slowDetectUnit: true,
        downtimeDetect: true,
        downtimeDetectUnit: true,
      },
    }),
    client.jobBlob.findFirst({
      where: {
        job: { id: jobId },
        currentOfJob: { isNot: null },
      },
      select: {
        standardCycle: true,
      },
    }),
  ]);

  const blob = stationWithBlob;
  const standardCycleSeconds = jobWithBlob?.standardCycle ? Number(jobWithBlob.standardCycle) : null;

  if (!blob || standardCycleSeconds == null || standardCycleSeconds <= 0) {
    return { stationId, cancel: true };
  }

  const now = Date.now();

  let slowStartAfter: Date | null = null;
  if (blob.slowDetect != null) {
    const slowFraction = Number(blob.slowDetect);
    if (slowFraction > 0) {
      const delayMs = standardCycleSeconds * (1 + slowFraction) * 1000;
      slowStartAfter = new Date(now + delayMs);
    }
  }

  let downStartAfter: Date | null = null;
  if (blob.downtimeDetect != null) {
    const downtimeSeconds = Number(blob.downtimeDetect);
    if (downtimeSeconds > 0) {
      const delayMs = (standardCycleSeconds + downtimeSeconds) * 1000;
      downStartAfter = new Date(now + delayMs);
    }
  }

  return { stationId, cancel: false, slowStartAfter, downStartAfter };
}

/**
 * BullMQ-only half of detection scheduling. No DB connection used —
 * fire after the cycle transaction commits so observers never see
 * detection enqueued for a cycle that rolled back.
 */
export async function enqueueDetection(prepared: PreparedDetection): Promise<void> {
  if (prepared.cancel) {
    await dequeueDetection(prepared.stationId);
    return;
  }
  await enqueueDetectionJob(prepared.stationId, prepared.slowStartAfter, prepared.downStartAfter);
}

/**
 * Calculate and schedule slow/downtime detection timers for a station.
 *
 * Backwards-compat wrapper. Use {@link prepareDetection} +
 * {@link enqueueDetection} when you want the DB read inside an existing
 * transaction and the BullMQ enqueue after commit.
 */
export async function scheduleDetection(stationId: string, jobId: string) {
  const prepared = await prepareDetection(prisma, stationId, jobId);
  await enqueueDetection(prepared);
}

/**
 * Cancel any pending detection timers for a station.
 */
export async function cancelDetection(stationId: string) {
  await dequeueDetection(stationId);
}
