import prisma from "@rw/db";
import { formatStationLogons } from "./employee/logon.js";
import { MetricsContext } from "@rw/services/metrics/context";
import { resolveEntityName, resolveEntityPath } from "@rw/services/metrics/hierarchy";
import { rowToSnapshot, type BucketSnapshot } from "@rw/services/metrics/sync";

export type BucketEntityType = "STATION" | "WORKCENTER" | "SITE" | "JOB";
export type BucketGranularity = "MINUTE" | "HOUR" | "SHIFT" | "DAY";

type SnapshotSourceRow = Parameters<typeof rowToSnapshot>[0];

interface MetricBucketQueryRow extends SnapshotSourceRow {
  id: string;
  siteId: string;
  entityType: BucketEntityType;
  entityId: string;
  entityName: string;
  path: string;
  granularity: BucketGranularity;
  granularityName: string;
  startTime: Date;
  durationSeconds: number;
  shiftInstanceId: string | null;
  businessDate: Date | null;
  businessShift: string | null;
  updatedAt: Date;
}

export type MetricValue = number | string | boolean | null;

export interface MetricValueRequest {
  entityType: BucketEntityType;
  entityId: string;
  metricKey: string;
  args?: {
    granularity: BucketGranularity;
  };
}

export interface CurrentMetricValue {
  siteId: string;
  request: MetricValueRequest;
  sourceType: "bucket" | "live";
  value: MetricValue;
  observedAt: Date;
  entityName: string;
  path: string;
  granularity?: BucketGranularity;
  granularityName?: string;
  startTime?: Date;
  durationSeconds?: number;
  shiftInstanceId?: string | null;
  businessDate?: Date | null;
  businessShift?: string | null;
}

export interface EntitySubscription {
  entityType: BucketEntityType;
  entityId: string;
  granularities: BucketGranularity[];
}

export interface GetBucketsInput {
  siteId: string;
  entities: EntitySubscription[];
  startTime?: Date;
  endTime?: Date;
  businessDate?: Date;
  limit?: number;
  offset?: number;
}

export interface BucketRow {
  id: string;
  siteId: string;
  entityType: BucketEntityType;
  entityId: string;
  entityName: string;
  path: string;
  granularity: BucketGranularity;
  granularityName: string;
  startTime: Date;
  durationSeconds: number;
  shiftInstanceId: string | null;
  businessDate: Date | null;
  businessShift: string | null;
  snapshot: BucketSnapshot;
}

interface StationStatusRow {
  stationId: string;
  state: "UP" | "DOWN";
  status: "FAST" | "SLOW" | "UP" | "DOWN" | null;
  updatedAt: Date;
}

interface StationMetadataRow {
  id: string;
  name: string;
}

type BucketMetricValueRequest = MetricValueRequest & {
  args: {
    granularity: BucketGranularity;
  };
};

function metricValueKey(entityType: BucketEntityType, entityId: string, granularity: BucketGranularity): string {
  return `${entityType}:${entityId}:${granularity}`;
}

async function resolveMetadata(
  siteId: string,
  entityType: BucketEntityType,
  entityId: string,
  knownName: string | undefined,
  knownPath: string | undefined,
  ctx: MetricsContext,
): Promise<{ entityName: string; path: string }> {
  const [entityName, path] = await Promise.all([
    resolveEntityName(entityType, entityId, knownName, ctx),
    resolveEntityPath(entityType, entityId, siteId, knownPath, ctx),
  ]);

  return { entityName, path };
}

export async function getBuckets(input: GetBucketsInput): Promise<BucketRow[]> {
  if (input.entities.length === 0) {
    return [];
  }

  const entityConditions = input.entities.map((entity) => ({
    entityType: entity.entityType,
    entityId: entity.entityId,
    granularity: { in: entity.granularities },
  }));

  const timeFilter: { gte?: Date; lt?: Date } | undefined =
    input.startTime || input.endTime
      ? {
          ...(input.startTime ? { gte: input.startTime } : {}),
          ...(input.endTime ? { lt: input.endTime } : {}),
        }
      : undefined;

  const rows: MetricBucketQueryRow[] = await prisma.metricBucket.findMany({
    where: {
      siteId: input.siteId,
      OR: entityConditions,
      ...(timeFilter ? { startTime: timeFilter } : {}),
      ...(input.businessDate ? { businessDate: input.businessDate } : {}),
    },
    orderBy: [{ entityType: "asc" }, { entityId: "asc" }, { granularity: "asc" }, { startTime: "asc" }],
    take: input.limit ?? 200,
    skip: input.offset ?? 0,
  });

  return rows.map((row) => ({
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
    snapshot: rowToSnapshot(row),
  }));
}

