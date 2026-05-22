import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, processorRequired, userOrDisplayRequired } from "./middleware.js";
import { Principal } from "../services/auth/index.js";
import { station, workcenter } from "@rw/services/facility/index";
import { getAccessibleSites, hasPermission } from "@rw/services/iam/index";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  siteId: z.uuid(),
  workcenterId: z.uuid().optional(),
  // Config fields (stored on StationBlob)
  standardCycle: z.number().positive().optional(),
  downtimeDetect: z.number().positive().optional(),
  downtimeDetectUnit: z.enum(["SECONDS"]).optional(),
  slowDetect: z.number().positive().optional(),
  slowDetectUnit: z.enum(["PERCENTAGE"]).optional(),
  processTypeId: z.uuid().optional(),
  inLineCalculations: z.boolean().optional(),
  inStationCalculations: z.boolean().optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  // Config fields (stored on StationBlob)
  standardCycle: z.number().positive().nullable().optional(),
  downtimeDetect: z.number().positive().nullable().optional(),
  downtimeDetectUnit: z.enum(["SECONDS"]).optional(),
  slowDetect: z.number().positive().nullable().optional(),
  slowDetectUnit: z.enum(["PERCENTAGE"]).optional(),
  processTypeId: z.uuid().nullable().optional(),
  inLineCalculations: z.boolean().optional(),
  inStationCalculations: z.boolean().optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const moveInputSchema = z.object({
  id: z.uuid(),
  workcenterId: z.uuid().nullable(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  workcenterId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const triggerConditionSchema = z.object({
  id: z.string(),
  kind: z.literal("condition"),
  tagId: z.string().min(1),
  tagName: z.string().optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  condition: z.enum(["goes_above", "goes_below", "increments_up", "increments_down", "changes_to", "any_change"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

const triggerClauseSchema: z.ZodTypeAny = z.lazy(() => z.union([triggerConditionSchema, triggerGroupSchema]));

const triggerGroupSchema: z.ZodTypeAny = z.object({
  id: z.string(),
  kind: z.literal("group"),
  operator: z.enum(["all", "any"]),
  conditions: z.array(triggerClauseSchema).min(1),
});

const eventTriggerSchema = z.object({
  operator: z.enum(["all", "any"]),
  clauses: z.array(triggerClauseSchema).min(1),
});

const eventActionSchema = z.object({
  id: z.string(),
  event: z.string().min(1),
  eventDisplayName: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()),
  continueOnError: z.boolean().optional(),
});

const createEventInputSchema = z.object({
  stationId: z.uuid(),
  name: z.string().min(1),
  trigger: eventTriggerSchema,
  actions: z.array(eventActionSchema).min(1),
});

const updateEventInputSchema = z.object({
  stationId: z.uuid(),
  eventId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  updates: z
    .object({
      name: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      trigger: eventTriggerSchema.optional(),
      actions: z.array(eventActionSchema).min(1).optional(),
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: "At least one update field is required",
    }),
});

const stationEventIdInputSchema = z.object({
  stationId: z.uuid(),
  eventId: z.uuid(),
});

const listEventsInputSchema = z.object({
  stationId: z.uuid(),
});

const listEventExecutionsInputSchema = z.object({
  stationId: z.uuid(),
  limit: z.number().int().min(0).default(10),
});

const listEventsForProcessorInputSchema = z
  .object({
    stationId: z.uuid().optional(),
  })
  .optional();

const getTagSnapshotsForProcessorInputSchema = z.object({
  tagKeys: z.array(z.string().min(1)).min(1).max(500),
});

const toggleEventInputSchema = stationEventIdInputSchema.extend({
  enabled: z.boolean(),
});

const triggerEventInputSchema = z
  .object({
    stationId: z.uuid(),
    eventId: z.uuid(),
    payload: z.record(z.string(), z.unknown()).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => !(value.payload && value.data), {
    message: "Provide either payload or data, not both",
  });

// ============================================================================
// Procedures
// ============================================================================

/**
 * Create a new station
 */
export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }
  if (!(await hasPermission(context.iam.id, "facility:write", { workspaceId, siteId: input.siteId }))) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:write" });
  }

  const result = await station.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND" || code === "WORKCENTER_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "SITE_MISMATCH") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * List stations
 */
export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  if (context.iam.principal === Principal.DISPLAY) {
    const siteId = context.iam.siteId;
    if (!siteId) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Display site context required",
      });
    }

    if (input.siteId && input.siteId !== siteId) {
      throw new ORPCError("FORBIDDEN", {
        message: "Display can only access stations in its site",
      });
    }

    if (input.workcenterId) {
      const workcenterResult = await workcenter.getById(input.workcenterId, workspaceId);
      if (workcenterResult && "error" in workcenterResult) {
        throw new ORPCError("FORBIDDEN", {
          message: "Display can only access stations in its site",
          cause: workcenterResult,
        });
      }

      if (workcenterResult && workcenterResult.data.site.id !== siteId) {
        throw new ORPCError("FORBIDDEN", {
          message: "Display can only access stations in its site",
        });
      }
    }

    return station.list({
      ...input,
      siteId,
      workspaceId,
    });
  }

  const userId = context.iam.id;
  if (!userId) {
    throw new ORPCError("UNAUTHORIZED", { message: "Authentication required" });
  }
  const access = await getAccessibleSites(userId, "facility:read", workspaceId);
  if (input.siteId && !access.all && !access.siteIds.includes(input.siteId)) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:read" });
  }
  return station.list({
    ...input,
    workspaceId,
    siteIds: input.siteId || access.all ? undefined : access.siteIds,
  });
});

