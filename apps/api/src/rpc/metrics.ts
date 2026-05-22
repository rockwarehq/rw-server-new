import { ORPCError, eventIterator } from "@orpc/server";
import * as z from "zod";
import prisma from "@rw/db";
import { Principal } from "../services/auth/index.js";
import { METRIC_CATALOG_REGISTRY } from "@rw/services/metric-catalog/index";
import { MetricsContext } from "@rw/services/metrics/context";
import * as query from "../services/metrics.js";
import { getShiftForEntity } from "@rw/services/metrics/shift";
import { rowToSnapshot } from "@rw/services/metrics/sync";
import { userOrDisplayRequired } from "./middleware.js";
import {
  subscribeMetricChanges,
  subscribeMetricValueChanges,
  type MetricValueEvent,
} from "@rw/services/rpc/metrics-bus";

const entityTypeSchema = z.enum(["STATION", "WORKCENTER", "SITE", "JOB"]);
const granularitySchema = z.enum(["MINUTE", "HOUR", "SHIFT", "DAY"]);

const entitySubscriptionSchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.uuid(),
  granularities: z.array(granularitySchema).min(1),
});

const snapshotSchema = z.object({
  totalCycles: z.number(),
  goodCycles: z.number(),
  badCycles: z.number(),
  totalItems: z.number(),
  goodItems: z.number(),
  badItems: z.number(),
  expectedCycles: z.number(),
  expectedItems: z.number(),
  runSeconds: z.number(),
  downSeconds: z.number(),
  plannedDownSeconds: z.number(),
  unplannedDownSeconds: z.number(),
  plannedProductionSeconds: z.number(),
  idealCycleSeconds: z.number(),
  totalCycleSeconds: z.number(),
  elapsedExpectedCycles: z.number(),
  elapsedExpectedItems: z.number(),
  elapsedPlannedProductionSeconds: z.number(),
  currentStandardCycle: z.number().nullable(),
  availability: z.number().nullable(),
  performance: z.number().nullable(),
  quality: z.number().nullable(),
  oee: z.number().nullable(),
  shiftInstanceId: z.uuid().nullable(),
});

const metricChangeSchema = z.object({
  siteId: z.uuid(),
  entityType: entityTypeSchema,
  entityId: z.uuid(),
  entityName: z.string(),
  path: z.string(),
  granularity: granularitySchema,
  granularityName: z.string(),
  startTime: z.iso.datetime(),
  durationSeconds: z.number(),
  shiftInstanceId: z.uuid().nullable(),
  businessDate: z.iso.datetime().nullable(),
  businessShift: z.string().nullable(),
  snapshot: snapshotSchema,
});

const bucketSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  entityType: entityTypeSchema,
  entityId: z.uuid(),
  entityName: z.string(),
  path: z.string(),
  granularity: granularitySchema,
  granularityName: z.string(),
  startTime: z.iso.datetime(),
  durationSeconds: z.number(),
  shiftInstanceId: z.uuid().nullable(),
  businessDate: z.iso.datetime().nullable(),
  businessShift: z.string().nullable(),
  snapshot: snapshotSchema,
});

const streamInputSchema = z.object({
  siteId: z.uuid(),
  entities: z.array(entitySubscriptionSchema).min(1),
});

const getBucketsInputSchema = z.object({
  siteId: z.uuid(),
  entities: z.array(entitySubscriptionSchema).min(1),
  startTime: z.iso.datetime().optional(),
  endTime: z.iso.datetime().optional(),
  businessDate: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});

const shiftValueEntitySchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.uuid(),
});

const getShiftValuesInputSchema = z.object({
  siteId: z.uuid(),
  entities: z.array(shiftValueEntitySchema).min(1),
  metricKeys: z.array(z.string().min(1)).min(1),
  timestamp: z.iso.datetime().optional(),
});

const shiftValueSchema = z
  .object({
    startTime: z.iso.datetime(),
    durationSeconds: z.number(),
    shiftInstanceId: z.uuid().nullable(),
    businessDate: z.iso.datetime().nullable(),
    businessShift: z.string().nullable(),
  })
  .nullable();

const getShiftValuesRowSchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.uuid(),
  shift: shiftValueSchema,
  values: z.record(z.string(), z.number().nullable()),
});

const getShiftValuesOutputSchema = z.object({
  data: z.array(getShiftValuesRowSchema),
});

const metricValueRequestInputSchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.uuid(),
  metricKey: z.string().min(1),
  args: z.unknown().optional(),
});

const metricValueRequestSchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.uuid(),
  metricKey: z.string().min(1),
  args: z
    .object({
      granularity: granularitySchema,
    })
    .optional(),
});

const metricValuePrimitiveSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);

const streamValuesInputSchema = z.object({
  siteId: z.uuid(),
  requests: z.array(metricValueRequestInputSchema).min(1),
});

const streamValueEventSchema = z.object({
  siteId: z.uuid(),
  request: metricValueRequestSchema,
  sourceType: z.enum(["bucket", "live"]),
  value: metricValuePrimitiveSchema,
  observedAt: z.iso.datetime(),
  initial: z.boolean(),
  entityName: z.string(),
  path: z.string(),
  granularity: granularitySchema.optional(),
  granularityName: z.string().optional(),
  startTime: z.iso.datetime().optional(),
  durationSeconds: z.number().optional(),
  shiftInstanceId: z.uuid().nullable().optional(),
  businessDate: z.iso.datetime().nullable().optional(),
  businessShift: z.string().nullable().optional(),
});

type MetricCatalogDefinition = (typeof METRIC_CATALOG_REGISTRY)[number];
type MetricValueRequestInput = z.infer<typeof metricValueRequestInputSchema>;
type NormalizedMetricValueRequest = query.MetricValueRequest & {
  sourceType: "bucket" | "live";
};
type StreamValueRecord = query.CurrentMetricValue;

const METRIC_CATALOG_MAP = new Map<string, MetricCatalogDefinition>(
  METRIC_CATALOG_REGISTRY.map((definition) => [definition.key, definition]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`);

  return `{${entries.join(",")}}`;
}

function metricValueRequestKey(request: query.MetricValueRequest): string {
  return `${request.entityType}:${request.entityId}:${request.metricKey}:${stableStringify(request.args ?? null)}`;
}

function normalizeMetricValueRequest(request: MetricValueRequestInput): NormalizedMetricValueRequest {
  const definition = METRIC_CATALOG_MAP.get(request.metricKey);
  if (!definition) {
    throw new ORPCError("BAD_REQUEST", { message: `Unknown metric key '${request.metricKey}'` });
  }

  if (!definition.entityTypes.some((entityType) => entityType === request.entityType)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Metric key '${request.metricKey}' does not support entity type '${request.entityType}'`,
    });
  }

  if (definition.granularities.some((granularity) => granularity === "LIVE")) {
    if (request.args !== undefined) {
      throw new ORPCError("BAD_REQUEST", { message: `Metric key '${request.metricKey}' does not accept args` });
    }

    return {
      entityType: request.entityType,
      entityId: request.entityId,
      metricKey: request.metricKey,
      sourceType: "live",
    };
  }

  if (!isRecord(request.args)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Metric key '${request.metricKey}' requires args.granularity`,
    });
  }

  const granularity = request.args.granularity;
  if (
    typeof granularity !== "string" ||
    !definition.granularities.some((supportedGranularity) => supportedGranularity === granularity)
  ) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Metric key '${request.metricKey}' requires a supported args.granularity`,
    });
  }

  return {
    entityType: request.entityType,
    entityId: request.entityId,
    metricKey: request.metricKey,
    args: { granularity: granularity as query.BucketGranularity },
    sourceType: "bucket",
  };
}

function metricValueEventKey(event: MetricValueEvent): string {
  return metricValueRequestKey({
    entityType: event.entityType,
    entityId: event.entityId,
    metricKey: event.metricKey,
    ...(event.args ? { args: event.args as { granularity: query.BucketGranularity } } : {}),
  });
}

function metricValueEventToRecord(event: MetricValueEvent, request: NormalizedMetricValueRequest): StreamValueRecord {
  return {
    siteId: event.siteId,
    request: {
      entityType: request.entityType,
      entityId: request.entityId,
      metricKey: request.metricKey,
      ...(request.args ? { args: request.args } : {}),
    },
    sourceType: event.sourceType,
    value: event.value,
    observedAt: event.observedAt,
    entityName: event.entityName,
    path: event.path,
    granularity: event.granularity,
    granularityName: event.granularityName,
    startTime: event.startTime,
    durationSeconds: event.durationSeconds,
    shiftInstanceId: event.shiftInstanceId,
    businessDate: event.businessDate,
    businessShift: event.businessShift,
  };
}