export async function getCurrentBucketMetricValues(input: {
  siteId: string;
  requests: BucketMetricValueRequest[];
}): Promise<CurrentMetricValue[]> {
  if (input.requests.length === 0) {
    return [];
  }

  const ctx = new MetricsContext();
  const queryKeys = new Set(
    input.requests.map((request) => metricValueKey(request.entityType, request.entityId, request.args.granularity)),
  );
  const rows = await prisma.metricBucket.findMany({
    where: {
      siteId: input.siteId,
      OR: input.requests.map((request) => ({
        entityType: request.entityType,
        entityId: request.entityId,
        granularity: request.args.granularity,
      })),
    },
    orderBy: [
      { entityType: "asc" },
      { entityId: "asc" },
      { granularity: "asc" },
      { startTime: "desc" },
      { updatedAt: "desc" },
    ],
  });

  const latestRowByKey = new Map<string, MetricBucketQueryRow>();
  for (const row of rows) {
    const key = metricValueKey(row.entityType, row.entityId, row.granularity);
    if (!queryKeys.has(key) || latestRowByKey.has(key)) {
      continue;
    }

    latestRowByKey.set(key, row);
  }

  return Promise.all(
    input.requests.map(async (request) => {
      const row = latestRowByKey.get(metricValueKey(request.entityType, request.entityId, request.args.granularity));
      const snapshot = row ? (rowToSnapshot(row) as unknown as Record<string, MetricValue>) : null;
      const metadata = await resolveMetadata(
        input.siteId,
        request.entityType,
        request.entityId,
        row?.entityName,
        row?.path,
        ctx,
      );

      return {
        siteId: input.siteId,
        request,
        sourceType: "bucket" as const,
        value: snapshot?.[request.metricKey] ?? null,
        observedAt: row?.updatedAt ?? new Date(0),
        entityName: metadata.entityName,
        path: metadata.path,
        granularity: row?.granularity ?? request.args.granularity,
        granularityName: row?.granularityName,
        startTime: row?.startTime,
        durationSeconds: row?.durationSeconds,
        shiftInstanceId: row?.shiftInstanceId ?? null,
        businessDate: row?.businessDate ?? null,
        businessShift: row?.businessShift ?? null,
      };
    }),
  );
}

export async function getCurrentStationStatusValues(input: {
  siteId: string;
  requests: MetricValueRequest[];
}): Promise<CurrentMetricValue[]> {
  if (input.requests.length === 0) {
    return [];
  }

  const ctx = new MetricsContext();
  const stationIds = [...new Set(input.requests.map((request) => request.entityId))];
  const [stations, openStates] = await Promise.all([
    prisma.station.findMany({
      where: {
        siteId: input.siteId,
        id: { in: stationIds },
      },
      select: {
        id: true,
        name: true,
      },
    }),
    prisma.stationStateLog.findMany({
      where: {
        stationId: { in: stationIds },
        endTime: null,
        deletedAt: null,
        station: { is: { siteId: input.siteId } },
      },
      select: {
        stationId: true,
        state: true,
        status: true,
        updatedAt: true,
      },
      orderBy: [{ stationId: "asc" }, { startTime: "desc" }],
    }),
  ]);

  const stationById = new Map<string, StationMetadataRow>(stations.map((station) => [station.id, station]));
  const openStateByStationId = new Map<string, StationStatusRow>();
  for (const row of openStates) {
    if (!openStateByStationId.has(row.stationId)) {
      openStateByStationId.set(row.stationId, row);
    }
  }

  return Promise.all(
    input.requests.map(async (request) => {
      const station = stationById.get(request.entityId);
      const openState = openStateByStationId.get(request.entityId);
      const metadata = await resolveMetadata(
        input.siteId,
        request.entityType,
        request.entityId,
        station?.name,
        undefined,
        ctx,
      );

      return {
        siteId: input.siteId,
        request,
        sourceType: "live" as const,
        value: openState?.status ?? openState?.state ?? null,
        observedAt: openState?.updatedAt ?? new Date(0),
        entityName: metadata.entityName,
        path: metadata.path,
      };
    }),
  );
}

