import type {
  Dispatcher,
  EventPreprocessor,
  Logger,
  Metrics,
  ParsedEvent,
  ProcessorRuntimeEntry,
} from "./types.js";

export function createDispatcher(args: {
  entries: ProcessorRuntimeEntry[];
  metrics: Metrics;
  logger: Logger;
  preprocessors?: EventPreprocessor[];
}): Dispatcher {
  const { entries, metrics, logger } = args;
  const preprocessors = args.preprocessors ?? [];

  async function runPreprocessors(input: ParsedEvent): Promise<ParsedEvent[]> {
    let events = [input];

    for (const preprocessor of preprocessors) {
      const nextEvents: ParsedEvent[] = [];

      for (const event of events) {
        try {
          const processedEvents = await preprocessor.process(event);
          nextEvents.push(...processedEvents);
        } catch (error) {
          logger.warn("event preprocessor failed", {
            preprocessor: preprocessor.name,
            eventId: event.id,
            topic: event.topic,
            error: error instanceof Error ? error.message : String(error),
            failureMode: preprocessor.failureMode ?? "strict",
          });

          if ((preprocessor.failureMode ?? "strict") === "strict") {
            throw error;
          }

          nextEvents.push(event);
        }
      }

      events = nextEvents;
    }

    return events;
  }

  return {
    async dispatch(event: ParsedEvent): Promise<void> {
      const events = await runPreprocessors(event);
      const tasks: Array<Promise<void>> = [];

      for (const preprocessedEvent of events) {
        for (const entry of entries) {
          tasks.push(
            (async () => {
              let shouldHandle = false;

              try {
                shouldHandle = await entry.processor.matches(preprocessedEvent);
              } catch (error) {
                logger.error("processor matcher failed", {
                  processor: entry.processor.name,
                  eventId: preprocessedEvent.id,
                  error: error instanceof Error ? error.message : String(error),
                });
                return;
              }

              if (!shouldHandle) {
                return;
              }

              const result = await entry.runtime.submit(preprocessedEvent);
              if (result.accepted) {
                metrics.incSubmitted(entry.processor.name);
                return;
              }

              metrics.incRejected(entry.processor.name);
            })(),
          );
        }
      }

      await Promise.all(tasks);
    },
    async shutdown(options?: { drainTimeoutMs?: number }): Promise<void> {
      await Promise.all(entries.map((entry) => entry.runtime.shutdown(options)));
    },
  };
}
