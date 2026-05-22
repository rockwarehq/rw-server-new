/**
 * Log search endpoints — paginated, filterable queries for historical log viewers.
 */

import { z } from "zod";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import {
  queryFilterSchema,
  toPrismaWhere,
  toRowFilter,
  type FieldAllowlist,
} from "@rw/services/lib/query-filter/index";
import type { QueryFilter, QueryRule } from "@rw/services/lib/query-filter/types";

// ---------------------------------------------------------------------------
// Field allowlists — only these fields can be queried dynamically.
// ---------------------------------------------------------------------------

const METRIC_BUCKET_QUERYABLE_FIELDS: FieldAllowlist = {
  entityName: { column: "entityName", type: "string" },
  entityType: { column: "entityType", type: "string" },
  businessShift: { column: "businessShift", type: "string" },
  currentJobName: { column: "currentJobName", type: "string" },
  totalCycles: { column: "totalCycles", type: "number" },
  goodCycles: { column: "goodCycles", type: "number" },
  badCycles: { column: "badCycles", type: "number" },
  totalItems: { column: "totalItems", type: "number" },
  goodItems: { column: "goodItems", type: "number" },
  badItems: { column: "badItems", type: "number" },
  runSeconds: { column: "runSeconds", type: "number" },
  downSeconds: { column: "downSeconds", type: "number" },
  availability: { column: "availability", type: "number" },
  performance: { column: "performance", type: "number" },
  quality: { column: "quality", type: "number" },
  oee: { column: "oee", type: "number" },
};

const DISPOSITION_LOG_QUERYABLE_FIELDS: FieldAllowlist = {
  stationId: { column: "stationId", type: "uuid" },
  stationName: { column: "station.name", type: "string" },
  quantity: { column: "quantity", type: "number" },
  dispositionName: { column: "itemDisposition.name", type: "string" },
  reasonName: { column: "dispositionReason.name", type: "string" },
  productName: { column: "productBlob.name", type: "string" },
  productSku: { column: "productBlob.sku", type: "string" },
  toolName: { column: "toolBlob.name", type: "string" },
  cavityName: { column: "toolCavityBlob.name", type: "string" },
  shiftName: { column: "shiftInstance.shiftName", type: "string" },
};

const LOGON_LOG_QUERYABLE_FIELDS: FieldAllowlist = {
  stationId: { column: "stationId", type: "uuid" },
  stationName: { column: "station.name", type: "string" },
  displayName: { column: "display.name", type: "string" },
  employeeNumber: { column: "employee.employeeNumber", type: "string" },
  logonMethod: { column: "logonMethod", type: "string" },
  shiftName: { column: "shiftInstance.shiftName", type: "string" },
};

/** Downtime rows are computed in JS (shift-clamped), so we filter in-memory. */
const DOWNTIME_QUERYABLE_FIELDS: FieldAllowlist = {
  stationId: { column: "stationId", type: "uuid" },
  stationName: { column: "stationName", type: "string" },
  shiftName: { column: "shiftName", type: "string" },
  durationSeconds: { column: "durationSeconds", type: "number" },
  statusReasonId: { column: "statusReasonId", type: "uuid" },
  statusReasonName: { column: "statusReasonName", type: "string" },
  isPlannedDown: { column: "isPlannedDown", type: "boolean" },
  categoryName: { column: "categoryName", type: "string" },
  startTime: { column: "startTime", type: "datetime" },
  endTime: { column: "endTime", type: "datetime" },
  jobName: { column: "jobName", type: "string" },
};

// ============================================================================
// Metric Bucket Log search
// ============================================================================