/**
 * Get station by ID
 */
export const get = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;

  const result = await station.getById(input.id, workspaceId);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Station not found" });
  }
  if ("error" in result) {
    throw new ORPCError("FORBIDDEN", {
      message: result.error as string,
      cause: result,
    });
  }
  if (
    !workspaceId ||
    !(await hasPermission(context.iam.id, "facility:read", { workspaceId, siteId: result.data.siteId }))
  ) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:read" });
  }
  return result.data;
});

/**
 * Update station
 */
export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  const workspaceId = context.iam.workspaceId;

  const existing = await station.getById(id, workspaceId);
  if (!existing || "error" in existing) throw new ORPCError("NOT_FOUND", { message: "Station not found" });
  if (
    !workspaceId ||
    !(await hasPermission(context.iam.id, "facility:write", { workspaceId, siteId: existing.data.siteId }))
  ) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:write" });
  }

  const result = await station.update(id, updateData, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Move station to a different workcenter (within same site)
 */
export const move = authRequired.input(moveInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;

  const existing = await station.getById(input.id, workspaceId);
  if (!existing || "error" in existing) throw new ORPCError("NOT_FOUND", { message: "Station not found" });
  if (
    !workspaceId ||
    !(await hasPermission(context.iam.id, "facility:write", { workspaceId, siteId: existing.data.siteId }))
  ) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:write" });
  }

  const result = await station.move(input.id, input.workcenterId, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND" || code === "WORKCENTER_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "SITE_MISMATCH") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Delete station
 */
export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;

  const existing = await station.getById(input.id, workspaceId);
  if (!existing || "error" in existing) throw new ORPCError("NOT_FOUND", { message: "Station not found" });
  if (
    !workspaceId ||
    !(await hasPermission(context.iam.id, "facility:admin", { workspaceId, siteId: existing.data.siteId }))
  ) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:admin" });
  }

  const result = await station.remove(input.id, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return { success: true };
});

/**
 * Create station event
 */
export const createEvent = authRequired.input(createEventInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await station.createEvent(input as station.CreateStationEventInput, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }

  return result.data;
});

/**
 * Update station event
 */
export const updateEvent = authRequired.input(updateEventInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await station.updateEvent(input as station.UpdateStationEventInput, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND" || code === "STATION_EVENT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "VERSION_CONFLICT") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }

  return result.data;
});

/**
 * List station events
 */
export const listEvents = authRequired.input(listEventsInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await station.listEvents(input.stationId, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }

  return result.data;
});

/**
 * List station event executions
 */
export const listEventExecutions = authRequired
  .input(listEventExecutionsInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Workspace context required",
      });
    }

    const result = await station.listEventExecutions(input.stationId, workspaceId, {
      limit: input.limit,
    });
    if ("error" in result) {
      const code = result.code as string;
      if (code === "STATION_NOT_FOUND") {
        throw new ORPCError("NOT_FOUND", {
          message: result.error as string,
          cause: result,
        });
      }
      if (code === "WORKSPACE_MISMATCH") {
        throw new ORPCError("FORBIDDEN", {
          message: result.error as string,
          cause: result,
        });
      }
      throw new ORPCError("BAD_REQUEST", {
        message: result.error as string,
        cause: result,
      });
    }

    return result.data;
  });

/**
 * List enabled station events for processor cache
 */
export const listEventsForProcessor = processorRequired
  .input(listEventsForProcessorInputSchema)
  .handler(async ({ input }) => {
    const result = await station.listEventsForProcessor(input?.stationId);
    if ("error" in result) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: result.error as string,
        cause: result,
      });
    }

    return result.data;
  });

/**
 * Get latest tag snapshots for processor cache misses
 */
export const getTagSnapshotsForProcessor = processorRequired
  .input(getTagSnapshotsForProcessorInputSchema)
  .handler(async ({ input }) => {
    const result = await station.getTagSnapshotsForProcessor(input.tagKeys);
    if ("error" in result) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: result.error as string,
        cause: result,
      });
    }

    return result.data;
  });

