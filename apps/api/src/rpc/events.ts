import { ORPCError, eventIterator } from "@orpc/server";
import * as z from "zod";
import prisma from "@rw/db";
import { authRequired, processorRequired } from "./middleware.js";
import { publishStreamEvent, subscribeStreamEvents } from "@rw/runtime/events-bus";

const pointValueQualitySchema = z.enum(["GOOD", "BAD", "UNKNOWN"]);

const timestampInputSchema = z.union([z.number(), z.string(), z.date()]).pipe(z.coerce.date());

const pointValuePayloadInputSchema = z.object({
  pointId: z.uuid(),
  valueRaw: z.unknown(),
  previousValueRaw: z.unknown().optional(),
  quality: pointValueQualitySchema.default("UNKNOWN"),
  value: z.number().optional(),
  previousValue: z.number().optional(),
  timestamp: timestampInputSchema,
  gatewayTimestamp: timestampInputSchema,
  replayed: z.boolean().default(false),
});

const pointValuePayloadOutputSchema = z.object({
  pointId: z.uuid(),
  valueRaw: z.unknown(),
  previousValueRaw: z.unknown().optional(),
  quality: pointValueQualitySchema,
  value: z.number().optional(),
  previousValue: z.number().optional(),
  timestamp: z.iso.datetime(),
  gatewayTimestamp: z.iso.datetime(),
  replayed: z.boolean(),
});

const stationEventTriggeredPayloadOutputSchema = z.object({
  stationId: z.uuid(),
  eventId: z.uuid(),
  executionId: z.uuid(),
  triggeredAt: z.iso.datetime(),
});

const stationEventExecutionActionResultOutputSchema = z.object({
  actionId: z.string(),
  event: z.string(),
  eventDisplayName: z.string().optional(),
  status: z.enum(["success", "failed", "skipped"]),
});

const stationEventExecutionPayloadOutputSchema = z.object({
  executionId: z.uuid(),
  stationId: z.uuid(),
  eventId: z.uuid(),
  status: z.enum(["success", "failed"]),
  triggeredAt: z.iso.datetime(),
  trigger: z
    .object({
      tagName: z.string().optional(),
      deviceName: z.string().optional(),
      previousValue: z.union([z.number(), z.string(), z.boolean()]).optional(),
      actualValue: z.union([z.number(), z.string(), z.boolean()]).optional(),
    })
    .optional(),
  actionResults: z.array(stationEventExecutionActionResultOutputSchema),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .nullable()
    .optional(),
});

const pointValueEventInputSchema = z.object({
  id: z.uuid(),
  gatewayId: z.uuid(),
  type: z.literal("PointValue"),
  payload: pointValuePayloadInputSchema,
});

const pointValueStreamEventSchema = z.object({
  id: z.uuid(),
  type: z.literal("PointValue"),
  gatewayId: z.uuid(),
  workspaceId: z.uuid().nullable(),
  receivedAt: z.iso.datetime(),
  payload: pointValuePayloadOutputSchema,
});

const stationEventTriggeredStreamEventSchema = z.object({
  id: z.uuid(),
  type: z.literal("StationEventTriggered"),
  workspaceId: z.uuid().nullable(),
  receivedAt: z.iso.datetime(),
  payload: stationEventTriggeredPayloadOutputSchema,
});

const stationEventExecutionStreamEventSchema = z.object({
  id: z.uuid(),
  type: z.literal("StationEventExecution"),
  workspaceId: z.uuid().nullable(),
  receivedAt: z.iso.datetime(),
  payload: stationEventExecutionPayloadOutputSchema,
});

const streamEventSchema = z.discriminatedUnion("type", [
  pointValueStreamEventSchema,
  stationEventTriggeredStreamEventSchema,
  stationEventExecutionStreamEventSchema,
]);

const STREAM_EVENT_TYPES = ["PointValue", "StationEventTriggered", "StationEventExecution"] as const;
const streamEventTypeSchema = z.enum(STREAM_EVENT_TYPES);

const ingestInputSchema = z.object({
  events: z.array(pointValueEventInputSchema).min(1),
});

const ingestOutputSchema = z.object({
  accepted: z.number().int().nonnegative(),
});

const streamInputSchema = z.object({
  gatewayId: z.uuid().optional(),
  types: z.array(streamEventTypeSchema).optional(),
});

export const ingest = processorRequired
  .input(ingestInputSchema)
  .output(ingestOutputSchema)
  .handler(async ({ input }) => {
    const gatewayIds = [...new Set(input.events.map((event) => event.gatewayId))];
    const gateways = await prisma.gateway.findMany({
      where: {
        id: { in: gatewayIds },
      },
      select: {
        id: true,
        status: true,
        location: {
          select: {
            workspaceId: true,
          },
        },
      },
    });

    const gatewayById = new Map(gateways.map((gateway) => [gateway.id, gateway]));
    const receivedAt = new Date().toISOString();

    for (const event of input.events) {
      const gateway = gatewayById.get(event.gatewayId);
      if (!gateway) {
        throw new ORPCError("BAD_REQUEST", { message: `Gateway not found: ${event.gatewayId}` });
      }

      if (gateway.status === "DISABLED") {
        throw new ORPCError("FORBIDDEN", { message: `Gateway is disabled: ${event.gatewayId}` });
      }

      if (event.type === "PointValue") {
        publishStreamEvent({
          id: event.id,
          type: "PointValue",
          gatewayId: event.gatewayId,
          workspaceId: gateway.location?.workspaceId ?? null,
          receivedAt,
          payload: {
            pointId: event.payload.pointId,
            valueRaw: event.payload.valueRaw,
            previousValueRaw: event.payload.previousValueRaw,
            quality: event.payload.quality,
            value: event.payload.value,
            previousValue: event.payload.previousValue,
            timestamp: event.payload.timestamp.toISOString(),
            gatewayTimestamp: event.payload.gatewayTimestamp.toISOString(),
            replayed: event.payload.replayed,
          },
        });
      }
    }

    return { accepted: input.events.length };
  });

export const stream = authRequired
  .input(streamInputSchema)
  .output(eventIterator(streamEventSchema))
  .handler(async function* ({ context, input, signal }) {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("UNAUTHORIZED", { message: "Workspace context required" });
    }

    const requestedTypes = new Set(input.types ?? STREAM_EVENT_TYPES);

    for await (const event of subscribeStreamEvents({ signal })) {
      if (event.workspaceId !== workspaceId) {
        continue;
      }

      if (!requestedTypes.has(event.type)) {
        continue;
      }

      if (input.gatewayId) {
        if (event.type !== "PointValue") {
          continue;
        }

        if (event.gatewayId !== input.gatewayId) {
          continue;
        }
      }

      yield event;
    }
  });