const metricBucketLogSearchInputSchema = z.object({
  siteId: z.uuid(),
  entityType: z.enum(["STATION", "WORKCENTER", "JOB"]).optional(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  shiftInstanceId: z.uuid().optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const metricBucketLogSearch = userOrDisplayRequired
  .input(metricBucketLogSearchInputSchema)
  .handler(async ({ input }) => {
    const where: Record<string, unknown> = {
      siteId: input.siteId,
      granularity: "SHIFT",
    };

    if (input.entityType) {
      where.entityType = input.entityType;
    }

    if (input.shiftInstanceId) {
      where.shiftInstanceId = input.shiftInstanceId;
    }

    // Filter by station directly, or by all stations in a workcenter
    if (input.stationId) {
      if (input.entityType === "JOB") {
        where.path = { contains: `.station.${input.stationId}.` };
      } else {
        where.entityType = "STATION";
        where.entityId = input.stationId;
      }
    } else if (input.workCenterId) {
      const stations = await prisma.station.findMany({
        where: { siteId: input.siteId, workcenterId: input.workCenterId },
        select: { id: true },
      });
      const stationIds = stations.map((s) => s.id);

      if (input.entityType === "STATION") {
        where.entityId = { in: stationIds };
      } else if (input.entityType === "JOB") {
        // JOB buckets are scoped to stations via the path field
        where.OR = stationIds.map((sid) => ({
          path: { contains: `.station.${sid}.` },
        }));
      } else {
        where.OR = [
          { entityType: "WORKCENTER", entityId: input.workCenterId },
          { entityType: "STATION", entityId: { in: stationIds } },
        ];
        delete where.entityType;
      }
    }

    // Date range filter on businessDate
    if (input.startDate || input.endDate) {
      const dateFilter: Record<string, Date> = {};
      if (input.startDate) dateFilter.gte = new Date(input.startDate);
      if (input.endDate) {
        const end = new Date(input.endDate);
        end.setDate(end.getDate() + 1);
        dateFilter.lt = end;
      }
      where.businessDate = dateFilter;
    }

    // Dynamic query builder filters (validated against allowlist)
    if (input.query) {
      const dynamicWhere = toPrismaWhere(input.query, METRIC_BUCKET_QUERYABLE_FIELDS);
      if (Object.keys(dynamicWhere).length > 0) {
        where.AND = [...((where.AND as unknown[]) ?? []), dynamicWhere];
      }
    }

    const select = {
      id: true,
      entityType: true,
      entityId: true,
      entityName: true,
      path: true,
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
      availability: true,
      performance: true,
      quality: true,
      oee: true,
    };

    const SORTABLE_COLUMNS = new Set([
      "entityName",
      "startTime",
      "businessDate",
      "businessShift",
      "currentJobName",
      "durationSeconds",
      "totalCycles",
      "goodCycles",
      "badCycles",
      "expectedCycles",
      "totalItems",
      "goodItems",
      "badItems",
      "expectedItems",
      "runSeconds",
      "downSeconds",
      "plannedDownSeconds",
      "unplannedDownSeconds",
      "availability",
      "performance",
      "quality",
      "oee",
    ]);

    const orderBy =
      input.sortBy && SORTABLE_COLUMNS.has(input.sortBy)
        ? [{ [input.sortBy]: input.sortDir }, { entityName: "asc" as const }]
        : [{ startTime: "desc" as const }, { entityName: "asc" as const }];

    const [data, total] = await Promise.all([
      prisma.metricBucketLog.findMany({
        where,
        select,
        orderBy,
        ...(Number(input.limit) > 0 ? { take: Number(input.limit) } : {}),
        skip: Number(input.offset),
      }),
      prisma.metricBucketLog.count({ where }),
    ]);

    return { data, total };
  });

// ============================================================================
// Hourly Bucket search (for white board)
//
// Returns HOUR-granularity MetricBucketLog rows for station-level production
// tracking. Used by the WhiteBoard component.
// ============================================================================

const hourlyBucketSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  shiftInstanceId: z.uuid().optional(),
});

export const hourlyBucketSearch = userOrDisplayRequired
  .input(hourlyBucketSearchInputSchema)
  .handler(async ({ input }) => {
    const where: Record<string, unknown> = {
      siteId: input.siteId,
      granularity: "HOUR",
    };

    if (input.shiftInstanceId) {
      where.shiftInstanceId = input.shiftInstanceId;
    }

    if (input.stationId) {
      where.entityType = "STATION";
      where.entityId = input.stationId;
    } else if (input.workCenterId) {
      where.entityType = "WORKCENTER";
      where.entityId = input.workCenterId;
    } else {
      where.entityType = "STATION";
    }

    if (input.startDate || input.endDate) {
      const dateFilter: Record<string, Date> = {};
      if (input.startDate) dateFilter.gte = new Date(input.startDate);
      if (input.endDate) {
        const end = new Date(input.endDate);
        end.setDate(end.getDate() + 1);
        dateFilter.lt = end;
      }
      where.businessDate = dateFilter;
    }

    const select = {
      id: true,
      entityId: true,
      entityName: true,
      granularityName: true,
      startTime: true,
      durationSeconds: true,
      shiftInstanceId: true,
      businessDate: true,
      businessShift: true,
      expectedItems: true,
      elapsedExpectedItems: true,
      totalItems: true,
      badItems: true,
      goodItems: true,
    };

    const orderBy = [{ startTime: "asc" as const }, { entityName: "asc" as const }];

    // Try archived data first; fall back to live MetricBucket for current shifts
    const archived = await prisma.metricBucketLog.findMany({ where, select, orderBy });
    if (archived.length > 0) return { data: archived };

    const live = await prisma.metricBucket.findMany({ where, select, orderBy });
    return { data: live };
  });

// ============================================================================
// Station Shift Summary (for white board sidebar)
//
// Returns a single SHIFT-granularity bucket for one station + shift, with the
// MetricBucket fallback for current/active shifts.
// ============================================================================

const stationShiftSummaryInputSchema = z.object({
  siteId: z.uuid(),
  stationId: z.uuid(),
  shiftInstanceId: z.uuid(),
});

export const stationShiftSummary = authRequired.input(stationShiftSummaryInputSchema).handler(async ({ input }) => {
  const where = {
    siteId: input.siteId,
    granularity: "SHIFT" as const,
    entityType: "STATION" as const,
    entityId: input.stationId,
    shiftInstanceId: input.shiftInstanceId,
  };

  const select = {
    id: true,
    entityType: true,
    entityId: true,
    entityName: true,
    startTime: true,
    durationSeconds: true,
    businessDate: true,
    businessShift: true,
    currentJobName: true,
    currentStandardCycle: true,
    expectedItems: true,
    totalItems: true,
    goodItems: true,
    badItems: true,
    expectedCycles: true,
    totalCycles: true,
    goodCycles: true,
    badCycles: true,
    runSeconds: true,
    downSeconds: true,
    plannedDownSeconds: true,
    unplannedDownSeconds: true,
    idealCycleSeconds: true,
    elapsedPlannedProductionSeconds: true,
    availability: true,
    performance: true,
    quality: true,
    oee: true,
  };

  // Try archived first; fall back to live MetricBucket for current shifts
  const archived = await prisma.metricBucketLog.findFirst({ where, select });
  if (archived) return { data: archived };

  const live = await prisma.metricBucket.findFirst({ where, select });
  return { data: live ?? null };
});

// ============================================================================
// Downtime Log search (shift-clamped, paginated)
//
// Each downtime entry is cross-joined with overlapping shift instances so a
// single entry that spans two shifts produces two rows, each clamped to the
// shift's time boundaries. Falls back to raw entries when no shifts exist.
// ============================================================================

const downtimeLogSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const downtimeLogSearch = authRequired.input(downtimeLogSearchInputSchema).handler(async ({ input }) => {
  // Resolve station IDs for the scope
  let stationIds: string[];
  let stationWorkcenterMap: Map<string, string | null>;

  if (input.stationId) {
    const st = await prisma.station.findUnique({
      where: { id: input.stationId },
      select: { id: true, workcenterId: true },
    });
    stationIds = st ? [st.id] : [];
    stationWorkcenterMap = new Map(st ? [[st.id, st.workcenterId]] : []);
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true, workcenterId: true },
    });
    stationIds = stations.map((s) => s.id);
    stationWorkcenterMap = new Map(stations.map((s) => [s.id, s.workcenterId]));
  } else {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId },
      select: { id: true, workcenterId: true },
    });
    stationIds = stations.map((s) => s.id);
    stationWorkcenterMap = new Map(stations.map((s) => [s.id, s.workcenterId]));
  }

  if (stationIds.length === 0) {
    return { data: [], total: 0 };
  }

  // Compute time range from date filters
  const rangeStart = input.startDate ? new Date(input.startDate) : new Date("2000-01-01");
  const rangeEnd = input.endDate
    ? (() => {
        const d = new Date(input.endDate);
        d.setDate(d.getDate() + 1);
        return d;
      })()
    : new Date("2100-01-01");

  // Fetch shift instances overlapping the range
  const shiftInstances = await prisma.shiftInstance.findMany({
    where: {
      OR: [
        { siteId: input.siteId, workCenterId: null },
        ...(input.workCenterId
          ? [{ workCenterId: input.workCenterId }]
          : [...new Set(stationWorkcenterMap.values())]
              .filter((id): id is string => id != null)
              .map((wcId) => ({ workCenterId: wcId }))),
      ],
      startTime: { lt: rangeEnd },
      endTime: { gt: rangeStart },
    },
    select: {
      id: true,
      shiftName: true,
      businessDate: true,
      startTime: true,
      endTime: true,
      workCenterId: true,
    },
    orderBy: { startTime: "asc" },
  });

  // Fetch overlapping DOWN entries (exclude open entries — they're still in progress)
  const downtimeWhere: Record<string, unknown> = {
    state: "DOWN",
    deletedAt: null,
    stationId: stationIds.length === 1 ? stationIds[0] : { in: stationIds },
    startTime: { lt: rangeEnd },
    endTime: { gt: rangeStart },
  };

  const entrySelect = {
    id: true,
    stationId: true,
    startTime: true,
    endTime: true,
    statusReasonId: true,
    statusReason: {
      select: {
        id: true,
        name: true,
        isPlannedDown: true,
        category: { select: { id: true, name: true } },
      },
    },
    station: { select: { name: true, workcenterId: true } },
    jobBlobId: true,
    jobBlob: { select: { id: true, name: true } },
  };

  const entries = await prisma.stationStateLog.findMany({
    where: downtimeWhere,
    select: entrySelect,
    orderBy: { startTime: "asc" },
  });

  // Build result rows
  const rows: Array<{
    id: string;
    stationId: string;
    stationName: string;
    shiftName: string | null;
    businessDate: Date | null;
    startTime: Date;
    endTime: Date | null;
    durationSeconds: number | null;
    statusReasonId: string | null;
    statusReasonName: string | null;
    isPlannedDown: boolean | null;
    categoryName: string | null;
    jobBlobId: string | null;
    jobName: string | null;
  }> = [];

  if (shiftInstances.length > 0) {
    // Shift-clamped mode: cross-join entries with overlapping shifts
    const shiftsByWc = new Map<string | null, typeof shiftInstances>();
    for (const si of shiftInstances) {
      const key = si.workCenterId;
      if (!shiftsByWc.has(key)) shiftsByWc.set(key, []);
      shiftsByWc.get(key)?.push(si);
    }

    for (const entry of entries) {
      if (!entry.endTime) continue;
      const entryEnd = entry.endTime;
      const wcId = entry.station.workcenterId;
      const applicableShifts = shiftsByWc.get(wcId) ?? shiftsByWc.get(null) ?? [];

      for (const shift of applicableShifts) {
        if (entry.startTime >= shift.endTime || entryEnd <= shift.startTime) continue;

        const clampedStart = entry.startTime < shift.startTime ? shift.startTime : entry.startTime;
        const clampedEnd = entryEnd > shift.endTime ? shift.endTime : entryEnd;
        const durationSeconds = Math.round((clampedEnd.getTime() - clampedStart.getTime()) / 1000);
        if (durationSeconds <= 0) continue;

        rows.push({
          id: `${entry.id}:${shift.id}`,
          stationId: entry.stationId,
          stationName: entry.station.name,
          shiftName: shift.shiftName,
          businessDate: shift.businessDate,
          startTime: clampedStart,
          endTime: clampedEnd,
          durationSeconds,
          statusReasonId: entry.statusReasonId,
          statusReasonName: entry.statusReason?.name ?? null,
          isPlannedDown: entry.statusReason?.isPlannedDown ?? null,
          categoryName: entry.statusReason?.category?.name ?? null,
          jobBlobId: entry.jobBlobId ?? null,
          jobName: entry.jobBlob?.name ?? null,
        });
      }
    }
  } else {
    // No shifts configured — fall back to raw entries
    for (const entry of entries) {
      const durationSeconds = entry.endTime
        ? Math.round((entry.endTime.getTime() - entry.startTime.getTime()) / 1000)
        : null;

      rows.push({
        id: entry.id,
        stationId: entry.stationId,
        stationName: entry.station.name,
        shiftName: null,
        businessDate: null,
        startTime: entry.startTime,
        endTime: entry.endTime,
        durationSeconds,
        statusReasonId: entry.statusReasonId,
        statusReasonName: entry.statusReason?.name ?? null,
        isPlannedDown: entry.statusReason?.isPlannedDown ?? null,
        categoryName: entry.statusReason?.category?.name ?? null,
        jobBlobId: entry.jobBlobId ?? null,
        jobName: entry.jobBlob?.name ?? null,
      });
    }
  }

  // Dynamic query builder filters (in-memory, validated against allowlist)
  let filteredRows = rows;
  if (input.query) {
    const predicate = toRowFilter(input.query, DOWNTIME_QUERYABLE_FIELDS);
    filteredRows = rows.filter(predicate);
  }

  // Sort
  type Row = (typeof filteredRows)[number];
  const SORTABLE: Record<string, (r: Row) => string | number> = {
    startTime: (r) => r.startTime.getTime(),
    endTime: (r) => r.endTime?.getTime() ?? 0,
    stationName: (r) => r.stationName,
    shiftName: (r) => r.shiftName ?? "",
    businessDate: (r) => r.businessDate?.getTime() ?? 0,
    durationSeconds: (r) => r.durationSeconds ?? 0,
    statusReasonName: (r) => r.statusReasonName ?? "",
    categoryName: (r) => r.categoryName ?? "",
    jobName: (r) => r.jobName ?? "",
  };

  const sortKey = input.sortBy && SORTABLE[input.sortBy] ? SORTABLE[input.sortBy] : SORTABLE.startTime;
  const sortMul = input.sortDir === "asc" ? 1 : -1;

  filteredRows.sort((a, b) => {
    const va = sortKey(a);
    const vb = sortKey(b);
    if (va < vb) return -1 * sortMul;
    if (va > vb) return 1 * sortMul;
    return 0;
  });

  // Paginate
  const total = filteredRows.length;
  const offset = Number(input.offset);
  const limit = Number(input.limit);
  const page = limit > 0 ? filteredRows.slice(offset, offset + limit) : filteredRows;

  return { data: page, total };
});

