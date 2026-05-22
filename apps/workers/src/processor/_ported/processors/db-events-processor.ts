import type { ParsedEvent, Processor, ProcessorContext } from "../pipeline/types.js";

interface DbEventsProcessorConfig {
  table: string;
  insertTimeoutMs: number;
  batchWindowMs: number;
  batchMaxRows: number;
}

interface DbEventsQueryClient {
  query(text: string, values: unknown[]): Promise<unknown>;
}

interface PendingEvent {
  event: ParsedEvent;
  resolve: () => void;
  reject: (error: unknown) => void;
}

type PointValueQuality = "GOOD" | "BAD" | "UNKNOWN";

interface PointValueRow {
  id: string;
  pointId: string;
  quality: PointValueQuality;
  valueRaw: unknown;
  previousValueRaw: unknown | null;
  value: number | null;
  previousValue: number | null;
  timestamp: Date;
  gatewayTimestamp: Date;
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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function formatTableName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("DB_EVENTS_TABLE must not be empty");
  }

  const segments = trimmed.split(".");
  if (segments.some((segment) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))) {
    throw new Error("DB_EVENTS_TABLE must be a valid identifier or schema-qualified identifier");
  }

  return segments.map(quoteIdentifier).join(".");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function parseTimestamp(value: unknown): Date | undefined {
  if (value instanceof Date) {
    const dateValue = value.getTime();
    return Number.isFinite(dateValue) ? new Date(dateValue) : undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  return undefined;
}

function normalizeQuality(value: unknown): PointValueQuality {
  if (value === "GOOD" || value === "BAD" || value === "UNKNOWN") {
    return value;
  }

  return "UNKNOWN";
}

function buildPointValueRow(
  event: ParsedEvent,
): { row: PointValueRow } | { reason: string; pointId?: string } {
  if (!isJsonObject(event.payload)) {
    return { reason: "payload_not_object" };
  }

  const pointCandidate = event.payload.point;
  if (!isJsonObject(pointCandidate)) {
    return { reason: "payload_point_missing" };
  }

  const id = pointCandidate.pointValueId;
  const pointId = pointCandidate.id;
  const timestamp = parseTimestamp(pointCandidate.timestamp);
  const gatewayTimestamp = parseTimestamp(pointCandidate.gatewayTimestamp);

  if (!isUuid(id)) {
    return {
      reason: "point_value_id_invalid",
      pointId: typeof pointId === "string" ? pointId : undefined,
    };
  }

  if (!isUuid(pointId)) {
    return { reason: "point_id_invalid" };
  }

  if (!timestamp) {
    return { reason: "timestamp_invalid", pointId };
  }

  if (!gatewayTimestamp) {
    return { reason: "gateway_timestamp_invalid", pointId };
  }

  const valueRaw = pointCandidate.valueRaw ?? pointCandidate.value;
  if (valueRaw === undefined) {
    return { reason: "value_raw_missing", pointId };
  }

  const previousValueRaw = pointCandidate.previousValueRaw ?? pointCandidate.previousValue ?? null;

  return {
    row: {
      id,
      pointId,
      quality: normalizeQuality(pointCandidate.quality),
      valueRaw,
      previousValueRaw,
      value: toFiniteNumber(pointCandidate.value) ?? null,
      previousValue: toFiniteNumber(pointCandidate.previousValue) ?? null,
      timestamp,
      gatewayTimestamp,
    },
  };
}

function createInsertStatement(
  tableName: string,
  rows: PointValueRow[],
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const tuples: string[] = [];

  for (const [index, row] of rows.entries()) {
    const offset = index * 9;
    tuples.push(
      `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}::"PointValueQuality", $${offset + 4}::jsonb, $${offset + 5}::jsonb, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`,
    );
    values.push(
      row.id,
      row.pointId,
      row.quality,
      JSON.stringify(row.valueRaw),
      row.previousValueRaw === null ? null : JSON.stringify(row.previousValueRaw),
      row.value,
      row.previousValue,
      row.timestamp,
      row.gatewayTimestamp,
    );
  }

  return {
    text: `INSERT INTO ${tableName} (id, "pointId", quality, "valueRaw", "previousValueRaw", value, "previousValue", timestamp, "gatewayTimestamp") VALUES ${tuples.join(", ")} ON CONFLICT (id) DO NOTHING`,
    values,
  };
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DbEventsProcessor extends Processor {
  flushPending(): Promise<void>;
}

export function createDbEventsProcessor(args: {
  config: DbEventsProcessorConfig;
  queryClient: DbEventsQueryClient;
  logger: ProcessorContext["logger"];
}): DbEventsProcessor {
  const tableName = formatTableName(args.config.table);
  const pending: PendingEvent[] = [];
  let flushTimer: NodeJS.Timeout | undefined;
  let flushLoopPromise: Promise<void> | undefined;
  let forceFlush = false;
  let abortListenerAttached = false;

  function clearFlushTimer(): void {
    if (!flushTimer) {
      return;
    }

    clearTimeout(flushTimer);
    flushTimer = undefined;
  }

  function scheduleFlushTimer(): void {
    if (args.config.batchWindowMs === 0 || flushTimer) {
      return;
    }

    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void startFlushLoop();
    }, args.config.batchWindowMs);
  }

  async function flushBatch(batch: PendingEvent[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }

    const rows: PointValueRow[] = [];
    for (const entry of batch) {
      const result = buildPointValueRow(entry.event);
      if ("reason" in result) {
        args.logger.warn("skipping point value insert", {
          processor: "db-events",
          eventId: entry.event.id,
          topic: entry.event.topic,
          reason: result.reason,
          pointId: result.pointId,
        });
        continue;
      }

      rows.push(result.row);
    }

    if (rows.length === 0) {
      for (const entry of batch) {
        entry.resolve();
      }
      return;
    }

    const statement = createInsertStatement(tableName, rows);

    try {
      await withTimeout(
        args.queryClient.query(statement.text, statement.values),
        args.config.insertTimeoutMs,
        "db batch insert",
      );
      for (const entry of batch) {
        entry.resolve();
      }
    } catch (error) {
      args.logger.warn("failed to insert point value batch", {
        processor: "db-events",
        batchSize: batch.length,
        eventId: batch[0]?.event.id,
        topic: batch[0]?.event.topic,
        error: normalizeError(error),
      });

      for (const entry of batch) {
        entry.reject(error);
      }
    }
  }

  async function startFlushLoop(): Promise<void> {
    if (flushLoopPromise) {
      return flushLoopPromise;
    }

    flushLoopPromise = (async () => {
      try {
        while (pending.length > 0) {
          if (
            !forceFlush &&
            args.config.batchWindowMs > 0 &&
            pending.length < args.config.batchMaxRows &&
            flushTimer
          ) {
            return;
          }

          clearFlushTimer();
          const batch = pending.splice(0, args.config.batchMaxRows);
          await flushBatch(batch);

          if (
            !forceFlush &&
            args.config.batchWindowMs > 0 &&
            pending.length > 0 &&
            pending.length < args.config.batchMaxRows
          ) {
            scheduleFlushTimer();
            return;
          }
        }
      } finally {
        flushLoopPromise = undefined;
        forceFlush = false;

        if (
          pending.length > 0 &&
          (args.config.batchWindowMs === 0 || pending.length >= args.config.batchMaxRows)
        ) {
          void startFlushLoop();
        }
      }
    })();

    return flushLoopPromise;
  }

  function ensureAbortListener(signal: AbortSignal): void {
    if (abortListenerAttached) {
      return;
    }

    abortListenerAttached = true;
    if (signal.aborted) {
      forceFlush = true;
      clearFlushTimer();
      void startFlushLoop();
      return;
    }

    signal.addEventListener(
      "abort",
      () => {
        forceFlush = true;
        clearFlushTimer();
        void startFlushLoop();
      },
      { once: true },
    );
  }

  return {
    name: "db-events",
    matches: (event) => event.metadata?.resource === "Points",
    async process(event, context): Promise<void> {
      ensureAbortListener(context.signal);

      await new Promise<void>((resolve, reject) => {
        pending.push({ event, resolve, reject });

        if (args.config.batchWindowMs === 0 || pending.length >= args.config.batchMaxRows) {
          void startFlushLoop();
          return;
        }

        scheduleFlushTimer();
      });
    },
    async flushPending(): Promise<void> {
      forceFlush = true;
      clearFlushTimer();
      await startFlushLoop();
    },
  };
}