function serializeStreamValueRecord(record: StreamValueRecord, initial: boolean) {
  return {
    siteId: record.siteId,
    request: record.request,
    sourceType: record.sourceType,
    value: record.value,
    observedAt: record.observedAt.toISOString(),
    initial,
    entityName: record.entityName,
    path: record.path,
    granularity: record.granularity,
    granularityName: record.granularityName,
    startTime: record.startTime?.toISOString(),
    durationSeconds: record.durationSeconds,
    shiftInstanceId: record.shiftInstanceId,
    businessDate: record.businessDate?.toISOString() ?? null,
    businessShift: record.businessShift ?? null,
  };
}

function createAsyncQueue<T>() {
  const items: T[] = [];
  const waiters: Array<(value: T | null) => void> = [];
  let closed = false;

  return {
    push(value: T) {
      if (closed) {
        return;
      }

      const waiter = waiters.shift();
      if (waiter) {
        waiter(value);
        return;
      }

      items.push(value);
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter(null);
      }
    },
    async shift(): Promise<T | null> {
      if (items.length > 0) {
        return items.shift() ?? null;
      }

      if (closed) {
        return null;
      }

      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

export async function* filterMetricValueEvents(
  events: AsyncIterable<MetricValueEvent>,
  siteId: string,
  requestKeys: ReadonlySet<string>,
): AsyncGenerator<MetricValueEvent> {
  for await (const event of events) {
    if (event.siteId !== siteId) {
      continue;
    }

    if (!requestKeys.has(metricValueEventKey(event))) {
      continue;
    }

    yield event;
  }
}

async function getCurrentStreamValues(
  siteId: string,
  requests: NormalizedMetricValueRequest[],
): Promise<StreamValueRecord[]> {
  const bucketRequests = requests.filter((request) => request.sourceType === "bucket") as Array<
    NormalizedMetricValueRequest & { args: { granularity: query.BucketGranularity } }
  >;
  const liveRequests = requests.filter((request) => request.sourceType === "live");
  const statusRequests = liveRequests.filter((request) => request.metricKey === "status");
  const statusReasonRequests = liveRequests.filter((request) => request.metricKey === "statusReason");
  const jobRequests = liveRequests.filter((request) => request.metricKey === "currentJob");
  const shiftRequests = liveRequests.filter(
    (request) => request.metricKey === "currentShift" || request.metricKey === "currentShiftInstanceId",
  );
  const lastCycleRequests = liveRequests.filter((request) => request.metricKey === "lastCycleSeconds");
  const standardCycleRequests = liveRequests.filter((request) => request.metricKey === "standardCycleSeconds");
  const logonRequests = liveRequests.filter((request) => request.metricKey === "currentLogons");

  const [
    bucketValues,
    statusValues,
    statusReasonValues,
    jobValues,
    shiftValues,
    lastCycleValues,
    standardCycleValues,
    logonValues,
  ] = await Promise.all([
    query.getCurrentBucketMetricValues({ siteId, requests: bucketRequests }),
    query.getCurrentStationStatusValues({ siteId, requests: statusRequests }),
    query.getCurrentStationStatusReasonValues({ siteId, requests: statusReasonRequests }),
    query.getCurrentStationJobValues({ siteId, requests: jobRequests }),
    query.getCurrentStationShiftValues({ siteId, requests: shiftRequests }),
    query.getCurrentStationLastCycleValues({ siteId, requests: lastCycleRequests }),
    query.getCurrentStationStandardCycleValues({ siteId, requests: standardCycleRequests }),
    query.getCurrentStationLogonValues({ siteId, requests: logonRequests }),
  ]);

  const valuesByKey = new Map<string, StreamValueRecord>();
  for (const value of [
    ...bucketValues,
    ...statusValues,
    ...statusReasonValues,
    ...jobValues,
    ...shiftValues,
    ...lastCycleValues,
    ...standardCycleValues,
    ...logonValues,
  ]) {
    valuesByKey.set(metricValueRequestKey(value.request), value);
  }

  return requests.map((request) => {
    const value = valuesByKey.get(metricValueRequestKey(request));
    if (!value) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: `Missing current value for metric key '${request.metricKey}'`,
      });
    }

    return value;
  });
}

