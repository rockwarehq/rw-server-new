import { z } from "zod";
import prisma from "@rw/db";
import { complete as completeCycle } from "../../../cycle/cycle.js";
import type { StationActionDefinition } from "./types.js";

interface CycleRecordInput {
  duration?: number | string;
  machineId?: string;
  partCount?: number | string;
  quality?: "good" | "scrap" | "rework";
  jobId?: string;
  timestamp?: string;
  keepOpen?: boolean;
}

const cycleRecordInputSchema = z
  .object({
    duration: z.union([z.number(), z.string()]).optional(),
    machineId: z.string().min(1).optional(),
    partCount: z.union([z.number().int(), z.string().min(1)]).optional(),
    quality: z.enum(["good", "scrap", "rework"]).optional(),
    jobId: z.uuid().optional(),
    timestamp: z.string().datetime().optional(),
    keepOpen: z.boolean().optional(),
  })
  .passthrough();

async function resolveJobId(stationId: string, actionJobId?: string) {
  if (actionJobId) {
    return actionJobId;
  }

  const rows = await prisma.$queryRaw<Array<{ currentJobId: string | null }>>`
    SELECT "currentJobId" FROM "Station" WHERE id = ${stationId}::uuid
  `;

  if (rows.length === 0) {
    throw new Error(`Station not found: ${stationId}`);
  }

  if (!rows[0].currentJobId) {
    throw new Error("No current job assigned to station");
  }

  return rows[0].currentJobId;
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function firstPointField(payload: Record<string, unknown>, field: string): unknown {
  const points = Array.isArray(payload.points) ? payload.points : [];
  for (const point of points) {
    if (point && typeof point === "object") {
      const value = (point as Record<string, unknown>)[field];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}

function firstTagValueField(payload: Record<string, unknown>, field: string): unknown {
  const tagValues = payload.tagValues;
  if (tagValues && typeof tagValues === "object" && !Array.isArray(tagValues)) {
    for (const tag of Object.values(tagValues as Record<string, unknown>)) {
      if (tag && typeof tag === "object") {
        const value = (tag as Record<string, unknown>)[field];
        if (value !== undefined && value !== null) return value;
      }
    }
  }
  return undefined;
}

function resolveGatewayTimestamp(payload: Record<string, unknown>): Date | null {
  // Try top-level gatewayRxTimestamp (direct trigger payloads)
  const topLevel = parseTimestamp(payload.gatewayRxTimestamp);
  if (topLevel) return topLevel;

  // Try gatewayTimestamp from point readings or tag values
  const gwFromPoint = parseTimestamp(firstPointField(payload, "gatewayTimestamp"));
  if (gwFromPoint) return gwFromPoint;
  const gwFromTag = parseTimestamp(firstTagValueField(payload, "gatewayTimestamp"));
  if (gwFromTag) return gwFromTag;

  // Fall back to point timestamp (device measurement time, ~10ms from gateway receive)
  const ptFromPoint = parseTimestamp(firstPointField(payload, "timestamp"));
  if (ptFromPoint) return ptFromPoint;

  // Fall back to source receivedAt (processor MQTT receive time)
  const source = payload.source;
  if (source && typeof source === "object") {
    const receivedAt = parseTimestamp((source as Record<string, unknown>).receivedAt);
    if (receivedAt) return receivedAt;
  }

  return null;
}

export const cycleRecordAction: StationActionDefinition<CycleRecordInput> = {
  key: "cycle.record",
  displayName: "Record Cycle",
  description: "Record a production cycle",
  inputSchema: cycleRecordInputSchema,
  async execute(context, input) {
    const jobId = await resolveJobId(context.stationId, input.jobId);
    const gatewayTimestamp = resolveGatewayTimestamp(context.payload);
    const timestamp = gatewayTimestamp ?? (input.timestamp ? new Date(input.timestamp) : new Date());
    const replayed = context.payload.replayed === true;

    const result = await completeCycle({
      stationId: context.stationId,
      timestamp,
      jobId,
      keepOpen: input.keepOpen ?? false,
      replayed,
    });

    if ("error" in result) {
      throw new Error(`${result.error} (${result.code})`);
    }

    console.log("[STATION_EVENT_ACTION]", {
      action: "cycle.record",
      executionId: context.executionId,
      eventId: context.eventId,
      stationId: context.stationId,
      workspaceId: context.workspaceId,
      actionId: context.actionId,
      actionIndex: context.actionIndex,
      cycleId: result.data.id,
      jobId,
      keepOpen: input.keepOpen ?? false,
      duration: input.duration,
      machineId: input.machineId,
      partCount: input.partCount,
      quality: input.quality,
      timestamp: timestamp.toISOString(),
      timestampSource: gatewayTimestamp ? "gateway" : input.timestamp ? "input" : "server",
      replayed,
    });
  },
};
