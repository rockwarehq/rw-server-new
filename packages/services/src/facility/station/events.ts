import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { publishStreamEvent } from "@rw/infra/events-bus";
import { notifyStationEventCacheRefresh } from "../../processor/cache.js";
import { validateActionInput } from "./actions/index.js";
import { enqueueStationEventExecution } from "./execution.js";

export interface CreateStationEventInput {
  stationId: string;
  name: string;
  trigger: PrismaJson.EventTrigger;
  actions: PrismaJson.EventAction[];
}

export interface UpdateStationEventInput {
  stationId: string;
  eventId: string;
  expectedVersion: number;
  updates: {
    name?: string;
    enabled?: boolean;
    trigger?: PrismaJson.EventTrigger;
    actions?: PrismaJson.EventAction[];
  };
}

export interface TriggerStationEventInput {
  stationId: string;
  eventId: string;
  payload?: Record<string, unknown>;
}

export interface ListStationEventExecutionsOptions {
  limit?: number;
}

export interface StationEventExecutionActionResult {
  actionId: string;
  event: string;
  eventDisplayName?: string;
  status: "success" | "failed" | "skipped";
}

export interface StationEventExecutionListItem {
  id: string;
  stationId: string;
  eventId: string;
  status: "running" | "success" | "failed";
  triggeredAt: string;
  trigger?: {
    tagName?: string;
    deviceName?: string;
    previousValue?: number | string | boolean;
    actualValue?: number | string | boolean;
  };
  actionResults: StationEventExecutionActionResult[];
  error?: {
    code: string;
    message: string;
  } | null;
}