async function assertSiteAccess(siteId: string, workspaceId: string): Promise<void> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { workspaceId: true },
  });

  if (!site) {
    throw new ORPCError("NOT_FOUND", { message: "Site not found" });
  }

  if (site.workspaceId !== workspaceId) {
    throw new ORPCError("FORBIDDEN", { message: "Site does not belong to this workspace" });
  }
}

async function assertRuntimeSiteAccess(
  iam: { principal: string; workspaceId?: string; siteId?: string },
  siteId: string,
): Promise<void> {
  if (iam.principal === Principal.DISPLAY) {
    if (iam.siteId !== siteId) {
      throw new ORPCError("FORBIDDEN", { message: "Display can only access metrics for its site" });
    }

    return;
  }

  if (!iam.workspaceId) {
    throw new ORPCError("UNAUTHORIZED", { message: "Workspace context required" });
  }

  await assertSiteAccess(siteId, iam.workspaceId);
}

export const stream = userOrDisplayRequired
  .input(streamInputSchema)
  .output(eventIterator(metricChangeSchema))
  .handler(async function* ({ context, input, signal }) {
    await assertRuntimeSiteAccess(context.iam, input.siteId);

    const subscriptions = new Map<string, Set<string>>();
    for (const entity of input.entities) {
      const key = `${entity.entityType}:${entity.entityId}`;
      const granularities = subscriptions.get(key) ?? new Set<string>();
      for (const granularity of entity.granularities) {
        granularities.add(granularity);
      }
      subscriptions.set(key, granularities);
    }

    for await (const change of subscribeMetricChanges({ signal })) {
      if (change.siteId !== input.siteId) {
        continue;
      }

      const granularities = subscriptions.get(`${change.entityType}:${change.entityId}`);
      if (!granularities?.has(change.granularity)) {
        continue;
      }

      yield {
        ...change,
        startTime: change.startTime.toISOString(),
        businessDate: change.businessDate?.toISOString() ?? null,
      };
    }
  });

export const streamValues = userOrDisplayRequired
  .input(streamValuesInputSchema)
  .output(eventIterator(streamValueEventSchema))
  .handler(async function* ({ context, input, signal }) {
    await assertRuntimeSiteAccess(context.iam, input.siteId);

    const requestByKey = new Map<string, NormalizedMetricValueRequest>();
    for (const request of input.requests) {
      const normalized = normalizeMetricValueRequest(request);
      requestByKey.set(metricValueRequestKey(normalized), normalized);
    }

    const requestKeys = new Set(requestByKey.keys());
    const queue = createAsyncQueue<StreamValueRecord>();
    const bufferedEvents: StreamValueRecord[] = [];
    let buffering = true;

    const pump = (async () => {
      try {
        for await (const event of filterMetricValueEvents(
          subscribeMetricValueChanges({ signal }),
          input.siteId,
          requestKeys,
        )) {
          const request = requestByKey.get(metricValueEventKey(event));
          if (!request) {
            continue;
          }

          const record = metricValueEventToRecord(event, request);
          if (buffering) {
            bufferedEvents.push(record);
            continue;
          }

          queue.push(record);
        }
      } catch (err) {
        // Client disconnect aborts the signal mid-iteration. The generator
        // gets .return()'d before we reach `await pump`, so this rejection
        // would otherwise escape as an unhandledRejection and trip
        // close-with-grace into shutting the whole server down.
        if ((err as { name?: string })?.name !== "AbortError") {
          throw err;
        }
      } finally {
        queue.close();
      }
    })();

    const currentValues = await getCurrentStreamValues(input.siteId, [...requestByKey.values()]);
    buffering = false;

    const observedAtByKey = new Map(
      currentValues.map((value) => [metricValueRequestKey(value.request), value.observedAt.getTime()]),
    );

    for (const value of currentValues) {
      yield serializeStreamValueRecord(value, true);
    }

    for (const value of bufferedEvents) {
      const lastObservedAt = observedAtByKey.get(metricValueRequestKey(value.request)) ?? 0;
      if (value.observedAt.getTime() <= lastObservedAt) {
        continue;
      }

      yield serializeStreamValueRecord(value, false);
    }

    while (true) {
      const value = await queue.shift();
      if (!value) {
        break;
      }

      yield serializeStreamValueRecord(value, false);
    }

    await pump;
  });

