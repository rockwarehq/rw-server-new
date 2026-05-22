import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import prisma from "@rw/db";
import * as shiftCommentService from "@rw/services/facility/shift/shift-comment";

// ============================================================================
// Shift Instance List (by site + business date + optional workcenter)
// ============================================================================

const shiftInstanceListInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
});

const shiftInstanceSelect = {
  id: true,
  shiftName: true,
  businessDate: true,
  startTime: true,
  endTime: true,
  workCenterId: true,
} as const;

export const shiftInstanceList = authRequired.input(shiftInstanceListInputSchema).handler(async ({ input }) => {
  const rows = await prisma.shiftInstance.findMany({
    where: {
      siteId: input.siteId,
      workCenterId: input.workCenterId,
      businessDate: new Date(input.businessDate),
    },
    orderBy: { startTime: "asc" },
    select: shiftInstanceSelect,
  });
  return rows;
});

// ============================================================================
// Current Shift Instance (shift containing the current UTC time)
// ============================================================================

const currentShiftInstanceInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid(),
});

export const currentShiftInstance = userOrDisplayRequired
  .input(currentShiftInstanceInputSchema)
  .handler(async ({ input }) => {
    const now = new Date();
    const row = await prisma.shiftInstance.findFirst({
      where: {
        siteId: input.siteId,
        workCenterId: input.workCenterId,
        startTime: { lte: now },
        endTime: { gte: now },
      },
      orderBy: { startTime: "desc" },
      select: shiftInstanceSelect,
    });
    return row;
  });

// ============================================================================
// Metric Bucket Log query (by shift instance + entity filters)
// ============================================================================

const metricBucketLogListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const metricBucketLogList = authRequired.input(metricBucketLogListInputSchema).handler(async ({ input }) => {
  // Get stations belonging to this workcenter
  const stations = await prisma.station.findMany({
    where: { siteId: input.siteId, workcenterId: input.workCenterId },
    select: { id: true, name: true },
  });

  const stationIds = stations.map((s) => s.id);

  const where = {
    siteId: input.siteId,
    shiftInstanceId: input.shiftInstanceId,
    granularity: "SHIFT" as const,
    OR: [
      { entityType: "WORKCENTER" as const, entityId: input.workCenterId },
      { entityType: "STATION" as const, entityId: { in: stationIds } },
    ],
  };

  const select = {
    id: true,
    entityType: true,
    entityId: true,
    entityName: true,
    granularity: true,
    granularityName: true,
    startTime: true,
    durationSeconds: true,
    shiftInstanceId: true,
    businessDate: true,
    businessShift: true,
    currentJobName: true,
    totalCycles: true,
    goodCycles: true,
    badCycles: true,
    totalItems: true,
    goodItems: true,
    badItems: true,
    runSeconds: true,
    downSeconds: true,
    plannedDownSeconds: true,
    unplannedDownSeconds: true,
    expectedCycles: true,
    expectedItems: true,
    idealCycleSeconds: true,
    totalCycleSeconds: true,
    elapsedPlannedProductionSeconds: true,
    availability: true,
    performance: true,
    quality: true,
    oee: true,
  } as const;

  const orderBy = [{ entityType: "asc" as const }, { entityName: "asc" as const }];

  // Try archived data first; fall back to live MetricBucket for current shifts
  const rows = await prisma.metricBucketLog.findMany({ where, orderBy, select });
  if (rows.length > 0) return rows;

  return prisma.metricBucket.findMany({ where, orderBy, select });
});

// ============================================================================
// Station Job Log query (jobs that ran on stations during a shift)
// ============================================================================

const stationJobLogListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const stationJobLogList = authRequired.input(stationJobLogListInputSchema).handler(async ({ input }) => {
  // Look up the shift instance for its time boundaries
  const shiftInstance = await prisma.shiftInstance.findUniqueOrThrow({
    where: { id: input.shiftInstanceId },
    select: { startTime: true, endTime: true },
  });

  // Get stations belonging to this workcenter
  const stations = await prisma.station.findMany({
    where: { siteId: input.siteId, workcenterId: input.workCenterId },
    select: { id: true },
  });

  const stationIds = stations.map((s) => s.id);

  // Query StationJobLog for any jobs overlapping the shift window
  const rows = await prisma.stationJobLog.findMany({
    where: {
      stationId: { in: stationIds },
      startTime: { lt: shiftInstance.endTime },
      OR: [{ endTime: { gt: shiftInstance.startTime } }, { endTime: null }],
    },
    orderBy: [{ stationId: "asc" }, { startTime: "asc" }],
    select: {
      id: true,
      stationId: true,
      startTime: true,
      endTime: true,
      standardCycle: true,
      job: { select: { currentBlob: { select: { name: true } } } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    stationId: r.stationId,
    startTime: r.startTime < shiftInstance.startTime ? shiftInstance.startTime : r.startTime,
    endTime: r.endTime == null || r.endTime > shiftInstance.endTime ? shiftInstance.endTime : r.endTime,
    standardCycle: r.standardCycle ? Number(r.standardCycle) : null,
    jobName: r.job.currentBlob?.name ?? null,
  }));
});

// ============================================================================
// Job metrics query (JOB-entity MetricBucketLog for a shift)
// ============================================================================

const jobMetricsListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const jobMetricsList = authRequired.input(jobMetricsListInputSchema).handler(async ({ input }) => {
  // Get stations in workcenter to build path filter
  const stations = await prisma.station.findMany({
    where: { siteId: input.siteId, workcenterId: input.workCenterId },
    select: { id: true },
  });

  const stationIds = stations.map((s) => s.id);

  // Query JOB-entity metric rows for this shift.
  // Path format: "site.{siteId}...station.{stationId}.job.{jobId}"
  // Filter to jobs under stations in this workcenter via path contains.
  const where = {
    siteId: input.siteId,
    shiftInstanceId: input.shiftInstanceId,
    entityType: "JOB" as const,
    granularity: "SHIFT" as const,
    OR: stationIds.map((sid) => ({
      path: { contains: `.station.${sid}.` },
    })),
  };

  const select = {
    id: true,
    entityId: true,
    entityName: true,
    path: true,
    totalCycles: true,
    goodCycles: true,
    badCycles: true,
    totalItems: true,
    goodItems: true,
    badItems: true,
    totalCycleSeconds: true,
    idealCycleSeconds: true,
    currentStandardCycle: true,
    runSeconds: true,
    downSeconds: true,
    plannedDownSeconds: true,
    unplannedDownSeconds: true,
    expectedItems: true,
    elapsedPlannedProductionSeconds: true,
    availability: true,
    performance: true,
    quality: true,
    oee: true,
  } as const;

  const orderBy = [{ entityName: "asc" as const }];

  // Try archived data first; fall back to live MetricBucket for current shifts
  let rows = await prisma.metricBucketLog.findMany({ where, orderBy, select });
  if (rows.length === 0) {
    rows = await prisma.metricBucket.findMany({ where, orderBy, select });
  }

  // Extract stationId from path and compute avg cycle time
  return rows.map((r) => {
    const stationMatch = r.path.match(/\.station\.([^.]+)\./);
    const avgCycleTimeSeconds = r.totalCycles > 0 ? Number(r.totalCycleSeconds) / r.totalCycles : null;

    return {
      id: r.id,
      jobId: r.entityId,
      jobName: r.entityName,
      stationId: stationMatch?.[1] ?? null,
      totalCycles: r.totalCycles,
      goodCycles: r.goodCycles,
      badCycles: r.badCycles,
      totalItems: r.totalItems,
      goodItems: r.goodItems,
      badItems: r.badItems,
      totalCycleSeconds: r.totalCycleSeconds,
      idealCycleSeconds: r.idealCycleSeconds,
      elapsedPlannedProductionSeconds: r.elapsedPlannedProductionSeconds,
      standardCycle: r.currentStandardCycle ? Number(r.currentStandardCycle) : null,
      avgCycleTimeSeconds,
      runSeconds: r.runSeconds,
      downSeconds: r.downSeconds,
      plannedDownSeconds: r.plannedDownSeconds,
      unplannedDownSeconds: r.unplannedDownSeconds,
      expectedItems: r.expectedItems,
      availability: r.availability,
      performance: r.performance,
      quality: r.quality,
      oee: r.oee,
    };
  });
});

// ============================================================================
// Downtime log query (DOWN state logs overlapping a shift)
// ============================================================================

const downtimeLogListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  stationId: z.uuid().optional(),
  workCenterId: z.uuid().optional(),
});

