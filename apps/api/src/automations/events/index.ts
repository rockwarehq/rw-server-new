import type { ContextBuilder, EventSchema, EventType } from "@rw/automations";
import * as jobChanged from "./job-changed.js";

/**
 * Event aggregator. Each event module exports `schema: EventSchema` (versioned) + `contextBuilder`;
 * this file collects them into the maps the framework consumes. Add a new event = drop a module
 * in this folder, add one import + one entry below. Schema (versioned) and context builder live
 * in the same module so they can't drift.
 */

type EventModule = { schema: EventSchema; contextBuilder: ContextBuilder };

const modules: readonly EventModule[] = [jobChanged] as const;

/** Every event type the app understands, keyed by type. Each entry carries `latest` + `versions`. */
export const EVENT_SCHEMAS: Record<EventType, EventSchema> = Object.fromEntries(
  modules.map((m) => [m.schema.type, m.schema]),
);

/** Per-event-type fact builders (SEAM A). One per event module (shared across that type's versions today). */
export function buildContextBuilders(): Record<EventType, ContextBuilder> {
  return Object.fromEntries(modules.map((m) => [m.schema.type, m.contextBuilder]));
}