// ============================================================================
// Disposition Log search (paginated, filterable)
// ============================================================================

const dispositionLogSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const dispositionLogSearch = authRequired.input(dispositionLogSearchInputSchema).handler(async ({ input }) => {
  const where: Prisma.ItemDispositionLogWhereInput = {
    siteId: input.siteId,
    deletedAt: null,
  };

  // Scope by station or workcenter
  if (input.stationId) {
    where.stationId = input.stationId;
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    where.stationId = { in: stations.map((s) => s.id) };
  }

  // Date range on createdAt
  if (input.startDate || input.endDate) {
    const dateFilter: Record<string, Date> = {};
    if (input.startDate) dateFilter.gte = new Date(input.startDate);
    if (input.endDate) {
      const end = new Date(input.endDate);
      end.setDate(end.getDate() + 1);
      dateFilter.lt = end;
    }
    where.createdAt = dateFilter;
  }

  // Dynamic query builder filters
  if (input.query) {
    const dynamicWhere = toPrismaWhere(
      input.query,
      DISPOSITION_LOG_QUERYABLE_FIELDS,
    ) as Prisma.ItemDispositionLogWhereInput;
    if (Object.keys(dynamicWhere).length > 0) {
      where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), dynamicWhere];
    }
  }

  const select = {
    id: true,
    createdAt: true,
    quantity: true,
    stationId: true,
    station: { select: { id: true, name: true } },
    itemDisposition: { select: { id: true, name: true } },
    dispositionReason: { select: { id: true, name: true } },
    productBlob: { select: { id: true, name: true, sku: true } },
    toolBlob: { select: { id: true, name: true } },
    toolCavityBlob: { select: { id: true, name: true } },
    shiftInstance: { select: { id: true, shiftName: true, businessDate: true } },
  };

  const SORTABLE_COLUMNS = new Set(["createdAt", "quantity"]);

  // For relation fields, we need to map to the correct orderBy shape
  type OrderBy = Prisma.ItemDispositionLogOrderByWithRelationInput;
  const RELATION_SORT: Record<string, OrderBy> = {
    stationName: { station: { name: input.sortDir } },
    dispositionName: { itemDisposition: { name: input.sortDir } },
    reasonName: { dispositionReason: { name: input.sortDir } },
    productName: { productBlob: { name: input.sortDir } },
    shiftName: { shiftInstance: { shiftName: input.sortDir } },
  };

  let orderBy: OrderBy[];
  if (input.sortBy && SORTABLE_COLUMNS.has(input.sortBy)) {
    orderBy = [{ [input.sortBy]: input.sortDir }, { createdAt: "desc" }];
  } else if (input.sortBy && RELATION_SORT[input.sortBy]) {
    orderBy = [RELATION_SORT[input.sortBy], { createdAt: "desc" }];
  } else {
    orderBy = [{ createdAt: "desc" }];
  }

  const [data, total] = await Promise.all([
    prisma.itemDispositionLog.findMany({
      where,
      select,
      orderBy,
      ...(Number(input.limit) > 0 ? { take: Number(input.limit) } : {}),
      skip: Number(input.offset),
    }),
    prisma.itemDispositionLog.count({ where }),
  ]);

  // Flatten for the frontend
  const rows = data.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    quantity: row.quantity,
    stationId: row.stationId,
    stationName: row.station.name,
    dispositionName: row.itemDisposition?.name ?? null,
    reasonName: row.dispositionReason?.name ?? null,
    productName: row.productBlob?.name ?? null,
    productSku: row.productBlob?.sku ?? null,
    toolName: row.toolBlob?.name ?? null,
    cavityName: row.toolCavityBlob?.name ?? null,
    shiftName: row.shiftInstance?.shiftName ?? null,
    businessDate: row.shiftInstance?.businessDate ?? null,
  }));

  return { data: rows, total };
});

