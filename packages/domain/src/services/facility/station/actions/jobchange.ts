import { z } from "zod";
import prisma from "@rw/db";
import { recalcAll } from "../../../metrics/recalc.js";
import { ensureBuckets } from "../../../metrics/bucket.js";
import { jobEntityId } from "../../../metrics/cascade.js";
import { publishStationCurrentJobMetric, publishStationStandardCycleMetric } from "../state.js";
import type { StationActionDefinition } from "./types.js";

interface JobChangeInput {
  jobId?: string;
  timestamp?: Date;
}

const jobChangeInputSchema = z
  .object({
    jobId: z.string().uuid().optional(),
    timestamp: z.coerce.date().optional(),
  })
  .passthrough();

export const jobChangeAction: StationActionDefinition<JobChangeInput> = {
  key: "job.change",
  displayName: "Change Job",
  description: "Change the current job assigned to a station",
  inputSchema: jobChangeInputSchema,
  async execute(context, input) {
    const { stationId } = context;
    const newJobId = input.jobId ?? null;
    const timestamp = input.timestamp ?? new Date();

    const findJob = (id: string) =>
      prisma.job.findUnique({
        where: { id },
        select: {
          id: true,
          siteId: true,
          currentBlobId: true,
          currentBlob: {
            select: { standardCycle: true, name: true },
          },
        },
      });

    // Validate the new job before entering the transaction so we don't
    // hold the advisory lock while doing unrelated reads.
    let job: Awaited<ReturnType<typeof findJob>> = null;

    if (newJobId) {
      job = await findJob(newJobId);

      if (!job) {
        throw new Error(`Job not found: ${newJobId}`);
      }

      if (!job.currentBlobId) {
        throw new Error("Job has no current blob version");
      }
    }

    // Use a transaction with an advisory lock keyed on the station to
    // serialise concurrent job changes for the same station. This
    // prevents the race where two near-simultaneous executions both
    // read the old currentJobId, each close only one open log via
    // findFirst, and both create new logs — leaving two open entries.
    //
    // An advisory lock is preferred over SERIALIZABLE isolation because
    // it only blocks concurrent job changes for the *same* station and
    // avoids serialisation failures/retries.
    const result = await prisma.$transaction(async (tx) => {
      // Acquire a session-level advisory lock scoped to this station.
      // pg_advisory_xact_lock is automatically released at commit/rollback.
      // We hash the stationId UUID into a bigint key for the lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${stationId}))`;

      const station = await tx.station.findUnique({
        where: { id: stationId },
        select: {
          id: true,
          siteId: true,
          currentJobId: true,
        },
      });

      if (!station) {
        throw new Error(`Station not found: ${stationId}`);
      }

      if (job && job.siteId !== station.siteId) {
        throw new Error("Job and station must belong to the same site");
      }

      // ── Close ALL open job logs for this station ────────────────
      // Using updateMany ensures every open entry is closed, even if a
      // previous concurrent execution created one we haven't seen yet.
      // This is the core fix: findFirst + update was not atomic and
      // could miss rows created by a concurrent transaction.
      const closedLogs = await tx.stationJobLog.findMany({
        where: { stationId, endTime: null },
        select: { id: true, startTime: true },
      });

      if (closedLogs.length > 0) {
        await tx.stationJobLog.updateMany({
          where: { stationId, endTime: null },
          data: { endTime: timestamp },
        });

        if (closedLogs.length > 1) {
          console.warn(
            `[job.change] Closed ${closedLogs.length} overlapping open StationJobLog entries for station ${stationId}`,
          );
        }
      }

      // ── Set the new job on the station ──────────────────────────
      await tx.station.update({
        where: { id: stationId },
        data: { currentJobId: newJobId },
      });

      // ── Create new StationJobLog if assigning a job ─────────────
      if (newJobId && job) {
        const standardCycle = job.currentBlob?.standardCycle ?? null;

        await tx.stationJobLog.create({
          data: {
            stationId,
            jobId: newJobId,
            // biome-ignore lint/style/noNonNullAssertion: throws above (line 55-57) if job.currentBlobId is null; narrowing lost across closure
            jobBlobId: job.currentBlobId!,
            startTime: timestamp,
            standardCycle,
          },
        });
      }

      return { station, closedLogs };
    });

    const { station, closedLogs } = result;

    // ── Fire-and-forget side effects after the transaction commits ──
    // Recompute KPIs for each closed log's time range.
    for (const log of closedLogs) {
      recalcAll(stationId, station.siteId, log.startTime, timestamp).catch((err) => {
        console.error(`[job.change] Failed to recalc for closed job log ${log.id}:`, err);
      });
    }

    if (newJobId && job) {
      // Scaffold empty JOB metric buckets so they exist before the first
      // cycle. Fire-and-forget — bucket creation is best-effort and the
      // background worker will catch any misses.
      ensureBuckets({
        siteId: station.siteId,
        entityType: "JOB",
        entityId: jobEntityId(stationId, newJobId),
        entityName: job.currentBlob?.name ?? "",
        timestamp,
      }).catch((err) => {
        console.error(`[job.change] Failed to ensure JOB buckets for job ${newJobId}:`, err);
      });

      publishStationCurrentJobMetric(stationId, job.currentBlob?.name ?? null, timestamp).catch((err) => {
        console.error(`[job.change] publishStationCurrentJobMetric failed for station ${stationId}:`, err);
      });
      const standardCycleSeconds =
        job.currentBlob?.standardCycle != null ? Number(job.currentBlob.standardCycle) : null;
      publishStationStandardCycleMetric(stationId, standardCycleSeconds, timestamp).catch((err) => {
        console.error(`[job.change] publishStationStandardCycleMetric failed for station ${stationId}:`, err);
      });
    } else {
      publishStationCurrentJobMetric(stationId, null, timestamp).catch((err) => {
        console.error(`[job.change] publishStationCurrentJobMetric failed for station ${stationId}:`, err);
      });
      publishStationStandardCycleMetric(stationId, null, timestamp).catch((err) => {
        console.error(`[job.change] publishStationStandardCycleMetric failed for station ${stationId}:`, err);
      });
    }

    console.log("[STATION_EVENT_ACTION]", {
      action: "job.change",
      executionId: context.executionId,
      eventId: context.eventId,
      stationId,
      workspaceId: context.workspaceId,
      actionId: context.actionId,
      actionIndex: context.actionIndex,
      previousJobId: station.currentJobId,
      newJobId,
    });
  },
};