/**
 * Toggle station event
 */
export const toggleEvent = authRequired.input(toggleEventInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await station.toggleEvent(input.stationId, input.eventId, input.enabled, workspaceId);

  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND" || code === "STATION_EVENT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }

  return result.data;
});

/**
 * Trigger station event (processor-only)
 */
export const triggerEvent = processorRequired.input(triggerEventInputSchema).handler(async ({ input }) => {
  const result = await station.triggerEvent({
    stationId: input.stationId,
    eventId: input.eventId,
    payload: input.payload ?? input.data,
  } as station.TriggerStationEventInput);

  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND" || code === "STATION_EVENT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "STATION_EVENT_DISABLED") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "EXECUTION_ENQUEUE_FAILED") {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }

  return result.data;
});

/**
 * Delete station event
 */
export const deleteEvent = authRequired.input(stationEventIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await station.removeEvent(input.stationId, input.eventId, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND" || code === "STATION_EVENT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }

  return { success: true };
});

// ============================================================================
// Datasource Management
// ============================================================================

const addDatasourceInputSchema = z.object({
  stationId: z.uuid(),
  datasourceIds: z.union([z.uuid(), z.array(z.uuid())]),
});

const removeDatasourceInputSchema = z.object({
  stationId: z.uuid(),
  datasourceId: z.uuid(),
});

const stationIdInputSchema = z.object({
  stationId: z.uuid(),
});

/**
 * Add one or more datasources to a station
 * Validates all belong to the same site
 */
export const addDatasource = authRequired.input(addDatasourceInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;

  const result = await station.addDatasource(input.stationId, input.datasourceIds, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND" || code === "DATASOURCE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "SITE_MISMATCH" || code === "ALREADY_LINKED") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Remove a datasource from a station
 */
export const removeDatasource = authRequired.input(removeDatasourceInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;

  const result = await station.removeDatasource(input.stationId, input.datasourceId, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND" || code === "LINK_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return { success: true };
});

/**
 * List all datasources linked to a station
 */
export const listDatasources = authRequired.input(stationIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;

  const result = await station.listDatasources(input.stationId, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

// ============================================================================
// State Management
// ============================================================================

const splitDowntimeInputSchema = z.object({
  entryId: z.uuid(),
  splitAt: z.coerce.date(),
});

const stateLogOutputSchema = z.record(z.string(), z.unknown());

const splitDowntimeOutputSchema = z.object({
  success: z.literal(true),
  entries: z.tuple([stateLogOutputSchema, stateLogOutputSchema]),
});

const assignDowntimeReasonInputSchema = z.object({
  entryId: z.uuid(),
  statusReasonId: z.uuid().nullable(),
  applyToBlock: z.boolean().optional(),
});

const changeJobInputSchema = z.object({
  stationId: z.uuid(),
  jobId: z.uuid().nullable(),
});

const listStateLogsInputSchema = z.object({
  stationId: z.uuid(),
  startTime: z.coerce.date().optional(),
  endTime: z.coerce.date().optional(),
  state: z.enum(["UP", "DOWN"]).optional(),
  limit: z.number().min(0).default(100),
  offset: z.number().min(0).default(0),
});

/**
 * Split a DOWN state log entry into two at a given duration
 */
export const splitDowntime = userOrDisplayRequired
  .input(splitDowntimeInputSchema)
  .output(splitDowntimeOutputSchema)
  .handler(async ({ input }) => {
    const result = await station.splitDownEntry(input.entryId, input.splitAt);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "NOT_FOUND") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "INVALID_STATE") {
        throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return result;
  });

/**
 * Assign or clear a downtime reason on a DOWN state log entry
 */
export const assignDowntimeReason = userOrDisplayRequired
  .input(assignDowntimeReasonInputSchema)
  .handler(async ({ input }) => {
    const result = await station.assignDowntimeReason(input.entryId, input.statusReasonId, {
      applyToBlock: input.applyToBlock,
    });
    if ("error" in result) {
      const code = result.code as string;
      if (code === "NOT_FOUND" || code === "REASON_NOT_FOUND") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "INVALID_STATE") {
        throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return result;
  });

/**
 * Change the current job assigned to a station
 */
export const changeJob = userOrDisplayRequired.input(changeJobInputSchema).handler(async ({ input }) => {
  const result = await station.changeJob(input.stationId, input.jobId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATION_NOT_FOUND" || code === "JOB_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "SITE_MISMATCH" || code === "NO_CURRENT_BLOB") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * List state logs for a station
 */
export const listStateLogs = authRequired.input(listStateLogsInputSchema).handler(async ({ input }) => {
  return station.listStateLogs(input);
});
