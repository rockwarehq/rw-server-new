import { Queue } from "bullmq";
import prisma from "@rw/db";
import { publishStreamEvent } from "@rw/infra/events-bus";
import { getAction, validateActionInput } from "./actions/index.js";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const connection = { url: REDIS_URL };

export const STATION_EVENT_EXECUTION_QUEUE = "station-event-execution";

interface ExecutionJobData {
  executionId: string;
}

let stationEventExecutionQueue: Queue<ExecutionJobData> | null = null;

function getStationEventExecutionQueue() {
  if (!stationEventExecutionQueue) {
    stationEventExecutionQueue = new Queue<ExecutionJobData>(STATION_EVENT_EXECUTION_QUEUE, { connection });
  }

  return stationEventExecutionQueue;
}

interface StationEventExecutionError {
  error: string;
  code: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

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

async function publishResolvedExecutionEvent(args: {
  executionId: string;
  stationId?: string;
  eventId?: string;
  workspaceId?: string;
  payload?: Record<string, unknown>;
  actions?: PrismaJson.EventAction[];
  status: "success" | "failed";
  error?: {
    code: string;
    message: string;
  } | null;
}) {
  try {
    // Fetch execution context — use provided values or query from DB
    const triggerRows = await prisma.$queryRaw<
      Array<{
        createdAt: Date;
        trigger: unknown;
        stationId: string;
        eventId: string;
        workspaceId: string;
        payload: unknown;
        actions: unknown;
      }>
    >`
      SELECT e."createdAt", e.payload, se.trigger, se.actions,
             se."stationId", se.id AS "eventId", si."workspaceId"
      FROM "StationEventExecution" e
      JOIN "StationEvent" se ON se.id = e."stationEventId"
      JOIN "Station" st ON st.id = se."stationId"
      JOIN "Site" si ON si.id = st."siteId"
      WHERE e.id = ${args.executionId}::uuid
    `;

    if (triggerRows.length === 0) return;

    const row = triggerRows[0];
    const stationId = args.stationId ?? row.stationId;
    const eventId = args.eventId ?? row.eventId;
    const execWorkspaceId = args.workspaceId ?? row.workspaceId;
    const execPayload = args.payload ?? asRecord(row.payload);
    const execActions = args.actions ?? (Array.isArray(row.actions) ? (row.actions as PrismaJson.EventAction[]) : []);
    const trigger = row.trigger as PrismaJson.EventTrigger;

    const payloadTrigger = asRecord(execPayload.trigger);
    const payloadTagValues = asRecord(execPayload.tagValues);
    const matchedConditionIds = asStringArray(payloadTrigger.matchedConditionIds);
    const conditions = flattenTriggerConditions(Array.isArray(trigger.clauses) ? trigger.clauses : []);

    const matchedCondition =
      conditions.find((condition) => matchedConditionIds.includes(condition.id)) || conditions[0];

    const tagSnapshot = matchedCondition ? asRecord(payloadTagValues[matchedCondition.tagId]) : {};

    const actionStatus = args.status === "success" ? "success" : "failed";

    publishStreamEvent({
      id: args.executionId,
      type: "StationEventExecution",
      workspaceId: execWorkspaceId,
      receivedAt: new Date().toISOString(),
      payload: {
        executionId: args.executionId,
        stationId,
        eventId,
        status: args.status,
        triggeredAt: row.createdAt.toISOString(),
        trigger: matchedCondition
          ? {
              tagName: matchedCondition.tagName,
              deviceName: matchedCondition.deviceName,
              previousValue: normalizeTriggerValue(tagSnapshot.previousValue),
              actualValue: normalizeTriggerValue(tagSnapshot.value),
            }
          : undefined,
        actionResults: execActions.map((action) => ({
          actionId: action.id,
          event: action.event,
          eventDisplayName: action.eventDisplayName,
          status: actionStatus,
        })),
        error: args.error ?? null,
      },
    });
  } catch (error) {
    console.error("[STATION_EVENT_EXECUTION] Failed to publish stream event", {
      executionId: args.executionId,
      status: args.status,
      error: getErrorMessage(error),
    });
  }
}

async function markExecutionFailed(executionId: string) {
  const result = await prisma.stationEventExecution.updateMany({
    where: {
      id: executionId,
      status: "RUNNING",
    },
    data: {
      status: "FAILED",
      completedAt: new Date(),
    },
  });

  return result.count > 0;
}

export async function enqueueStationEventExecution(executionId: string) {
  try {
    await getStationEventExecutionQueue().add("run", { executionId } satisfies ExecutionJobData, {
      jobId: executionId,
      removeOnComplete: true,
      removeOnFail: { count: 100 },
    });

    return { success: true as const };
  } catch (error) {
    const message = getErrorMessage(error);
    const updated = await markExecutionFailed(executionId);
    if (updated) {
      await publishResolvedExecutionEvent({
        executionId,
        status: "failed",
        error: {
          code: "EXECUTION_ENQUEUE_FAILED",
          message: `Failed to enqueue station event execution: ${message}`,
        },
      });
    }

    return {
      success: false as const,
      error: `Failed to enqueue station event execution: ${message}`,
      code: "EXECUTION_ENQUEUE_FAILED",
    };
  }
}

async function failExecution(executionId: string, message: string, code: string): Promise<StationEventExecutionError> {
  const updated = await markExecutionFailed(executionId);
  if (updated) {
    await publishResolvedExecutionEvent({
      executionId,
      status: "failed",
      error: {
        code,
        message,
      },
    });
  }

  return {
    error: message,
    code,
  };
}

export async function runStationEventExecution(executionId: string) {
  const execStart = Date.now();
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      status: string;
      payload: unknown;
      eventId: string;
      stationId: string;
      actions: unknown;
      workspaceId: string;
    }>
  >`
    SELECT
      e.id, e.status, e.payload,
      se.id AS "eventId", se."stationId", se.actions,
      si."workspaceId"
    FROM "StationEventExecution" e
    JOIN "StationEvent" se ON se.id = e."stationEventId"
    JOIN "Station" st ON st.id = se."stationId"
    JOIN "Site" si ON si.id = st."siteId"
    WHERE e.id = ${executionId}
  `;