export const downtimeLogList = userOrDisplayRequired.input(downtimeLogListInputSchema).handler(async ({ input }) => {
  const shiftInstance = await prisma.shiftInstance.findUniqueOrThrow({
    where: { id: input.shiftInstanceId },
    select: { startTime: true, endTime: true },
  });

  // Resolve station IDs — single station or all in workcenter
  let stationFilter: string | { in: string[] };
  if (input.stationId) {
    stationFilter = input.stationId;
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    stationFilter = { in: stations.map((s) => s.id) };
  } else {
    return [];
  }

  const rows = await prisma.stationStateLog.findMany({
    where: {
      stationId: stationFilter,
      state: "DOWN",
      deletedAt: null,
      startTime: { lt: shiftInstance.endTime },
      OR: [{ endTime: { gt: shiftInstance.startTime } }, { endTime: null }],
    },
    orderBy: { startTime: "asc" },
    select: {
      id: true,
      stationId: true,
      startTime: true,
      endTime: true,
      statusReasonId: true,
      statusReason: { select: { id: true, name: true } },
    },
  });

  return rows.map((r) => {
    const clamped = r.startTime < shiftInstance.startTime || r.endTime == null || r.endTime > shiftInstance.endTime;
    return {
      id: r.id,
      stationId: r.stationId,
      startTime: r.startTime < shiftInstance.startTime ? shiftInstance.startTime : r.startTime,
      endTime: r.endTime == null || r.endTime > shiftInstance.endTime ? shiftInstance.endTime : r.endTime,
      // Include raw times when they differ from the shift-clamped values
      rawStartTime: clamped ? r.startTime : null,
      rawEndTime: clamped ? (r.endTime ?? null) : null,
      statusReasonId: r.statusReasonId,
      statusReasonName: r.statusReason?.name ?? null,
    };
  });
});

// ============================================================================
// Scrap / Disposition totals by reason (per station, for a shift)
// ============================================================================

const scrapByReasonListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const scrapByReasonList = userOrDisplayRequired
  .input(scrapByReasonListInputSchema)
  .handler(async ({ input }) => {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    const stationIds = stations.map((s) => s.id);
    if (stationIds.length === 0) return [];

    const groups = await prisma.itemDispositionLog.groupBy({
      by: ["stationId", "dispositionReasonId"],
      where: {
        siteId: input.siteId,
        shiftInstanceId: input.shiftInstanceId,
        stationId: { in: stationIds },
        deletedAt: null,
      },
      _sum: { quantity: true },
      _count: { _all: true },
    });

    const reasonIds = groups.map((g) => g.dispositionReasonId).filter((id): id is string => id != null);
    const reasons = reasonIds.length
      ? await prisma.itemDispositionReason.findMany({
          where: { id: { in: reasonIds } },
          select: { id: true, name: true },
        })
      : [];
    const reasonNameById = new Map(reasons.map((r) => [r.id, r.name]));

    return groups.map((g) => ({
      stationId: g.stationId,
      dispositionReasonId: g.dispositionReasonId,
      dispositionReasonName: g.dispositionReasonId ? (reasonNameById.get(g.dispositionReasonId) ?? null) : null,
      totalQuantity: g._sum.quantity ?? 0,
      entryCount: g._count._all,
    }));
  });

// ============================================================================
// Shift Comments (workcenter-overall + per-station, append-only thread)
// ============================================================================

const commentListInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
});

export const commentList = userOrDisplayRequired.input(commentListInputSchema).handler(async ({ input }) => {
  const result = await shiftCommentService.list({
    shiftInstanceId: input.shiftInstanceId,
    workcenterId: input.workCenterId,
  });
  return result.data;
});

const commentCreateInputSchema = z.object({
  siteId: z.uuid(),
  shiftInstanceId: z.uuid(),
  workCenterId: z.uuid(),
  stationId: z.uuid().nullable().optional(),
  text: z.string().min(1).max(5000),
});

export const commentCreate = authRequired.input(commentCreateInputSchema).handler(async ({ input, context }) => {
  const result = await shiftCommentService.create({
    siteId: input.siteId,
    shiftInstanceId: input.shiftInstanceId,
    workcenterId: input.workCenterId,
    stationId: input.stationId ?? null,
    text: input.text,
    createdById: context.iam.id,
  });
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_INSTANCE_NOT_FOUND" || code === "STATION_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "SITE_MISMATCH" || code === "WORKCENTER_MISMATCH") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

const commentUpdateInputSchema = z.object({
  id: z.uuid(),
  text: z.string().min(1).max(5000),
});

export const commentUpdate = authRequired.input(commentUpdateInputSchema).handler(async ({ input, context }) => {
  const result = await shiftCommentService.update(input.id, {
    text: input.text,
    actorId: context.iam.id,
  });
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_COMMENT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "FORBIDDEN") {
      throw new ORPCError("FORBIDDEN", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

const commentDeleteInputSchema = z.object({
  id: z.uuid(),
});

export const commentDelete = authRequired.input(commentDeleteInputSchema).handler(async ({ input, context }) => {
  const result = await shiftCommentService.remove(input.id, { actorId: context.iam.id });
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_COMMENT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "FORBIDDEN") {
      throw new ORPCError("FORBIDDEN", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return { success: true };
});
