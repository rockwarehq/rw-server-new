import type {
  Logger,
  Metrics,
  ParsedEvent,
  Processor,
  ProcessorContext,
  ProcessorRuntime,
  ProcessorRuntimeConfig,
  RuntimeSubmitResult,
} from "../types.js";

class BoundedDeque<T> {
  private readonly buffer: Array<T | undefined>;
  private head = 0;
  private length = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array<T | undefined>(capacity);
  }

  size(): number {
    return this.length;
  }

  isFull(): boolean {
    return this.length >= this.capacity;
  }

  push(value: T): boolean {
    if (this.isFull()) {
      return false;
    }

    const tail = (this.head + this.length) % this.capacity;
    this.buffer[tail] = value;
    this.length += 1;
    return true;
  }

  shift(): T | undefined {
    if (this.length === 0) {
      return undefined;
    }

    const value = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.length -= 1;
    return value;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

export function createBoundedRuntime(args: {
  processor: Processor;
  config: ProcessorRuntimeConfig;
  metrics: Metrics;
  logger: Logger;
}): ProcessorRuntime {
  const { processor, config, metrics, logger } = args;
  const queue = new BoundedDeque<ParsedEvent>(config.queueCapacity);
  let inFlight = 0;
  let isShuttingDown = false;
  const abortController = new AbortController();

  const context: ProcessorContext = {
    processorName: processor.name,
    signal: abortController.signal,
    now: () => Date.now(),
    logger,
    metrics,
  };

  function updateQueueMetric(): void {
    metrics.setQueueDepth(processor.name, queue.size());
  }

  function updateInFlightMetric(): void {
    metrics.setInFlight(processor.name, inFlight);
  }

  function schedule(): void {
    while (inFlight < config.concurrency && queue.size() > 0) {
      const event = queue.shift();
      updateQueueMetric();

      if (!event) {
        continue;
      }

      inFlight += 1;
      updateInFlightMetric();

      const startedAt = Date.now();
      metrics.observeEventAgeAtStartMs(processor.name, startedAt - event.receivedAt);

      void withTimeout(processor.process(event, context), config.processTimeoutMs, processor.name)
        .then(() => {
          metrics.incProcessedOk(processor.name);
        })
        .catch((error) => {
          metrics.incProcessedFailed(processor.name);
          logger.error("processor execution failed", {
            processor: processor.name,
            eventId: event.id,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          const finishedAt = Date.now();
          metrics.observeProcessLatencyMs(processor.name, finishedAt - startedAt);
          inFlight -= 1;
          updateInFlightMetric();
          schedule();
        });
    }
  }

  updateQueueMetric();
  updateInFlightMetric();

  return {
    processor,
    async submit(event: ParsedEvent): Promise<RuntimeSubmitResult> {
      if (isShuttingDown) {
        metrics.incRejected(processor.name);
        return { accepted: false, reason: "shutting_down" };
      }

      let droppedOldest = false;
      if (queue.isFull()) {
        queue.shift();
        metrics.incDroppedOldest(processor.name);
        droppedOldest = true;
      }

      queue.push(event);
      updateQueueMetric();
      schedule();
      return { accepted: true, dropped: droppedOldest ? "oldest" : undefined };
    },
    snapshot() {
      return {
        processorName: processor.name,
        queueDepth: queue.size(),
        inFlight,
        concurrency: config.concurrency,
        queueCapacity: config.queueCapacity,
      };
    },
    async shutdown(options?: { drainTimeoutMs?: number }): Promise<void> {
      isShuttingDown = true;

      const drainTimeoutMs = options?.drainTimeoutMs ?? 10_000;
      const waitStartedAt = Date.now();

      while (queue.size() > 0 || inFlight > 0) {
        if (Date.now() - waitStartedAt > drainTimeoutMs) {
          logger.warn("processor runtime drain timed out", {
            processor: processor.name,
            queueDepth: queue.size(),
            inFlight,
          });
          break;
        }

        await sleep(25);
      }

      abortController.abort();
    },
  };
}
