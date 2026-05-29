import prisma from "@rw/db";
import { recalcAll } from "../../metrics/recalc.js";
import { ensureBuckets } from "../../metrics/bucket.js";
import { jobEntityId } from "../../metrics/cascade.js";
import { publishStationCurrentJobMetric, publishStationStandardCycleMetric } from "./state.js";

type ChangeJobResult =
  | {
      data: {
        stationId: string;
        stationName: string;
        previousJobId: string | null;
        previousJobName: string | null;
        newJobId: string | null;
        currentJobName: string | null;
        workCenterId: string | null;
        workCenterName: string | null;
      };
    }
  | { error: string; code: string };

/**
 * Change the current job assigned to a station.
 *
 * Extracted from the station event action `job.change` for direct
 * invocation from the oRPC layer (without going through the event system).
 *
 * Closes the current StationJobLog entry, updates Station.currentJobId,
 * and creates a new StationJobLog entry with snapshotted blob data.
 */
export async function changeJob(stationId: string, newJobId: string | null): Promise<ChangeJobResult> {
  const timestamp = new Date();

  // Validate the new job before entering the transaction.
  const findJob = (id: string) =>
    prisma.job.findUnique({
      where: { id },
      select: {
        id: true,
        siteId: true,
        deletedAt: true,
        currentBlobId: true,
        currentBlob: {
          select: { standardCycle: true, name: true },
        },
      },
    });

  let job: Awaited<ReturnType<typeof findJob>> = null;

  if (newJobId) {
    job = await findJob(newJobId);

    if (!job || job.deletedAt) {
      return { error: "Job not found", code: "JOB_NOT_FOUND" };
    }

    if (!job.currentBlobId) {
      return { error: "Job has no current blob version", code: "NO_CURRENT_BLOB" };
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${stationId}))`;

    const station = await tx.station.findUnique({
      where: { id: stationId },
      select: {
        id: true,
        name: true,
        siteId: true,
        currentJobId: true,
        workcenterId: true,
        workcenter: { select: { name: true } },
      },
    });

    if (!station) {
      return { error: "Station not found" as const, code: "STATION_NOT_FOUND" as const };
    }

    if (job && job.siteId !== station.siteId) {
      return { error: "Job and station must belong to the same site" as const, code: "SITE_MISMATCH" as const };
    }

    const previousJobId = station.currentJobId;

    // Close ALL open job logs for this station
    const openLogs = await tx.stationJobLog.findMany({
      where: { stationId, endTime: null },
      select: { id: true, startTime: true },
    });

    if (openLogs.length > 0) {
      await tx.stationJobLog.updateMany({
        where: { stationId, endTime: null },
        data: { endTime: timestamp },
      });

      if (openLogs.length > 1) {
        console.warn(
          `[changeJob] Closed ${openLogs.length} overlapping open StationJobLog entries for station ${stationId}`,
        );
      }
    }

    // Update station's current job
    await tx.station.update({
      where: { id: stationId },
      data: { currentJobId: newJobId },
    });

    // Create a new StationJobLog entry
    if (newJobId && job) {
      const standardCycle = job.currentBlob?.standardCycle ?? null;

      await tx.stationJobLog.create({
        data: {
          stationId,
          jobId: newJobId,
          // biome-ignore lint/style/noNonNullAssertion: returns NO_CURRENT_BLOB above (line 47-49) if job.currentBlobId is null; narrowing lost across closure
          jobBlobId: job.currentBlobId!,
          startTime: timestamp,
          standardCycle,
        },
      });
    }

    return { station, previousJobId, openLogs };
  });

  if ("error" in result) {
    // biome-ignore lint/style/noNonNullAssertion: discriminated union — `"error" in result` guarantees error/code are present, but TS doesn't narrow non-discriminated tuples
    return { error: result.error!, code: result.code! };
  }

  const { station, previousJobId, openLogs } = result;

  // Fire-and-forget side effects after the transaction commits
  for (const log of openLogs) {
    recalcAll(stationId, station.siteId, log.startTime, timestamp).catch((err) => {
      console.error(`[changeJob] Failed to recalc for closed job log ${log.id}:`, err);
    });
  }

  if (newJobId && job) {
    ensureBuckets({
      siteId: station.siteId,
      entityType: "JOB",
      entityId: jobEntityId(stationId, newJobId),
      entityName: job.currentBlob?.name ?? "",
      timestamp,
    }).catch((err) => {
      console.error(`[changeJob] Failed to ensure JOB buckets for job ${newJobId}:`, err);
    });

    publishStationCurrentJobMetric(stationId, job.currentBlob?.name ?? null, timestamp).catch((err) => {
      console.error(`[changeJob] publishStationCurrentJobMetric failed for station ${stationId}:`, err);
    });
    const standardCycleSeconds = job.currentBlob?.standardCycle != null ? Number(job.currentBlob.standardCycle) : null;
    publishStationStandardCycleMetric(stationId, standardCycleSeconds, timestamp).catch((err) => {
      console.error(`[changeJob] publishStationStandardCycleMetric failed for station ${stationId}:`, err);
    });
  } else {
    publishStationCurrentJobMetric(stationId, null, timestamp).catch((err) => {
      console.error(`[changeJob] publishStationCurrentJobMetric failed for station ${stationId}:`, err);
    });
    publishStationStandardCycleMetric(stationId, null, timestamp).catch((err) => {
      console.error(`[changeJob] publishStationStandardCycleMetric failed for station ${stationId}:`, err);
    });
  }

  // Resolve the previous job's display name (the new job's name is already loaded above). Used to
  // populate the job.changed automation event payload so messages can show names, not uuids.
  const previousJob = previousJobId
    ? await prisma.job.findUnique({ where: { id: previousJobId }, select: { currentBlob: { select: { name: true } } } })
    : null;

  return {
    data: {
      stationId,
      stationName: station.name,
      previousJobId,
      previousJobName: previousJob?.currentBlob?.name ?? null,
      newJobId,
      currentJobName: job?.currentBlob?.name ?? null,
      workCenterId: station.workcenterId,
      workCenterName: station.workcenter?.name ?? null,
    },
  };
}