export interface ProcessorTagSnapshot {
  pointId: string;
  value: unknown;
  previousValue: unknown;
  quality?: "GOOD" | "BAD" | "UNKNOWN";
  timestamp?: string;
  gatewayTimestamp?: string;
  processorTimestamp?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function flattenTriggerConditions(clauses: PrismaJson.EventTriggerClause[]): PrismaJson.EventTriggerCondition[] {
  const conditions: PrismaJson.EventTriggerCondition[] = [];

  for (const clause of clauses) {
    if (clause.kind === "condition") {
      conditions.push(clause);
      continue;
    }

    conditions.push(...flattenTriggerConditions(clause.conditions));
  }

  return conditions;
}

function normalizeTriggerValue(value: unknown): number | string | boolean | undefined {
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  return undefined;
}

function validateEventActions(actions: PrismaJson.EventAction[]) {
  for (const [index, action] of actions.entries()) {
    const validation = validateActionInput(action.event, action.inputs);
    if (!validation.valid) {
      return {
        error: `${validation.message} (action index: ${index})`,
        code: validation.code,
      };
    }
  }

  return null;
}

async function validateStationWorkspace(stationId: string, workspaceId?: string) {
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: {
      id: true,
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!station) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  if (workspaceId && station.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  return { data: station };
}

export async function list(stationId: string, workspaceId?: string) {
  const stationResult = await validateStationWorkspace(stationId, workspaceId);
  if ("error" in stationResult) {
    return stationResult;
  }

  const events = await prisma.stationEvent.findMany({
    where: { stationId },
    orderBy: { createdAt: "desc" },
  });

  return { data: events };
}

export async function listExecutions(
  stationId: string,
  workspaceId?: string,
  options: ListStationEventExecutionsOptions = {},
) {
  const stationResult = await validateStationWorkspace(stationId, workspaceId);
  if ("error" in stationResult) {
    return stationResult;
  }

  const take = Math.max(1, Math.min(options.limit ?? 10, 100));

  const executions = await prisma.stationEventExecution.findMany({
    where: {
      stationEvent: {
        stationId,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take,
    select: {
      id: true,
      status: true,
      payload: true,
      createdAt: true,
      stationEvent: {
        select: {
          id: true,
          stationId: true,
          trigger: true,
          actions: true,
        },
      },
    },
  });

  const data: StationEventExecutionListItem[] = executions.map((execution) => {
    const trigger = execution.stationEvent.trigger as PrismaJson.EventTrigger;
    const actions = Array.isArray(execution.stationEvent.actions)
      ? (execution.stationEvent.actions as PrismaJson.EventAction[])
      : [];
    const payload = asRecord(execution.payload);
    const payloadTrigger = asRecord(payload.trigger);
    const payloadTagValues = asRecord(payload.tagValues);
    const matchedConditionIds = asStringArray(payloadTrigger.matchedConditionIds);
    const conditions = flattenTriggerConditions(trigger.clauses);

    const matchedCondition =
      conditions.find((condition) => matchedConditionIds.includes(condition.id)) || conditions[0];

    const tagSnapshot = matchedCondition ? asRecord(payloadTagValues[matchedCondition.tagId]) : {};

    const status = execution.status === "SUCCEEDED" ? "success" : execution.status === "FAILED" ? "failed" : "running";
    const actionStatus =
      execution.status === "SUCCEEDED" ? "success" : execution.status === "FAILED" ? "failed" : "skipped";

    return {
      id: execution.id,
      stationId: execution.stationEvent.stationId,
      eventId: execution.stationEvent.id,
      status,
      triggeredAt: execution.createdAt.toISOString(),
      trigger: matchedCondition
        ? {
            tagName: matchedCondition.tagName,
            deviceName: matchedCondition.deviceName,
            previousValue: normalizeTriggerValue(tagSnapshot.previousValue),
            actualValue: normalizeTriggerValue(tagSnapshot.value),
          }
        : undefined,
      actionResults: actions.map((action) => ({
        actionId: action.id,
        event: action.event,
        eventDisplayName: action.eventDisplayName,
        status: actionStatus,
      })),
      error:
        execution.status === "FAILED"
          ? {
              code: "EXECUTION_FAILED",
              message: "One or more station event actions failed.",
            }
          : null,
    };
  });

  return { data };
}

export async function listForProcessor(stationId?: string) {
  const where = stationId
    ? {
        enabled: true,
        stationId,
      }
    : {
        enabled: true,
      };

  const events = await prisma.stationEvent.findMany({
    where,
    orderBy: {
      updatedAt: "desc",
    },
    select: {
      id: true,
      stationId: true,
      enabled: true,
      trigger: true,
      actions: true,
    },
  });

  return {
    data: {
      events: events.map((event) => ({
        id: event.id,
        stationId: event.stationId,
        enabled: event.enabled,
        trigger: event.trigger as PrismaJson.EventTrigger,
        actions: event.actions as PrismaJson.EventAction[],
      })),
    },
  };
}

function parsePointIdFromTagKey(tagKey: string): string {
  const separatorIndex = tagKey.lastIndexOf(":");
  if (separatorIndex < 0) {
    return tagKey;
  }

  return tagKey.slice(separatorIndex + 1);
}

function normalizePointSnapshotValue(value: number | null, valueRaw: unknown): unknown {
  if (value !== null) {
    return value;
  }
  return valueRaw;
}

export async function getTagSnapshotsForProcessor(tagKeys: string[]) {
  const pointIds = Array.from(
    new Set(tagKeys.map((tagKey) => parsePointIdFromTagKey(tagKey)).filter((pointId) => UUID_PATTERN.test(pointId))),
  );

  if (pointIds.length === 0) {
    return {
      data: {
        snapshots: {} as Record<string, ProcessorTagSnapshot>,
      },
    };
  }

  const pointValues = await prisma.pointValue.findMany({
    where: {
      pointId: {
        in: pointIds,
      },
    },
    orderBy: [{ pointId: "asc" }, { timestamp: "desc" }],
    distinct: ["pointId"],
    select: {
      pointId: true,
      quality: true,
      value: true,
      previousValue: true,
      valueRaw: true,
      previousValueRaw: true,
      timestamp: true,
      gatewayTimestamp: true,
      processorTimestamp: true,
    },
  });

  const snapshotByPointId = new Map<string, ProcessorTagSnapshot>();
  for (const pointValue of pointValues) {
    snapshotByPointId.set(pointValue.pointId, {
      pointId: pointValue.pointId,
      quality: pointValue.quality,
      value: normalizePointSnapshotValue(pointValue.value, pointValue.valueRaw),
      previousValue: normalizePointSnapshotValue(pointValue.previousValue, pointValue.previousValueRaw ?? null),
      timestamp: pointValue.timestamp.toISOString(),
      gatewayTimestamp: pointValue.gatewayTimestamp.toISOString(),
      processorTimestamp: pointValue.processorTimestamp.toISOString(),
    });
  }

  const snapshots: Record<string, ProcessorTagSnapshot> = {};
  for (const tagKey of tagKeys) {
    const pointId = parsePointIdFromTagKey(tagKey);
    const snapshot = snapshotByPointId.get(pointId);
    if (snapshot) {
      snapshots[tagKey] = snapshot;
    }
  }

  return {
    data: {
      snapshots,
    },
  };
}

export async function create(input: CreateStationEventInput, workspaceId?: string) {
  const { stationId, name, trigger, actions } = input;

  const actionValidation = validateEventActions(actions);
  if (actionValidation) {
    return actionValidation;
  }

  const stationResult = await validateStationWorkspace(stationId, workspaceId);
  if ("error" in stationResult) {
    return stationResult;
  }

  const event = await prisma.stationEvent.create({
    data: {
      stationId,
      name,
      trigger,
      actions,
    },
  });

  void notifyStationEventCacheRefresh({
    workspaceId: stationResult.data.site.workspaceId,
    stationId,
    eventId: event.id,
    operation: "create",
  });

  return { data: event };
}

export async function update(input: UpdateStationEventInput, workspaceId?: string) {
  const { stationId, eventId, expectedVersion, updates } = input;

  if (updates.actions !== undefined) {
    const actionValidation = validateEventActions(updates.actions);
    if (actionValidation) {
      return actionValidation;
    }
  }

  const stationResult = await validateStationWorkspace(stationId, workspaceId);
  if ("error" in stationResult) {
    return stationResult;
  }

  const existing = await prisma.stationEvent.findFirst({
    where: {
      id: eventId,
      stationId,
    },
    select: { id: true },
  });

  if (!existing) {
    return { error: "Station event not found", code: "STATION_EVENT_NOT_FOUND" };
  }

  if (Object.keys(updates).length === 0) {
    return { error: "At least one update field is required", code: "INVALID_INPUT" };
  }

  const updateData: {
    name?: string;
    enabled?: boolean;
    trigger?: PrismaJson.EventTrigger;
    actions?: PrismaJson.EventAction[];
    version: { increment: number };
  } = {
    version: { increment: 1 },
  };

  if (updates.name !== undefined) {
    updateData.name = updates.name;
  }
  if (updates.enabled !== undefined) {
    updateData.enabled = updates.enabled;
  }
  if (updates.trigger !== undefined) {
    updateData.trigger = updates.trigger;
  }
  if (updates.actions !== undefined) {
    updateData.actions = updates.actions;
  }

  const updated = await prisma.stationEvent.updateMany({
    where: {
      id: eventId,
      stationId,
      version: expectedVersion,
    },
    data: updateData,
  });

  if (updated.count === 0) {
    return { error: "Station event version conflict", code: "VERSION_CONFLICT" };
  }

  const event = await prisma.stationEvent.findUnique({
    where: { id: eventId },
  });

  if (!event) {
    return { error: "Station event not found", code: "STATION_EVENT_NOT_FOUND" };
  }

  void notifyStationEventCacheRefresh({
    workspaceId: stationResult.data.site.workspaceId,
    stationId,
    eventId: event.id,
    operation: "update",
  });

  return { data: event };
}

export async function remove(stationId: string, eventId: string, workspaceId?: string) {
  const stationResult = await validateStationWorkspace(stationId, workspaceId);
  if ("error" in stationResult) {
    return stationResult;
  }

  const existing = await prisma.stationEvent.findFirst({
    where: {
      id: eventId,
      stationId,
    },
    select: { id: true },
  });

  if (!existing) {
    return { error: "Station event not found", code: "STATION_EVENT_NOT_FOUND" };
  }

  await prisma.stationEvent.delete({
    where: { id: eventId },
  });

  void notifyStationEventCacheRefresh({
    workspaceId: stationResult.data.site.workspaceId,
    stationId,
    eventId,
    operation: "delete",
  });

  return { success: true };
}

export async function toggle(stationId: string, eventId: string, enabled: boolean, workspaceId?: string) {
  const stationResult = await validateStationWorkspace(stationId, workspaceId);
  if ("error" in stationResult) {
    return stationResult;
  }

  const existing = await prisma.stationEvent.findFirst({
    where: {
      id: eventId,
      stationId,
    },
    select: { id: true },
  });

  if (!existing) {
    return { error: "Station event not found", code: "STATION_EVENT_NOT_FOUND" };
  }

  const event = await prisma.stationEvent.update({
    where: { id: eventId },
    data: {
      enabled,
      version: { increment: 1 },
    },
  });

  void notifyStationEventCacheRefresh({
    workspaceId: stationResult.data.site.workspaceId,
    stationId,
    eventId: event.id,
    operation: "toggle",
  });

  return { data: event };
}

export async function trigger(input: TriggerStationEventInput, workspaceId?: string) {
  const { stationId, eventId, payload } = input;

  const stationResult = await validateStationWorkspace(stationId, workspaceId);
  if ("error" in stationResult) {
    return stationResult;
  }

  const existing = await prisma.stationEvent.findFirst({
    where: {
      id: eventId,
      stationId,
    },
    select: {
      id: true,
      enabled: true,
    },
  });

  if (!existing) {
    return { error: "Station event not found", code: "STATION_EVENT_NOT_FOUND" };
  }

  if (!existing.enabled) {
    return { error: "Station event is disabled", code: "STATION_EVENT_DISABLED" };
  }

  const now = new Date();

  const data = await prisma.$transaction(async (tx) => {
    const event = await tx.stationEvent.update({
      where: { id: eventId },
      data: {
        lastRunAt: now,
        runCount: { increment: 1 },
      },
    });

    const execution = await tx.stationEventExecution.create({
      data: {
        stationEventId: event.id,
        payload: (payload ?? {}) as Prisma.InputJsonValue,
      },
    });

    return { event, execution };
  });

  const enqueueResult = await enqueueStationEventExecution(data.execution.id);
  if (!enqueueResult.success) {
    return enqueueResult;
  }

  publishStreamEvent({
    id: data.execution.id,
    type: "StationEventTriggered",
    workspaceId: stationResult.data.site.workspaceId,
    receivedAt: new Date().toISOString(),
    payload: {
      stationId,
      eventId: data.event.id,
      executionId: data.execution.id,
      triggeredAt: data.execution.createdAt.toISOString(),
    },
  });

  return { data };
}
