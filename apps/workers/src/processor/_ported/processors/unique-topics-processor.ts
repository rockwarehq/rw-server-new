import type { Logger, ParsedEvent, Processor } from "../pipeline/types.js";

export function createUniqueTopicsProcessor(args: { logger: Logger }): Processor {
  const topics = new Set<string>();

  return {
    name: "unique-topics",
    matches: () => true,
    async process(event: ParsedEvent): Promise<void> {
      if (topics.has(event.topic)) {
        return;
      }

      topics.add(event.topic);
      const uniqueTopics = Array.from(topics).sort();

      args.logger.info("unique topics snapshot", {
        processor: "unique-topics",
        topic: event.topic,
        uniqueTopicsCount: uniqueTopics.length,
        uniqueTopics,
      });
    },
  };
}