export const getBuckets = userOrDisplayRequired
  .input(getBucketsInputSchema)
  .output(z.array(bucketSchema))
  .handler(async ({ context, input }) => {
    await assertRuntimeSiteAccess(context.iam, input.siteId);

    const buckets = await query.getBuckets({
      siteId: input.siteId,
      entities: input.entities,
      startTime: input.startTime ? new Date(input.startTime) : undefined,
      endTime: input.endTime ? new Date(input.endTime) : undefined,
      businessDate: input.businessDate ? new Date(input.businessDate) : undefined,
      limit: input.limit,
      offset: input.offset,
    });

    return buckets.map((bucket) => ({
      ...bucket,
      startTime: bucket.startTime.toISOString(),
      businessDate: bucket.businessDate?.toISOString() ?? null,
    }));
  });

const SHIFT_METRIC_CATALOG_MAP = new Map(
  METRIC_CATALOG_REGISTRY.filter((definition) =>
    definition.granularities.some((granularity) => granularity === "SHIFT"),
  ).map((definition) => [definition.key, definition]),
);

type ShiftSnapshot = ReturnType<typeof rowToSnapshot>;
type ShiftMetricKey = (typeof METRIC_CATALOG_REGISTRY)[number]["key"];

export const getShiftValues = userOrDisplayRequired
  .input(getShiftValuesInputSchema)
  .output(getShiftValuesOutputSchema)
  .handler(async ({ context, input }) => {
    await assertRuntimeSiteAccess(context.iam, input.siteId);

    const uniqueMetricKeys = [...new Set(input.metricKeys)] as ShiftMetricKey[];

    for (const key of uniqueMetricKeys) {
      const definition = SHIFT_METRIC_CATALOG_MAP.get(key);
      if (!definition) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Metric key '${key}' is not available for SHIFT granularity`,
        });
      }

      const unsupportedEntityType = input.entities.find(
        (entity) => !definition.entityTypes.some((entityType) => entityType === entity.entityType),
      )?.entityType;

      if (unsupportedEntityType) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Metric key '${key}' does not support entity type '${unsupportedEntityType}'`,
        });
      }
    }

    const timestamp = input.timestamp ? new Date(input.timestamp) : new Date();
    const metricCtx = new MetricsContext();

    const resolvedShifts = await Promise.all(
      input.entities.map((entity) =>
        getShiftForEntity(entity.entityType, entity.entityId, input.siteId, timestamp, metricCtx),
      ),
    );

    const shiftQueries = input.entities.flatMap((entity, index) => {
      const shift = resolvedShifts[index];
      if (!shift) return [];
      return [
        {
          entityType: entity.entityType,
          entityId: entity.entityId,
          startTime: shift.startTime,
        },
      ];
    });

    const rows =
      shiftQueries.length > 0
        ? await prisma.metricBucket.findMany({
            where: {
              siteId: input.siteId,
              granularity: "SHIFT",
              OR: shiftQueries,
            },
          })
        : [];

    const rowByEntityAndStart = new Map<
      string,
      { snapshot: ShiftSnapshot; businessDate: Date | null; businessShift: string | null }
    >();
    for (const row of rows) {
      const key = `${row.entityType}:${row.entityId}:${row.startTime.getTime()}`;
      rowByEntityAndStart.set(key, {
        snapshot: rowToSnapshot(row),
        businessDate: row.businessDate,
        businessShift: row.businessShift,
      });
    }

    const data = input.entities.map((entity, index) => {
      const shift = resolvedShifts[index];
      if (!shift) {
        return {
          entityType: entity.entityType,
          entityId: entity.entityId,
          shift: null,
          values: {},
        };
      }

      const rowData = rowByEntityAndStart.get(`${entity.entityType}:${entity.entityId}:${shift.startTime.getTime()}`);
      if (!rowData) {
        return {
          entityType: entity.entityType,
          entityId: entity.entityId,
          shift: null,
          values: {},
        };
      }

      const { snapshot } = rowData;

      const values: Record<string, number | null> = {};
      for (const key of uniqueMetricKeys) {
        values[key] = snapshot[key as keyof ShiftSnapshot] as number | null;
      }

      return {
        entityType: entity.entityType,
        entityId: entity.entityId,
        shift: {
          startTime: shift.startTime.toISOString(),
          durationSeconds: shift.durationSeconds,
          shiftInstanceId: snapshot.shiftInstanceId,
          businessDate: rowData.businessDate?.toISOString() ?? null,
          businessShift: rowData.businessShift,
        },
        values,
      };
    });

    return { data };
  });