  if (rows.length === 0) {
    return {
      error: "Station event execution not found",
      code: "EXECUTION_NOT_FOUND",
    };
  }

  const execution = rows[0];

  if (execution.status !== "RUNNING") {
    return {
      data: {
        executionId,
        status: execution.status,
        skipped: true,
      },
    };
  }

  const actions = Array.isArray(execution.actions) ? (execution.actions as PrismaJson.EventAction[]) : [];

  const payload = asRecord(execution.payload);
  const workspaceId = execution.workspaceId;

  let hasRuntimeFailure = false;

  for (const [index, action] of actions.entries()) {
    const actionDefinition = getAction(action.event);
    if (!actionDefinition) {
      return failExecution(
        execution.id,
        `Unknown station action: ${action.event} (index: ${index})`,
        "ACTION_NOT_FOUND",
      );
    }

    const validation = validateActionInput(action.event, action.inputs);
    if (!validation.valid) {
      return failExecution(execution.id, `${validation.message} (index: ${index})`, validation.code);
    }

    try {
      await actionDefinition.execute(
        {
          executionId: execution.id,
          eventId: execution.eventId,
          stationId: execution.stationId,
          workspaceId,
          payload,
          actionId: action.id,
          actionIndex: index,
        },
        action.inputs,
      );
    } catch (error) {
      const message = getErrorMessage(error);

      console.error("[STATION_EVENT_EXECUTION] Action execution failed", {
        executionId: execution.id,
        actionEvent: action.event,
        actionId: action.id,
        actionIndex: index,
        error: message,
      });

      if (action.continueOnError) {
        hasRuntimeFailure = true;
        continue;
      }

      return failExecution(
        execution.id,
        `Action execution failed for ${action.event}: ${message}`,
        "ACTION_EXECUTION_FAILED",
      );
    }
  }

  const status = hasRuntimeFailure ? "FAILED" : "SUCCEEDED";
  const markStart = Date.now();

  await prisma.$executeRaw`
    UPDATE "StationEventExecution"
    SET status = ${status}::"StationEventExecutionStatus", "completedAt" = NOW(), "updatedAt" = NOW()
    WHERE id = ${execution.id}::uuid
  `;
  const markEnd = Date.now();

  await publishResolvedExecutionEvent({
    executionId: execution.id,
    stationId: execution.stationId,
    eventId: execution.eventId,
    workspaceId,
    payload,
    actions,
    status: status === "SUCCEEDED" ? "success" : "failed",
    error:
      status === "FAILED"
        ? {
            code: "ACTION_EXECUTION_FAILED",
            message: "One or more station event actions failed.",
          }
        : null,
  });
  const publishEnd = Date.now();

  console.log(
    `[exec:timing] id=${execution.id} actions=${markStart - execStart}ms markComplete=${markEnd - markStart}ms publish=${publishEnd - markEnd}ms total=${publishEnd - execStart}ms`,
  );

  return {
    data: {
      executionId: execution.id,
      status,
      skipped: false,
    },
  };
}
