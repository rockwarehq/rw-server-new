import { type Result, TaggedError } from "better-result";
import type { TagValueSnapshot } from "../station-events/types.js";

export type JsonObject = Record<string, unknown>;

export type TopicMetadata = {
  family: "rockware";
  version: string;
  gatewayId: string;
  deviceId?: string;
  resource: "Health" | "Points";
  scope: "gateway" | "device";
};

export interface ParsedEvent<TPayload extends JsonObject = JsonObject> {
  id: string;
  topic: string;
  metadata: TopicMetadata | null;
  receivedAt: number;
  parsedAt: number;
  payload: TPayload;
  raw: Buffer;
  /** Tag snapshots captured at preprocessing time for the reading keys in this event. */
  tagSnapshots?: Record<string, TagValueSnapshot>;
}

export interface LiveEventEnvelope {
  eventId: string;
  timestamp: string;
  topic: string;
  type: string;
  version: number;
  metadata: TopicMetadata | null;
  payload: unknown;
}

export class ParseError extends TaggedError("ParseError")<{
  code: "invalid_json" | "invalid_payload";
  message: string;
  topic: string;
}>() {}

export type ParseResult = Result<ParsedEvent, ParseError>;

export type OverflowPolicy = "drop_oldest";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface MetricsSnapshot {
  parsedOk: number;
  parseError: number;
  submitted: number;
  rejected: number;
  processedOk: number;
  processedFailed: number;
  droppedOldest: number;
  queueDepth: number;
  inFlight: number;
}

export interface Metrics {
  incParsedOk(): void;
  incParseError(): void;
  incSubmitted(processorName: string): void;
  incRejected(processorName: string): void;
  incProcessedOk(processorName: string): void;
  incProcessedFailed(processorName: string): void;
  incDroppedOldest(processorName: string): void;
  setQueueDepth(processorName: string, value: number): void;
  setInFlight(processorName: string, value: number): void;
  observeProcessLatencyMs(processorName: string, value: number): void;
  observeEventAgeAtStartMs(processorName: string, value: number): void;
  setServiceUp(value: 0 | 1): void;
  getSnapshotByProcessor(): Record<string, MetricsSnapshot>;
}

export interface ProcessorContext {
  processorName: string;
  signal: AbortSignal;
  now(): number;
  logger: Logger;
  metrics: Metrics;
}

export interface Processor {
  name: string;
  matches(event: ParsedEvent): boolean | Promise<boolean>;
  process(event: ParsedEvent, context: ProcessorContext): Promise<void>;
}

export interface ProcessorRuntimeConfig {
  concurrency: number;
  queueCapacity: number;
  overflow: OverflowPolicy;
  processTimeoutMs: number;
}

export interface RuntimeSubmitResult {
  accepted: boolean;
  dropped?: "oldest";
  reason?: "shutting_down";
}

export interface RuntimeSnapshot {
  processorName: string;
  queueDepth: number;
  inFlight: number;
  concurrency: number;
  queueCapacity: number;
}

export interface ProcessorRuntime {
  processor: Processor;
  submit(event: ParsedEvent): Promise<RuntimeSubmitResult>;
  snapshot(): RuntimeSnapshot;
  shutdown(options?: { drainTimeoutMs?: number }): Promise<void>;
}

export interface ProcessorRuntimeEntry {
  processor: Processor;
  runtime: ProcessorRuntime;
}

export interface EventPreprocessor {
  name: string;
  failureMode?: "strict" | "best_effort";
  process(event: ParsedEvent): Promise<ParsedEvent[]>;
}

export interface Dispatcher {
  dispatch(event: ParsedEvent): Promise<void>;
  shutdown(options?: { drainTimeoutMs?: number }): Promise<void>;
}
