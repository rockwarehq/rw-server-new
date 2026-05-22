import { v7 as uuidv7 } from "uuid";

import type { EventPreprocessor, JsonObject, ParsedEvent } from "../types.js";

interface PointRow {
  scaleFactor: number;
  offset: number;
}

interface PointsSplitEnricherQueryClient {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getPointCalibration(
  queryClient: PointsSplitEnricherQueryClient,
  pointId: string,
): Promise<PointRow | undefined> {
  const result = await queryClient.query(
    'SELECT "scaleFactor", "offset" FROM "Point" WHERE "id" = $1 LIMIT 1',
    [pointId],
  );

  const row = result.rows[0];
  if (!row) {
    return undefined;
  }

  const scaleFactor = toFiniteNumber(row.scaleFactor);
  const offset = toFiniteNumber(row.offset);

  if (scaleFactor === undefined || offset === undefined) {
    return undefined;
  }

  return { scaleFactor, offset };
}

function scale(raw: number, scaleFactor: number, offset: number): number {
  return raw * scaleFactor + offset;
}

export function createPointsSplitEnricher(args: {
  queryClient: PointsSplitEnricherQueryClient;
  mode?: "strict" | "best_effort";
  logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}): EventPreprocessor {
  const mode = args.mode ?? "strict";

  return {
    name: "points-split-enricher",
    failureMode: mode,
    async process(event: ParsedEvent): Promise<ParsedEvent[]> {
      if (event.metadata?.resource !== "Points") {
        return [event];
      }

      const payload = event.payload;
      if (!isJsonObject(payload)) {
        return [event];
      }

      const points = payload.points;
      if (!Array.isArray(points)) {
        return [event];
      }

      const basePayload: JsonObject = { ...payload };
      delete basePayload.points;

      const derivedEvents: ParsedEvent[] = [];

      for (const [index, candidatePoint] of points.entries()) {
        if (!isJsonObject(candidatePoint)) {
          continue;
        }

        const point = { ...candidatePoint };
        point.pointValueId = uuidv7();
        const pointId = typeof point.id === "string" ? point.id : undefined;

        const rawValue = toFiniteNumber(point.value);
        if (rawValue !== undefined) {
          point.valueRaw = rawValue;
        }

        const rawPreviousValue = toFiniteNumber(point.previousValue);
        if (rawPreviousValue !== undefined) {
          point.previousValueRaw = rawPreviousValue;
        }

        if (pointId && rawValue !== undefined) {
          try {
            const calibration = await getPointCalibration(args.queryClient, pointId);
            if (calibration) {
              point.value = scale(rawValue, calibration.scaleFactor, calibration.offset);
              if (rawPreviousValue !== undefined) {
                point.previousValue = scale(
                  rawPreviousValue,
                  calibration.scaleFactor,
                  calibration.offset,
                );
              }
            } else {
              args.logger.warn("point enrichment calibration missing", {
                preprocessor: "points-split-enricher",
                eventId: event.id,
                topic: event.topic,
                pointId,
                mode,
              });

              if (mode === "strict") {
                throw new Error(`missing point calibration for ${pointId}`);
              }
            }
          } catch (error) {
            args.logger.warn("point enrichment lookup failed", {
              preprocessor: "points-split-enricher",
              eventId: event.id,
              topic: event.topic,
              pointId,
              mode,
              error: normalizeError(error),
            });

            if (mode === "strict") {
              throw error;
            }
          }
        }

        derivedEvents.push({
          ...event,
          id: `${event.id}:point:${index}`,
          payload: {
            ...basePayload,
            point,
          },
        });
      }

      return derivedEvents;
    },
  };
}