// ============================================================================
// Material Usage Log search (aggregated, paginated)
//
// Joins InventoryItem → ProductMaterialBlob (weight) → MaterialBlob (name),
// plus Cycle → JobBlob (job name) and ProductBlob (part name).
// Cross-references with ShiftInstances for shift/date attribution.
// Aggregates (sums) weight by Date, Shift, Job, Part, Material.
// ============================================================================

/** Material usage rows are computed in JS, so we filter in-memory. */
const MATERIAL_USAGE_QUERYABLE_FIELDS: FieldAllowlist = {
  businessDate: { column: "businessDate", type: "string" },
  shiftName: { column: "shiftName", type: "string" },
  jobName: { column: "jobName", type: "string" },
  partName: { column: "partName", type: "string" },
  materialName: { column: "materialName", type: "string" },
  totalWeight: { column: "totalWeight", type: "number" },
  weightUnits: { column: "weightUnits", type: "string" },
  itemCount: { column: "itemCount", type: "number" },
};

const materialUsageSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  groupByJob: z.boolean().default(true),
  groupByPart: z.boolean().default(true),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const materialUsageSearch = authRequired.input(materialUsageSearchInputSchema).handler(async ({ input }) => {
  // Resolve station scope — always build workcenter map for shift lookup
  let stationIds: string[] | undefined;

  const stationQuery = input.workCenterId
    ? { siteId: input.siteId, workcenterId: input.workCenterId }
    : { siteId: input.siteId };
  const allStations = await prisma.station.findMany({
    where: stationQuery,
    select: { id: true, workcenterId: true },
  });
  const stationWorkcenterMap = new Map(allStations.map((s) => [s.id, s.workcenterId]));

  if (input.workCenterId) {
    stationIds = allStations.map((s) => s.id);
    if (stationIds.length === 0) return { data: [], total: 0 };
  }

  // Date range for cycle.end
  const rangeStart = input.startDate ? new Date(input.startDate) : new Date("2000-01-01");
  const rangeEnd = input.endDate
    ? (() => {
        const d = new Date(input.endDate);
        d.setDate(d.getDate() + 1);
        return d;
      })()
    : new Date("2100-01-01");

  // Fetch InventoryItems with material blobs, cycle/job, and product
  const cycleWhere: Record<string, unknown> = {
    siteId: input.siteId,
    deletedAt: null,
    end: { gte: rangeStart, lt: rangeEnd },
  };
  if (stationIds) {
    cycleWhere.stationId = stationIds.length === 1 ? stationIds[0] : { in: stationIds };
  }

  const items = await prisma.inventoryItem.findMany({
    where: {
      deletedAt: null,
      cycle: cycleWhere,
      productMaterialBlobs: { some: {} }, // only items that have materials
    },
    select: {
      id: true,
      cycle: {
        select: {
          end: true,
          start: true,
          stationId: true,
          jobBlob: { select: { name: true } },
        },
      },
      productBlob: { select: { name: true } },
      productMaterialBlobs: {
        select: {
          weight: true,
          weightUnits: true,
          materialBlob: { select: { name: true } },
        },
      },
    },
  });

  // Fetch shift instances overlapping the range for shift/date attribution
  const siWhere: Record<string, unknown> = {
    startTime: { lt: rangeEnd },
    endTime: { gt: rangeStart },
  };
  if (input.workCenterId) {
    siWhere.OR = [{ siteId: input.siteId, workCenterId: null }, { workCenterId: input.workCenterId }];
  } else {
    siWhere.siteId = input.siteId;
  }

  const shiftInstances = await prisma.shiftInstance.findMany({
    where: siWhere,
    select: {
      shiftName: true,
      businessDate: true,
      startTime: true,
      endTime: true,
      workCenterId: true,
    },
    orderBy: { startTime: "asc" },
  });

  // Group shifts by workcenter for efficient lookup
  const shiftsByWc = new Map<string | null, typeof shiftInstances>();
  for (const si of shiftInstances) {
    const key = si.workCenterId;
    if (!shiftsByWc.has(key)) shiftsByWc.set(key, []);
    shiftsByWc.get(key)?.push(si);
  }

  // Find the shift covering a given timestamp for a given station
  function findShift(timestamp: Date, stationId: string) {
    const wcId = stationWorkcenterMap.get(stationId) ?? null;
    const shifts = shiftsByWc.get(wcId) ?? shiftsByWc.get(null) ?? [];
    for (const si of shifts) {
      if (timestamp >= si.startTime && timestamp < si.endTime) {
        return si;
      }
    }
    return null;
  }

  // Build raw material-usage rows and aggregate
  const aggMap = new Map<
    string,
    {
      businessDate: string | null;
      shiftName: string | null;
      jobName: string | null;
      partName: string | null;
      materialName: string;
      weightUnits: string | null;
      totalWeight: number;
      itemCount: number;
    }
  >();

  for (const item of items) {
    const cycleTime = item.cycle.end ?? item.cycle.start;
    const shift = findShift(cycleTime, item.cycle.stationId);
    const businessDate = shift?.businessDate
      ? shift.businessDate.toISOString().slice(0, 10)
      : cycleTime.toISOString().slice(0, 10);
    const shiftName = shift?.shiftName ?? null;
    const jobName = input.groupByJob ? item.cycle.jobBlob.name : null;
    const partName = input.groupByPart ? (item.productBlob.name ?? "—") : null;

    for (const pmb of item.productMaterialBlobs) {
      const materialName = pmb.materialBlob.name ?? "—";
      const weightUnits = pmb.weightUnits ?? null;
      const weight = pmb.weight ? Number(pmb.weight) : 0;

      const key = `${businessDate}::${shiftName}::${jobName ?? "*"}::${partName ?? "*"}::${materialName}::${weightUnits}`;

      if (!aggMap.has(key)) {
        aggMap.set(key, {
          businessDate,
          shiftName,
          jobName,
          partName,
          materialName,
          weightUnits,
          totalWeight: 0,
          itemCount: 0,
        });
      }
      const entry = aggMap.get(key);
      if (!entry) continue;
      entry.totalWeight += weight;
      entry.itemCount += 1;
    }
  }

  let rows = Array.from(aggMap.values()).map((r) => ({
    ...r,
    totalWeight: Math.round(r.totalWeight * 100) / 100,
  }));

  // Dynamic query builder filters (in-memory)
  if (input.query) {
    const predicate = toRowFilter(input.query, MATERIAL_USAGE_QUERYABLE_FIELDS);
    rows = rows.filter(predicate);
  }

  // Sort
  type Row = (typeof rows)[number];
  const SORTABLE: Record<string, (r: Row) => string | number> = {
    businessDate: (r) => r.businessDate ?? "",
    shiftName: (r) => r.shiftName ?? "",
    jobName: (r) => r.jobName ?? "",
    partName: (r) => r.partName ?? "",
    materialName: (r) => r.materialName,
    totalWeight: (r) => r.totalWeight,
    weightUnits: (r) => r.weightUnits ?? "",
    itemCount: (r) => r.itemCount,
  };

  const sortKey = input.sortBy && SORTABLE[input.sortBy] ? SORTABLE[input.sortBy] : SORTABLE.businessDate;
  const sortMul = input.sortDir === "asc" ? 1 : -1;

  rows.sort((a, b) => {
    const va = sortKey(a);
    const vb = sortKey(b);
    if (va < vb) return -1 * sortMul;
    if (va > vb) return 1 * sortMul;
    return 0;
  });

  // Paginate
  const total = rows.length;
  const offset = Number(input.offset);
  const limit = Number(input.limit);
  const page = limit > 0 ? rows.slice(offset, offset + limit) : rows;

  return { data: page, total };
});

