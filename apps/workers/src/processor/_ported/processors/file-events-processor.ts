import { appendFile } from "node:fs/promises";

import type { Logger, LiveEventEnvelope, ParsedEvent, Processor } from "../pipeline/types.js";

interface FileEventsProcessorConfig {
  filePath: string;
}

function toLiveEventEnvelope(event: ParsedEvent): LiveEventEnvelope {
  return {
    eventId: event.id,
    timestamp: new Date(event.receivedAt).toISOString(),
    topic: event.topic,
    type: "mqtt_event",
    version: 1,
    metadata: event.metadata,
    payload: event.payload,
  };
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFileEventsProcessor(args: {
  config: FileEventsProcessorConfig;
  logger: Logger;
}): Processor {
  return {
    name: "file-events",
    matches: () => true,
    async process(event): Promise<void> {
      const line = `${JSON.stringify(toLiveEventEnvelope(event))}\n`;

      try {
        await appendFile(args.config.filePath, line, "utf8");
      } catch (error) {
        args.logger.warn("failed to append event to file", {
          processor: "file-events",
          eventId: event.id,
          topic: event.topic,
          filePath: args.config.filePath,
          error: normalizeError(error),
        });
        throw error;
      }
    },
  };
}
