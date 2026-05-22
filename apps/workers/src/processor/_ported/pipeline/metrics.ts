import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

import type { Logger, Metrics, MetricsSnapshot } from "./types.js";

interface ProcessorMetricsInternal {
  submitted: number;
  rejected: number;
  processedOk: number;
  processedFailed: number;
  droppedOldest: number;
  queueDepth: number;
  inFlight: number;
}

function createZeroMetrics(): ProcessorMetricsInternal {
  return {
    submitted: 0,
    rejected: 0,
    processedOk: 0,
    processedFailed: 0,
    droppedOldest: 0,
    queueDepth: 0,
    inFlight: 0,
  };
}

const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const parsedTotal = new Counter({
  name: "event_processor_parsed_total",
  help: "Total parsed events by status",
  labelNames: ["status"] as const,
  registers: [metricsRegistry],
});

const dispatchSubmissionsTotal = new Counter({
  name: "event_processor_dispatch_submissions_total",
  help: "Total processor runtime submissions by status",
  labelNames: ["processor", "status"] as const,
  registers: [metricsRegistry],
});

const processedTotal = new Counter({
  name: "event_processor_processed_total",
  help: "Total processed events by processor and status",
  labelNames: ["processor", "status"] as const,
  registers: [metricsRegistry],
});

const droppedTotal = new Counter({
  name: "event_processor_dropped_total",
  help: "Total dropped events by processor and policy",
  labelNames: ["processor", "policy"] as const,
  registers: [metricsRegistry],
});

const queueDepthGauge = new Gauge({
  name: "event_processor_queue_depth",
  help: "Current queue depth per processor",
  labelNames: ["processor"] as const,
  registers: [metricsRegistry],
});

const inFlightGauge = new Gauge({
  name: "event_processor_in_flight",
  help: "Current in-flight messages per processor",
  labelNames: ["processor"] as const,
  registers: [metricsRegistry],
});

const processLatencySeconds = new Histogram({
  name: "event_processor_process_latency_seconds",
  help: "Processor execution latency in seconds",
  labelNames: ["processor"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});

const eventAgeAtStartSeconds = new Histogram({
  name: "event_processor_event_age_at_start_seconds",
  help: "Event age at processing start in seconds",
  labelNames: ["processor"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

const upGauge = new Gauge({
  name: "event_processor_up",
  help: "Service health state",
  registers: [metricsRegistry],
});

class PrometheusMetrics implements Metrics {
  private readonly byProcessor = new Map<string, ProcessorMetricsInternal>();
  private parsedOk = 0;
  private parseError = 0;

  private ensure(processorName: string): ProcessorMetricsInternal {
    let state = this.byProcessor.get(processorName);
    if (!state) {
      state = createZeroMetrics();
      this.byProcessor.set(processorName, state);
    }
    return state;
  }

  incParsedOk(): void {
    this.parsedOk += 1;
    parsedTotal.inc({ status: "ok" });
  }

  incParseError(): void {
    this.parseError += 1;
    parsedTotal.inc({ status: "error" });
  }

  incSubmitted(processorName: string): void {
    this.ensure(processorName).submitted += 1;
    dispatchSubmissionsTotal.inc({ processor: processorName, status: "accepted" });
  }

  incRejected(processorName: string): void {
    this.ensure(processorName).rejected += 1;
    dispatchSubmissionsTotal.inc({ processor: processorName, status: "rejected" });
  }

  incProcessedOk(processorName: string): void {
    this.ensure(processorName).processedOk += 1;
    processedTotal.inc({ processor: processorName, status: "ok" });
  }

  incProcessedFailed(processorName: string): void {
    this.ensure(processorName).processedFailed += 1;
    processedTotal.inc({ processor: processorName, status: "failed" });
  }

  incDroppedOldest(processorName: string): void {
    this.ensure(processorName).droppedOldest += 1;
    droppedTotal.inc({ processor: processorName, policy: "drop_oldest" });
  }

  setQueueDepth(processorName: string, value: number): void {
    this.ensure(processorName).queueDepth = value;
    queueDepthGauge.set({ processor: processorName }, value);
  }

  setInFlight(processorName: string, value: number): void {
    this.ensure(processorName).inFlight = value;
    inFlightGauge.set({ processor: processorName }, value);
  }

  observeProcessLatencyMs(processorName: string, value: number): void {
    processLatencySeconds.observe({ processor: processorName }, value / 1000);
  }

  observeEventAgeAtStartMs(processorName: string, value: number): void {
    eventAgeAtStartSeconds.observe({ processor: processorName }, value / 1000);
  }

  setServiceUp(value: 0 | 1): void {
    upGauge.set(value);
  }

  getSnapshotByProcessor(): Record<string, MetricsSnapshot> {
    const snapshot: Record<string, MetricsSnapshot> = {};
    for (const [name, state] of this.byProcessor.entries()) {
      snapshot[name] = {
        parsedOk: this.parsedOk,
        parseError: this.parseError,
        submitted: state.submitted,
        rejected: state.rejected,
        processedOk: state.processedOk,
        processedFailed: state.processedFailed,
        droppedOldest: state.droppedOldest,
        queueDepth: state.queueDepth,
        inFlight: state.inFlight,
      };
    }
    return snapshot;
  }
}

export function createMetrics(): Metrics {
  const metrics = new PrometheusMetrics();
  metrics.setServiceUp(1);
  return metrics;
}

export async function renderMetricsText(): Promise<string> {
  return metricsRegistry.metrics();
}

export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}

export function startMetricsReporter(args: {
  metrics: Metrics;
  logger: Logger;
  intervalMs: number;
}): () => void {
  const timer = setInterval(() => {
    const snapshot = args.metrics.getSnapshotByProcessor();
    const processorNames = Object.keys(snapshot);

    if (processorNames.length === 0) {
      args.logger.info("metrics snapshot", { processors: 0 });
      return;
    }

    for (const processorName of processorNames) {
      /*
      args.logger.info("metrics snapshot", {
        processor: processorName,
        ...snapshot[processorName],
      });
      */
    }
  }, args.intervalMs);

  return () => {
    clearInterval(timer);
  };
}