// ============================================================================
// Cycle Log search (paginated, filterable)
//
// Returns individual cycle records with job name, station name, standard cycle,
// actual cycle duration, and shift/date attribution via ShiftInstance overlap.
//
// All work is server-side: a single $queryRaw with two LEFT JOIN LATERAL
// subqueries (workcenter-scoped + site-fallback) attributes each cycle to its
// shift, plus a window function for total count alongside the paginated page.
// Filter and sort on shiftName / businessDate operate on the COALESCE'd
// attributed values. The previous implementation loaded every cycle into
// memory and 502'd at production volume.
// ============================================================================

const cycleSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

/** Fields from the CTE that the dynamic query / sortBy can reference. */
const CYCLE_FIELD_TO_SQL: Record<string, Prisma.Sql> = {
  stationName: Prisma.sql`"stationName"`,
  jobName: Prisma.sql`"jobName"`,
  cycleStatus: Prisma.sql`"cycleStatus"`,
  standardCycle: Prisma.sql`"standardCycle"`,
  shiftName: Prisma.sql`"shiftName"`,
  businessDate: Prisma.sql`"businessDate"`,
  startTime: Prisma.sql`"startTime"`,
  endTime: Prisma.sql`"endTime"`,
};

export const cycleSearch = authRequired.input(cycleSearchInputSchema).handler(async ({ input }) => {
  // Resolve station scope to a uuid[] we can ANY() in SQL.
  let stationIds: string[];
  if (input.stationId) {
    const st = await prisma.station.findUnique({
      where: { id: input.stationId },
      select: { id: true },
    });
    stationIds = st ? [st.id] : [];
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    stationIds = stations.map((s) => s.id);
  } else {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId },
      select: { id: true },
    });
    stationIds = stations.map((s) => s.id);
  }

  if (stationIds.length === 0) {
    return { data: [], total: 0 };
  }

  // Default to last 7 days when no startDate is supplied. The previous
  // "2000-01-01" default loaded every cycle ever for the site at
  // production volume, blowing up the response.
  const rangeStart = input.startDate ? new Date(input.startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rangeEnd = input.endDate
    ? (() => {
        const d = new Date(input.endDate);
        d.setDate(d.getDate() + 1);
        return d;
      })()
    : new Date();

  const filterFragment = buildCycleFilterSql(input.query);
  const orderFragment = buildCycleOrderBySql(input.sortBy, input.sortDir);

  const limit = Number(input.limit);
  const take = limit > 0 ? limit : 50;
  const skip = Number(input.offset);

  type Row = {
    id: string;
    cycleStatus: "GOOD" | "BAD" | "DISCARD";
    startTime: Date;
    endTime: Date | null;
    stationId: string;
    stationName: string;
    jobName: string | null;
    standardCycle: number | null;
    actualCycleSeconds: number | null;
    shiftName: string | null;
    businessDate: string | null;
    totalCount: bigint;
  };

  const rows = await prisma.$queryRaw<Row[]>`
    WITH attributed AS (
      SELECT
        c.id,
        c."cycleStatus",
        c.start            AS "startTime",
        c."end"            AS "endTime",
        c."stationId",
        s.name             AS "stationName",
        jb.name            AS "jobName",
        jb."standardCycle"::float8 AS "standardCycle",
        CASE
          WHEN c."end" IS NULL THEN NULL
          ELSE EXTRACT(EPOCH FROM (c."end" - c.start))::int
        END                AS "actualCycleSeconds",
        COALESCE(si_wc."shiftName", si_site."shiftName") AS "shiftName",
        COALESCE(
          to_char(si_wc."businessDate", 'YYYY-MM-DD'),
          to_char(si_site."businessDate", 'YYYY-MM-DD')
        )                  AS "businessDate"
      FROM "Cycle" c
      JOIN "Station" s ON s.id = c."stationId"
      JOIN "JobBlob" jb ON jb.id = c."jobBlobId"
      LEFT JOIN LATERAL (
        SELECT si."shiftName", si."businessDate"
        FROM "ShiftInstance" si
        WHERE si."workCenterId" = s."workcenterId"
          AND si."startTime" <= c.start
          AND si."endTime"   >  c.start
        ORDER BY si."startTime" DESC
        LIMIT 1
      ) si_wc ON TRUE
      LEFT JOIN LATERAL (
        SELECT si."shiftName", si."businessDate"
        FROM "ShiftInstance" si
        WHERE si."siteId" = c."siteId"
          AND si."workCenterId" IS NULL
          AND si."startTime" <= c.start
          AND si."endTime"   >  c.start
        ORDER BY si."startTime" DESC
        LIMIT 1
      ) si_site ON TRUE
      WHERE c."siteId" = ${input.siteId}::uuid
        AND c."deletedAt" IS NULL
        AND c.start >= ${rangeStart}::timestamptz
        AND c.start <  ${rangeEnd}::timestamptz
        AND c."stationId" = ANY(${stationIds}::uuid[])
    )
    SELECT
      a.*,
      COUNT(*) OVER () AS "totalCount"
    FROM attributed a
    WHERE TRUE ${filterFragment}
    ORDER BY ${orderFragment}
    LIMIT ${take} OFFSET ${skip}
  `;

  const total = rows.length > 0 ? Number(rows[0].totalCount) : 0;
  const data = rows.map(({ totalCount: _t, ...rest }) => rest);
  return { data, total };
});