export async function getCurrentStationStatusReasonValues(input: {
  siteId: string;
  requests: MetricValueRequest[];
}): Promise<CurrentMetricValue[]> {
  if (input.requests.length === 0) {
    return [];
  }

  const ctx = new MetricsContext();
  const stationIds = [...new Set(input.requests.map((request) => request.entityId))];
  const [stations, openStates] = await Promise.all([
    prisma.station.findMany({
      where: {
        siteId: input.siteId,
        id: { in: stationIds },
      },
      select: {
        id: true,
        name: true,
      },
    }),
    prisma.stationStateLog.findMany({
      where: {
        stationId: { in: stationIds },
        endTime: null,
        deletedAt: null,
        station: { is: { siteId: input.siteId } },
      },
      select: {
        stationId: true,
        statusReasonId: true,
        updatedAt: true,
      },
      orderBy: [{ stationId: "asc" }, { startTime: "desc" }],
    }),
  ]);

  const stationById = new Map(stations.map((station) => [station.id, station]));
  const openStateByStationId = new Map<string, (typeof openStates)[number]>();
  for (const row of openStates) {
    if (!openStateByStationId.has(row.stationId)) {
      openStateByStationId.set(row.stationId, row);
    }
  }

  return Promise.all(
    input.requests.map(async (request) => {
      const station = stationById.get(request.entityId);
      const openState = openStateByStationId.get(request.entityId);
      const metadata = await resolveMetadata(
        input.siteId,
        request.entityType,
        request.entityId,
        station?.name,
        undefined,
        ctx,
      );

      return {
        siteId: input.siteId,
        request,
        sourceType: "live" as const,
        value: openState?.statusReasonId ?? null,
        observedAt: openState?.updatedAt ?? new Date(0),
        entityName: metadata.entityName,
        path: metadata.path,
      };
    }),
  );
}

export async function getCurrentStationJobValues(input: {
  siteId: string;
  requests: MetricValueRequest[];
}): Promise<CurrentMetricValue[]> {
  if (input.requests.length === 0) {
    return [];
  }

  const ctx = new MetricsContext();
  const stationIds = [...new Set(input.requests.map((request) => request.entityId))];
  const stations = await prisma.station.findMany({
    where: {
      siteId: input.siteId,
      id: { in: stationIds },
    },
    select: {
      id: true,
      name: true,
      updatedAt: true,
      currentJob: {
        select: {
          currentBlob: {
            select: { name: true },
          },
        },
      },
    },
  });

  const stationById = new Map(stations.map((station) => [station.id, station]));

  return Promise.all(
    input.requests.map(async (request) => {
      const station = stationById.get(request.entityId);
      const jobName = station?.currentJob?.currentBlob?.name ?? null;
      const metadata = await resolveMetadata(
        input.siteId,
        request.entityType,
        request.entityId,
        station?.name,
        undefined,
        ctx,
      );

      return {
        siteId: input.siteId,
        request,
        sourceType: "live" as const,
        value: jobName,
        observedAt: station?.updatedAt ?? new Date(0),
        entityName: metadata.entityName,
        path: metadata.path,
      };
    }),
  );
}

