import type { ParsedEvent, Processor } from "../pipeline/types.js";

function stringifyPayload(payload: ParsedEvent["payload"]): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return "[unserializable payload]";
  }
}

export const consoleProcessor: Processor = {
  name: "console",
  matches: () => true,
  async process(event): Promise<void> {
    console.log(`[processor:console] ${event.topic} ${stringifyPayload(event.payload)}`);
  },
};