// ---------------------------------------------------------------------------
// Cycle filter / sort SQL builders
// ---------------------------------------------------------------------------

function buildCycleFilterSql(query: QueryFilter | undefined): Prisma.Sql {
  if (!query) return Prisma.empty;
  const expr = walkQueryToSql(query);
  // The outer SELECT already starts with `WHERE TRUE`, so every emitted
  // expression hangs off an `AND`.
  return expr.values.length > 0 || expr.text.length > 0 ? Prisma.sql`AND (${expr})` : Prisma.empty;
}

function walkQueryToSql(node: QueryFilter | QueryRule): Prisma.Sql {
  // Group node (and / or)
  if ("combinator" in node) {
    const parts = node.rules.map(walkQueryToSql).filter((p) => p.text.length > 0 || p.values.length > 0);
    if (parts.length === 0) return Prisma.sql`TRUE`;
    const sep = node.combinator === "and" ? " AND " : " OR ";
    return Prisma.sql`(${Prisma.join(parts, sep)})`;
  }
  // Term node
  return termToSql(node);
}

function termToSql(rule: QueryRule): Prisma.Sql {
  const col = CYCLE_FIELD_TO_SQL[rule.field];
  if (!col) return Prisma.sql`TRUE`; // unknown field — silent no-op (parity with prior allowlist behavior)

  switch (rule.operator) {
    case "=":
      return Prisma.sql`${col} = ${rule.value}`;
    case "!=":
      return Prisma.sql`${col} <> ${rule.value}`;
    case ">":
      return Prisma.sql`${col} > ${rule.value}`;
    case "<":
      return Prisma.sql`${col} < ${rule.value}`;
    case ">=":
      return Prisma.sql`${col} >= ${rule.value}`;
    case "<=":
      return Prisma.sql`${col} <= ${rule.value}`;
    case "contains":
      return Prisma.sql`${col} ILIKE ${`%${String(rule.value)}%`}`;
    case "beginsWith":
      return Prisma.sql`${col} ILIKE ${`${String(rule.value)}%`}`;
    case "in":
      if (!Array.isArray(rule.value) || rule.value.length === 0) return Prisma.sql`FALSE`;
      return Prisma.sql`${col} IN (${Prisma.join(rule.value)})`;
    case "notIn":
      if (!Array.isArray(rule.value) || rule.value.length === 0) return Prisma.sql`TRUE`;
      return Prisma.sql`${col} NOT IN (${Prisma.join(rule.value)})`;
    case "between":
      if (!Array.isArray(rule.value) || rule.value.length !== 2) return Prisma.sql`TRUE`;
      return Prisma.sql`${col} BETWEEN ${rule.value[0]} AND ${rule.value[1]}`;
    case "notBetween":
      if (!Array.isArray(rule.value) || rule.value.length !== 2) return Prisma.sql`TRUE`;
      return Prisma.sql`${col} NOT BETWEEN ${rule.value[0]} AND ${rule.value[1]}`;
    case "null":
      return Prisma.sql`${col} IS NULL`;
    case "notNull":
      return Prisma.sql`${col} IS NOT NULL`;
    default:
      return Prisma.sql`TRUE`;
  }
}

function buildCycleOrderBySql(sortBy: string | undefined, sortDir: "asc" | "desc"): Prisma.Sql {
  const col = sortBy ? CYCLE_FIELD_TO_SQL[sortBy] : null;
  const dir = sortDir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  if (col) {
    return Prisma.sql`${col} ${dir} NULLS LAST`;
  }
  return Prisma.sql`"startTime" DESC`;
}

// ============================================================================
// Logon Log search (paginated, filterable) — StationLogonSession history
// ============================================================================

const logonLogSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const logonLogSearch = authRequired.input(logonLogSearchInputSchema).handler(async ({ input }) => {
  const where: Prisma.StationLogonSessionWhereInput = {
    station: { siteId: input.siteId },
  };

  if (input.stationId) {
    where.stationId = input.stationId;
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true },
    });
    where.stationId = { in: stations.map((s) => s.id) };
  }

  if (input.startDate || input.endDate) {
    const dateFilter: Record<string, Date> = {};
    if (input.startDate) dateFilter.gte = new Date(input.startDate);
    if (input.endDate) {
      const end = new Date(input.endDate);
      end.setDate(end.getDate() + 1);
      dateFilter.lt = end;
    }
    where.logonTime = dateFilter;
  }

  if (input.query) {
    const dynamicWhere = toPrismaWhere(input.query, LOGON_LOG_QUERYABLE_FIELDS) as Prisma.StationLogonSessionWhereInput;
    if (Object.keys(dynamicWhere).length > 0) {
      where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), dynamicWhere];
    }
  }

  const select = {
    id: true,
    logonTime: true,
    logoffTime: true,
    logonMethod: true,
    genericName: true,
    stationId: true,
    station: { select: { id: true, name: true } },
    display: { select: { id: true, name: true } },
    employee: {
      select: {
        id: true,
        version: { select: { firstName: true, lastName: true, employeeNumber: true } },
      },
    },
    shiftInstance: { select: { id: true, shiftName: true, businessDate: true } },
  };

  const SORTABLE_COLUMNS = new Set(["logonTime", "logoffTime", "logonMethod"]);

  type OrderBy = Prisma.StationLogonSessionOrderByWithRelationInput;
  const RELATION_SORT: Record<string, OrderBy> = {
    stationName: { station: { name: input.sortDir } },
    displayName: { display: { name: input.sortDir } },
    shiftName: { shiftInstance: { shiftName: input.sortDir } },
    employeeName: { employee: { version: { lastName: input.sortDir } } },
    employeeNumber: { employee: { version: { employeeNumber: input.sortDir } } },
  };

  let orderBy: OrderBy[];
  if (input.sortBy && SORTABLE_COLUMNS.has(input.sortBy)) {
    orderBy = [{ [input.sortBy]: input.sortDir }, { logonTime: "desc" }];
  } else if (input.sortBy && RELATION_SORT[input.sortBy]) {
    orderBy = [RELATION_SORT[input.sortBy], { logonTime: "desc" }];
  } else {
    orderBy = [{ logonTime: "desc" }];
  }

  const [data, total] = await Promise.all([
    prisma.stationLogonSession.findMany({
      where,
      select,
      orderBy,
      ...(Number(input.limit) > 0 ? { take: Number(input.limit) } : {}),
      skip: Number(input.offset),
    }),
    prisma.stationLogonSession.count({ where }),
  ]);

  const rows = data.map((row) => {
    const employeeName = row.employee?.version
      ? `${row.employee.version.firstName} ${row.employee.version.lastName}`.trim()
      : null;
    const durationSeconds = row.logoffTime
      ? Math.round((row.logoffTime.getTime() - row.logonTime.getTime()) / 1000)
      : null;
    return {
      id: row.id,
      logonTime: row.logonTime,
      logoffTime: row.logoffTime,
      durationSeconds,
      logonMethod: row.logonMethod,
      stationId: row.stationId,
      stationName: row.station.name,
      displayName: row.display?.name ?? null,
      employeeName: employeeName ?? row.genericName ?? null,
      employeeNumber: row.employee?.version?.employeeNumber ?? null,
      shiftName: row.shiftInstance?.shiftName ?? null,
      businessDate: row.shiftInstance?.businessDate ?? null,
    };
  });

  return { data: rows, total };
});

// ============================================================================
// Part Log search (aggregated, paginated)
//
// Per Date × Shift × Machine × Part: totalProduction (from InventoryItem count),
// totalDefect (sum of ItemDispositionLog.quantity), totalGood (production − defect).
// Mirrors the aggregation conventions used by badItems in metric-bucket compute:
// every non-deleted disposition row contributes to defect regardless of kind.
// ============================================================================

const PART_LOG_QUERYABLE_FIELDS: FieldAllowlist = {
  businessDate: { column: "businessDate", type: "string" },
  shiftName: { column: "shiftName", type: "string" },
  stationName: { column: "stationName", type: "string" },
  partName: { column: "partName", type: "string" },
  partSku: { column: "partSku", type: "string" },
  totalProduction: { column: "totalProduction", type: "number" },
  totalDefect: { column: "totalDefect", type: "number" },
  totalGood: { column: "totalGood", type: "number" },
};

const partLogSearchInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional(),
  query: queryFilterSchema.optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

