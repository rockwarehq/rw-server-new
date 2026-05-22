import type { ParsedEvent } from "../pipeline/types.js";

export interface PointReading {
  pointId: string;
  deviceId?: string;
  value: unknown;
  previousValue?: unknown;
  quality?: "GOOD" | "BAD" | "UNKNOWN";
  timestamp?: string;
  gatewayTimestamp?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeQuality(value: unknown): "GOOD" | "BAD" | "UNKNOWN" | undefined {
  if (value === "GOOD" || value === "BAD" || value === "UNKNOWN") {
    return value;
  }

  return undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  return undefined;
}

function toPointReading(
  pointCandidate: unknown,
  fallbackDeviceId: string | undefined,
): PointReading | null {
  if (!isObject(pointCandidate)) {
    return null;
  }

  const pointId = pointCandidate.id;
  if (typeof pointId !== "string" || pointId.length === 0) {
    return null;
  }

  const value = pointCandidate.value ?? pointCandidate.valueRaw;
  if (value === undefined) {
    return null;
  }

  const previousValue = pointCandidate.previousValue ?? pointCandidate.previousValueRaw;
  const explicitDeviceId =
    typeof pointCandidate.deviceId === "string" && pointCandidate.deviceId.length > 0
      ? pointCandidate.deviceId
      : undefined;

  return {
    pointId,
    deviceId: explicitDeviceId ?? fallbackDeviceId,
    value,
    previousValue,
    quality: normalizeQuality(pointCandidate.quality),
    timestamp: normalizeTimestamp(pointCandidate.timestamp),
    gatewayTimestamp: normalizeTimestamp(pointCandidate.gatewayTimestamp),
  };
}

export function readingKeys(reading: PointReading): string[] {
  return [reading.pointId];
}

export function extractPointReadings(event: ParsedEvent): PointReading[] {
  if (event.metadata?.resource !== "Points") {
    return [];
  }

  if (!isObject(event.payload)) {
    return [];
  }

  const fallbackDeviceId = event.metadata?.deviceId;
  const payloadPoint = event.payload.point;
  if (payloadPoint !== undefined) {
    const reading = toPointReading(payloadPoint, fallbackDeviceId);
    return reading ? [reading] : [];
  }

  const payloadPoints = event.payload.points;
  if (!Array.isArray(payloadPoints)) {
    return [];
  }

  const readings: PointReading[] = [];
  for (const candidate of payloadPoints) {
    const reading = toPointReading(candidate, fallbackDeviceId);
    if (reading) {
      readings.push(reading);
    }
  }

  return readings;
}