export async function getCurrentStationShiftValues(input: {
  siteId: string;
  requests: MetricValueRequest[];
}): Promise<CurrentMetricValue[]> {
  if (input.requests.length === 0) {
    return [];
  }

  const ctx = new MetricsContext();
  const now = new Date();

  const stationRequests = input.requests.filter((r) => r.entityType === "STATION");
  const workcenterRequests = input.requests.filter((r) => r.entityType === "WORKCENTER");

  const stationIds = [...new Set(stationRequests.map((r) => r.entityId))];
  const workcenterIds = [...new Set(workcenterRequests.map((r) => r.entityId))];

  const [stationRows, workcenterRows] = await Promise.all([
    stationIds.length === 0
      ? Promise.resolve(
          [] as Array<{
            entityId: string;
            entityName: string;
            shiftName: string | null;
            shiftInstanceId: string | null;
          }>,
        )
      : prisma.$queryRaw<
          Array<{
            entityId: string;
            entityName: string;
            shiftName: string | null;
            shiftInstanceId: string | null;
          }>
        >`
          SELECT
            s.id   AS "entityId",
            s.name AS "entityName",
            COALESCE(wc_shift."shiftName", site_shift."shiftName") AS "shiftName",
            COALESCE(wc_shift."shiftInstanceId", site_shift."shiftInstanceId") AS "shiftInstanceId"
          FROM "Station" s
          LEFT JOIN LATERAL (
            SELECT si."shiftName", si.id AS "shiftInstanceId"
            FROM "ShiftInstance" si
            JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
            WHERE si."workCenterId" = s."workcenterId"
              AND si."startTime" <= ${now}
              AND si."endTime"   >  ${now}
            ORDER BY sa."rotationStartDate" DESC
            LIMIT 1
          ) wc_shift ON true
          LEFT JOIN LATERAL (
            SELECT si."shiftName", si.id AS "shiftInstanceId"
            FROM "ShiftInstance" si
            JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
            WHERE si."siteId" = s."siteId"
              AND si."workCenterId" IS NULL
              AND si."startTime" <= ${now}
              AND si."endTime"   >  ${now}
            ORDER BY sa."rotationStartDate" DESC
            LIMIT 1
          ) site_shift ON wc_shift."shiftName" IS NULL
          WHERE s."siteId" = ${input.siteId}::uuid
            AND s.id = ANY(${stationIds}::uuid[])
            AND s."deletedAt" IS NULL
        `,
    workcenterIds.length === 0
      ? Promise.resolve(
          [] as Array<{
            entityId: string;
            entityName: string;
            shiftName: string | null;
            shiftInstanceId: string | null;
          }>,
        )
      : prisma.$queryRaw<
          Array<{
            entityId: string;
            entityName: string;
            shiftName: string | null;
            shiftInstanceId: string | null;
          }>
        >`
          SELECT
            wc.id   AS "entityId",
            wc.name AS "entityName",
            COALESCE(wc_shift."shiftName", site_shift."shiftName") AS "shiftName",
            COALESCE(wc_shift."shiftInstanceId", site_shift."shiftInstanceId") AS "shiftInstanceId"
          FROM "Workcenter" wc
          LEFT JOIN LATERAL (
            SELECT si."shiftName", si.id AS "shiftInstanceId"
            FROM "ShiftInstance" si
            JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
            WHERE si."workCenterId" = wc.id
              AND si."startTime" <= ${now}
              AND si."endTime"   >  ${now}
            ORDER BY sa."rotationStartDate" DESC
            LIMIT 1
          ) wc_shift ON true
          LEFT JOIN LATERAL (
            SELECT si."shiftName", si.id AS "shiftInstanceId"
            FROM "ShiftInstance" si
            JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
            WHERE si."siteId" = wc."siteId"
              AND si."workCenterId" IS NULL
              AND si."startTime" <= ${now}
              AND si."endTime"   >  ${now}
            ORDER BY sa."rotationStartDate" DESC
            LIMIT 1
          ) site_shift ON wc_shift."shiftName" IS NULL
          WHERE wc."siteId" = ${input.siteId}::uuid
            AND wc.id = ANY(${workcenterIds}::uuid[])
        `,
  ]);

  const rowByKey = new Map<string, (typeof stationRows)[number]>();
  for (const row of stationRows) rowByKey.set(`STATION:${row.entityId}`, row);
  for (const row of workcenterRows) rowByKey.set(`WORKCENTER:${row.entityId}`, row);

  return Promise.all(
    input.requests.map(async (request) => {
      const row = rowByKey.get(`${request.entityType}:${request.entityId}`);
      const metadata = await resolveMetadata(
        input.siteId,
        request.entityType,
        request.entityId,
        row?.entityName,
        undefined,
        ctx,
      );

      const value =
        request.metricKey === "currentShiftInstanceId" ? (row?.shiftInstanceId ?? null) : (row?.shiftName ?? null);

      return {
        siteId: input.siteId,
        request,
        sourceType: "live" as const,
        value,
        observedAt: now,
        entityName: metadata.entityName,
        path: metadata.path,
      };
    }),
  );
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export async function getCurrentStationLastCycleValues(input: {
  siteId: string;
  requests: MetricValueRequest[];
}): Promise<CurrentMetricValue[]> {
  if (input.requests.length === 0) {
    return [];
  }

  const ctx = new MetricsContext();
  const stationIds = [...new Set(input.requests.map((request) => request.entityId))];

  const rows = await prisma.$queryRaw<
    Array<{
      stationId: string;
      stationName: string;
      cycleSeconds: number | null;
      cycleEnd: Date | null;
    }>
  >`
    SELECT
      s.id   AS "stationId",
      s.name AS "stationName",
      EXTRACT(EPOCH FROM (last_cycle."end" - last_cycle.start))::float8 AS "cycleSeconds",
      last_cycle."end" AS "cycleEnd"
    FROM "Station" s
    LEFT JOIN LATERAL (
      SELECT c.start, c."end"
      FROM "Cycle" c
      WHERE c."stationId" = s.id
        AND c."end" IS NOT NULL
      ORDER BY c."end" DESC
      LIMIT 1
    ) last_cycle ON true
    WHERE s."siteId" = ${input.siteId}::uuid
      AND s.id = ANY(${stationIds}::uuid[])
      AND s."deletedAt" IS NULL
  `;

  const rowByStationId = new Map(rows.map((r) => [r.stationId, r]));

  return Promise.all(
    input.requests.map(async (request) => {
      const row = rowByStationId.get(request.entityId);
      const metadata = await resolveMetadata(
        input.siteId,
        request.entityType,
        request.entityId,
        row?.stationName,
        undefined,
        ctx,
      );

      return {
        siteId: input.siteId,
        request,
        sourceType: "live" as const,
        value: row?.cycleSeconds == null ? null : roundToTenth(row.cycleSeconds),
        observedAt: row?.cycleEnd ?? new Date(0),
        entityName: metadata.entityName,
        path: metadata.path,
      };
    }),
  );
}

export async function getCurrentStationLogonValues(input: {
  siteId: string;
  requests: MetricValueRequest[];
}): Promise<CurrentMetricValue[]> {
  if (input.requests.length === 0) {
    return [];
  }

  const ctx = new MetricsContext();
  const stationIds = [...new Set(input.requests.map((request) => request.entityId))];

  const [stations, sessions] = await Promise.all([
    prisma.station.findMany({
      where: { siteId: input.siteId, id: { in: stationIds } },
      select: { id: true, name: true },
    }),
    prisma.stationLogonSession.findMany({
      where: {
        stationId: { in: stationIds },
        logoffTime: null,
        station: { is: { siteId: input.siteId } },
      },
      select: {
        stationId: true,
        logonTime: true,
        genericName: true,
        version: { select: { firstName: true, lastName: true, employeeNumber: true } },
      },
      orderBy: [{ stationId: "asc" }, { logonTime: "asc" }],
    }),
  ]);

  const stationById = new Map(stations.map((station) => [station.id, station]));
  const sessionsByStationId = new Map<string, typeof sessions>();
  for (const session of sessions) {
    const list = sessionsByStationId.get(session.stationId);
    if (list) list.push(session);
    else sessionsByStationId.set(session.stationId, [session]);
  }

  return Promise.all(
    input.requests.map(async (request) => {
      const station = stationById.get(request.entityId);
      const list = sessionsByStationId.get(request.entityId) ?? [];
      const observedAt = list.reduce<Date>((acc, s) => (s.logonTime > acc ? s.logonTime : acc), new Date(0));
      const metadata = await resolveMetadata(
        input.siteId,
        request.entityType,
        request.entityId,
        station?.name,
        undefined,
        ctx,
      );

      return {
        siteId: input.siteId,
        request,
        sourceType: "live" as const,
        value: formatStationLogons(list),
        observedAt,
        entityName: metadata.entityName,
        path: metadata.path,
      };
    }),
  );
}

export async function getCurrentStationStandardCycleValues(input: {
  siteId: string;
  requests: MetricValueRequest[];
}): Promise<CurrentMetricValue[]> {
  if (input.requests.length === 0) {
    return [];
  }

  const ctx = new MetricsContext();
  const stationIds = [...new Set(input.requests.map((request) => request.entityId))];

  const stations = await prisma.station.findMany({
    where: {
      siteId: input.siteId,
      id: { in: stationIds },
    },
    select: {
      id: true,
      name: true,
      updatedAt: true,
      currentJob: {
        select: {
          currentBlob: {
            select: { standardCycle: true },
          },
        },
      },
    },
  });

  const stationById = new Map(stations.map((station) => [station.id, station]));

  return Promise.all(
    input.requests.map(async (request) => {
      const station = stationById.get(request.entityId);
      const standardCycle = station?.currentJob?.currentBlob?.standardCycle;
      const value = standardCycle == null ? null : roundToTenth(Number(standardCycle));
      const metadata = await resolveMetadata(
        input.siteId,
        request.entityType,
        request.entityId,
        station?.name,
        undefined,
        ctx,
      );

      return {
        siteId: input.siteId,
        request,
        sourceType: "live" as const,
        value,
        observedAt: station?.updatedAt ?? new Date(0),
        entityName: metadata.entityName,
        path: metadata.path,
      };
    }),
  );
}