export const partLogSearch = authRequired.input(partLogSearchInputSchema).handler(async ({ input }) => {
  // Resolve station scope + workcenter map for shift lookup
  let stationIds: string[];
  let stationWorkcenterMap: Map<string, string | null>;
  const stationNameMap = new Map<string, string>();

  if (input.stationId) {
    const st = await prisma.station.findUnique({
      where: { id: input.stationId },
      select: { id: true, name: true, workcenterId: true },
    });
    stationIds = st ? [st.id] : [];
    stationWorkcenterMap = new Map(st ? [[st.id, st.workcenterId]] : []);
    if (st) stationNameMap.set(st.id, st.name);
  } else if (input.workCenterId) {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId, workcenterId: input.workCenterId },
      select: { id: true, name: true, workcenterId: true },
    });
    stationIds = stations.map((s) => s.id);
    stationWorkcenterMap = new Map(stations.map((s) => [s.id, s.workcenterId]));
    for (const s of stations) stationNameMap.set(s.id, s.name);
  } else {
    const stations = await prisma.station.findMany({
      where: { siteId: input.siteId },
      select: { id: true, name: true, workcenterId: true },
    });
    stationIds = stations.map((s) => s.id);
    stationWorkcenterMap = new Map(stations.map((s) => [s.id, s.workcenterId]));
    for (const s of stations) stationNameMap.set(s.id, s.name);
  }

  if (stationIds.length === 0) {
    return { data: [], total: 0 };
  }

  // Time range
  const rangeStart = input.startDate ? new Date(input.startDate) : new Date("2000-01-01");
  const rangeEnd = input.endDate
    ? (() => {
        const d = new Date(input.endDate);
        d.setDate(d.getDate() + 1);
        return d;
      })()
    : new Date("2100-01-01");

  // Shift instances overlapping the range (for InventoryItem attribution)
  const siWhere: Record<string, unknown> = {
    startTime: { lt: rangeEnd },
    endTime: { gt: rangeStart },
  };
  if (input.workCenterId) {
    siWhere.OR = [{ siteId: input.siteId, workCenterId: null }, { workCenterId: input.workCenterId }];
  } else {
    siWhere.siteId = input.siteId;
  }

  const shiftInstances = await prisma.shiftInstance.findMany({
    where: siWhere,
    select: {
      shiftName: true,
      businessDate: true,
      startTime: true,
      endTime: true,
      workCenterId: true,
    },
    orderBy: { startTime: "asc" },
  });

  const shiftsByWc = new Map<string | null, typeof shiftInstances>();
  for (const si of shiftInstances) {
    const key = si.workCenterId;
    if (!shiftsByWc.has(key)) shiftsByWc.set(key, []);
    shiftsByWc.get(key)?.push(si);
  }

  function findShift(timestamp: Date, stationId: string) {
    const wcId = stationWorkcenterMap.get(stationId) ?? null;
    const shifts = shiftsByWc.get(wcId) ?? shiftsByWc.get(null) ?? [];
    for (const si of shifts) {
      if (timestamp >= si.startTime && timestamp < si.endTime) {
        return si;
      }
    }
    return null;
  }

  interface Agg {
    businessDate: string | null;
    shiftName: string | null;
    stationId: string;
    stationName: string;
    partName: string;
    partSku: string | null;
    totalProduction: number;
    totalDefect: number;
    totalGood: number;
  }

  const aggMap = new Map<string, Agg>();
  const keyOf = (businessDate: string | null, shiftName: string | null, stationId: string, partName: string) =>
    `${businessDate ?? "*"}::${shiftName ?? "*"}::${stationId}::${partName}`;

  // Pass 1 — Items (production)
  const items = await prisma.inventoryItem.findMany({
    where: {
      deletedAt: null,
      cycle: {
        siteId: input.siteId,
        deletedAt: null,
        end: { gte: rangeStart, lt: rangeEnd },
        stationId: stationIds.length === 1 ? stationIds[0] : { in: stationIds },
      },
    },
    select: {
      cycle: { select: { end: true, start: true, stationId: true } },
      productBlob: { select: { name: true, sku: true } },
    },
  });

  for (const item of items) {
    const stationId = item.cycle.stationId;
    const ts = item.cycle.end ?? item.cycle.start;
    const shift = findShift(ts, stationId);
    const businessDate = shift?.businessDate
      ? shift.businessDate.toISOString().slice(0, 10)
      : ts.toISOString().slice(0, 10);
    const shiftName = shift?.shiftName ?? null;
    const partName = item.productBlob?.name ?? "\u2014";
    const partSku = item.productBlob?.sku ?? null;
    const stationName = stationNameMap.get(stationId) ?? "";

    const key = keyOf(businessDate, shiftName, stationId, partName);
    let entry = aggMap.get(key);
    if (!entry) {
      entry = {
        businessDate,
        shiftName,
        stationId,
        stationName,
        partName,
        partSku,
        totalProduction: 0,
        totalDefect: 0,
        totalGood: 0,
      };
      aggMap.set(key, entry);
    }
    entry.totalProduction += 1;
    if (entry.partSku == null && partSku != null) entry.partSku = partSku;
  }

  // Pass 2 — Dispositions (defect). ItemDispositionLog already has shiftInstance
  // joined, so we use it directly rather than re-attributing via findShift.
  const dispositions = await prisma.itemDispositionLog.findMany({
    where: {
      siteId: input.siteId,
      deletedAt: null,
      createdAt: { gte: rangeStart, lt: rangeEnd },
      stationId: stationIds.length === 1 ? stationIds[0] : { in: stationIds },
    },
    select: {
      stationId: true,
      createdAt: true,
      quantity: true,
      productBlob: { select: { name: true, sku: true } },
      shiftInstance: { select: { shiftName: true, businessDate: true } },
    },
  });

  for (const d of dispositions) {
    const stationId = d.stationId;
    // Prefer the log's own shiftInstance; fall back to overlap lookup if absent.
    let businessDate: string | null;
    let shiftName: string | null;
    if (d.shiftInstance) {
      businessDate = d.shiftInstance.businessDate.toISOString().slice(0, 10);
      shiftName = d.shiftInstance.shiftName ?? null;
    } else {
      const shift = findShift(d.createdAt, stationId);
      businessDate = shift?.businessDate
        ? shift.businessDate.toISOString().slice(0, 10)
        : d.createdAt.toISOString().slice(0, 10);
      shiftName = shift?.shiftName ?? null;
    }
    const partName = d.productBlob?.name ?? "\u2014";
    const partSku = d.productBlob?.sku ?? null;
    const stationName = stationNameMap.get(stationId) ?? "";

    const key = keyOf(businessDate, shiftName, stationId, partName);
    let entry = aggMap.get(key);
    if (!entry) {
      entry = {
        businessDate,
        shiftName,
        stationId,
        stationName,
        partName,
        partSku,
        totalProduction: 0,
        totalDefect: 0,
        totalGood: 0,
      };
      aggMap.set(key, entry);
    }
    entry.totalDefect += d.quantity;
    if (entry.partSku == null && partSku != null) entry.partSku = partSku;
  }

  // Finalize totalGood = production − defect (clamped)
  let rows = Array.from(aggMap.values()).map((r) => ({
    ...r,
    totalGood: Math.max(0, r.totalProduction - r.totalDefect),
  }));

  // Dynamic query builder filters (in-memory)
  if (input.query) {
    const predicate = toRowFilter(input.query, PART_LOG_QUERYABLE_FIELDS);
    rows = rows.filter(predicate);
  }

  // Sort
  type Row = (typeof rows)[number];
  const SORTABLE: Record<string, (r: Row) => string | number> = {
    businessDate: (r) => r.businessDate ?? "",
    shiftName: (r) => r.shiftName ?? "",
    stationName: (r) => r.stationName,
    partName: (r) => r.partName,
    partSku: (r) => r.partSku ?? "",
    totalProduction: (r) => r.totalProduction,
    totalDefect: (r) => r.totalDefect,
    totalGood: (r) => r.totalGood,
  };

  const sortKey = input.sortBy && SORTABLE[input.sortBy] ? SORTABLE[input.sortBy] : SORTABLE.businessDate;
  const sortMul = input.sortDir === "asc" ? 1 : -1;

  rows.sort((a, b) => {
    const va = sortKey(a);
    const vb = sortKey(b);
    if (va < vb) return -1 * sortMul;
    if (va > vb) return 1 * sortMul;
    return 0;
  });

  // Paginate
  const total = rows.length;
  const offset = Number(input.offset);
  const limit = Number(input.limit);
  const page = limit > 0 ? rows.slice(offset, offset + limit) : rows;

  return { data: page, total };
});
