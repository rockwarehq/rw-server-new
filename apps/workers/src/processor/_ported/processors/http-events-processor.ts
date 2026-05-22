import { createProcessorRpcClient } from "../station-events/processor-rpc-client.js";

import type { Logger, ParsedEvent, Processor } from "../pipeline/types.js";

interface HttpEventsProcessorConfig {
  eventsUrl: string;
  timeoutMs: number;
  authToken: string;
}

type PointValueQuality = "GOOD" | "BAD" | "UNKNOWN";

interface PointValueIngestPayload {
  pointId: string;
  quality: PointValueQuality;
  valueRaw: unknown;
  previousValueRaw?: unknown;
  value?: number;
  previousValue?: number;
  timestamp: string | number | Date;
  gatewayTimestamp: string | number | Date;
  replayed?: boolean;
}

interface PointValueIngestEvent {
  id: string;
  type: "PointValue";
  gatewayId: string;
  payload: PointValueIngestPayload;
}

interface RpcIngestClient {
  ingest(input: { events: PointValueIngestEvent[] }): Promise<unknown>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toTimestampValue(value: unknown): string | number | Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }

  return undefined;
}

function normalizeQuality(value: unknown): PointValueQuality {
  if (value === "GOOD" || value === "BAD" || value === "UNKNOWN") {
    return value;
  }

  return "UNKNOWN";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPointValueIngestEvent(event: ParsedEvent): PointValueIngestEvent | { reason: string } {
  const gatewayId = event.metadata?.gatewayId;
  if (!gatewayId) {
    return { reason: "gateway_id_missing" };
  }

  if (!isJsonObject(event.payload)) {
    return { reason: "payload_not_object" };
  }

  const point = event.payload.point;
  if (!isJsonObject(point)) {
    return { reason: "payload_point_missing" };
  }

  const pointId = point.id;
  if (typeof pointId !== "string" || pointId.length === 0) {
    return { reason: "point_id_missing" };
  }

  const pointValueId = point.pointValueId;
  if (typeof pointValueId !== "string" || pointValueId.length === 0) {
    return { reason: "point_value_id_missing" };
  }

  const timestamp = toTimestampValue(point.timestamp);
  if (timestamp === undefined) {
    return { reason: "timestamp_missing" };
  }

  const gatewayTimestamp = toTimestampValue(point.gatewayTimestamp);
  if (gatewayTimestamp === undefined) {
    return { reason: "gateway_timestamp_missing" };
  }

  const valueRaw = point.valueRaw ?? point.value;
  if (valueRaw === undefined) {
    return { reason: "value_raw_missing" };
  }

  const payload: PointValueIngestPayload = {
    pointId,
    quality: normalizeQuality(point.quality),
    valueRaw,
    timestamp,
    gatewayTimestamp,
  };

  const previousValueRaw = point.previousValueRaw ?? point.previousValue;
  if (previousValueRaw !== undefined) {
    payload.previousValueRaw = previousValueRaw;
  }

  const value = toFiniteNumber(point.value);
  if (value !== undefined) {
    payload.value = value;
  }

  const previousValue = toFiniteNumber(point.previousValue);
  if (previousValue !== undefined) {
    payload.previousValue = previousValue;
  }

  if (event.payload.replayed === true) {
    payload.replayed = true;
  }

  return {
    id: pointValueId,
    type: "PointValue",
    gatewayId,
    payload,
  };
}

function createRpcIngestClient(config: HttpEventsProcessorConfig): RpcIngestClient {
  const client = createProcessorRpcClient({
    baseUrl: config.eventsUrl,
    getSecret: () => config.authToken,
  }) as {
    events: {
      ingest(input: { events: PointValueIngestEvent[] }): Promise<unknown>;
    };
  };

  return {
    ingest(input) {
      return client.events.ingest(input);
    },
  };
}

async function postPointValueEvent(args: {
  event: PointValueIngestEvent;
  config: HttpEventsProcessorConfig;
  client: RpcIngestClient;
  logger: Logger;
  sourceEvent: ParsedEvent;
}): Promise<void> {
  try {
    await withTimeout(
      args.client.ingest({ events: [args.event] }),
      args.config.timeoutMs,
      "workspace rpc ingest",
    );
  } catch (error) {
    args.logger.warn("failed to publish point value", {
      processor: "http-events",
      eventId: args.sourceEvent.id,
      topic: args.sourceEvent.topic,
      error: normalizeError(error),
    });
    throw error;
  }
}

export function createHttpEventsProcessor(args: {
  config: HttpEventsProcessorConfig;
  logger: Logger;
  ingestClient?: RpcIngestClient;
}): Processor {
  const ingestClient = args.ingestClient ?? createRpcIngestClient(args.config);

  return {
    name: "http-events",
    matches: (event) => event.metadata?.resource === "Points",
    async process(event): Promise<void> {
      const ingestEvent = toPointValueIngestEvent(event);
      if ("reason" in ingestEvent) {
        args.logger.warn("skipping point value publish", {
          processor: "http-events",
          eventId: event.id,
          topic: event.topic,
          reason: ingestEvent.reason,
        });
        return;
      }

      await postPointValueEvent({
        event: ingestEvent,
        config: args.config,
        client: ingestClient,
        logger: args.logger,
        sourceEvent: event,
      });
    },
  };
}
