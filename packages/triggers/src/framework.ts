import { nanoid } from "nanoid";
import type { ActionRegistry } from "./actions.js";
import { buildCatalog } from "./catalog.js";
import type { ContextBuilder } from "./context.js";
import { createTriggerEngine, type TriggerEngine } from "./engine.js";
import { createSyncIngestRuntime, type IngestRuntime } from "./ingest.js";
import type { TriggerStore } from "./store.js";
import type { ActionSchema, AppEvent, Catalog, EventSchema, EventType } from "./types.js";
import { createValidators } from "./validate.js";

/**
 * Everything the engine needs from the consuming app. The app supplies its domain (schemas,
 * fact builders, action handlers, store); the engine supplies the evaluation machinery.
 */
export interface TriggerFrameworkConfig {
  /** Event types the app understands, keyed by type. */
  eventSchemas: Record<EventType, EventSchema>;
  /** Actions the app understands, keyed by type. */
  actionSchemas: Record<string, ActionSchema>;
  /** Where trigger definitions live. */
  store: TriggerStore;
  /** Per-event-type fact builders (SEAM A). Must include every key in `eventSchemas`. */
  contextBuilders: Record<EventType, ContextBuilder>;
  /** Registered action handlers (SEAM C). */
  actions: ActionRegistry;
}

export interface TriggerFramework {
  store: TriggerStore;
  engine: TriggerEngine;
  ingest: IngestRuntime;
  /** Editor catalog for a specific event/action type. Both args are required — the engine has no defaults. */
  catalog(eventType: EventType, actionType: string): Catalog;
  /** Validate action inputs against the configured action schemas. Throws on invalid; returns the normalized inputs on success. */
  validateActionInputs(actionType: string, inputs: unknown): Record<string, unknown>;
  /**
   * Validate a payload against its event type's schema, then build + submit the event. The
   * in-process entry point for raising events. Throws on invalid payload, unknown event type, or
   * any misconfigured action in the matched set (missing handler, missing required input). See the
   * README's "Error model" for the convention.
   */
  fire(type: EventType, payload: Record<string, unknown>): Promise<{ eventId: string; matched: string[] }>;
}

/**
 * Assemble the framework from an app's domain config. Wires the engine, ingestion, validators, and
 * `fire()` together and indexes the current triggers (`engine.reload()`).
 */
export function createTriggerFramework(config: TriggerFrameworkConfig): TriggerFramework {
  const { store, eventSchemas, actionSchemas, contextBuilders } = config;
  const validators = createValidators(eventSchemas, actionSchemas);

  // Fail fast: every declared event type must have a fact builder. Catches typos and missed
  // registrations at startup instead of silently using wrong facts at the first dispatch.
  for (const type of Object.keys(eventSchemas)) {
    if (!contextBuilders[type]) {
      throw new Error(`no context builder registered for event type "${type}"`);
    }
  }

  const engine = createTriggerEngine({ store, contextBuilders, actions: config.actions });
  engine.reload();
  const ingest = createSyncIngestRuntime(engine);

  return {
    store,
    engine,
    ingest,
    catalog: (eventType, actionType) => buildCatalog(eventSchemas, actionSchemas, eventType, actionType),
    validateActionInputs: validators.validateActionInputs,
    async fire(type, payload) {
      const normalized = validators.validateEventPayload(type, payload);
      const event: AppEvent = { id: nanoid(8), type, ts: new Date().toISOString(), payload: normalized };
      const matched = await ingest.submit(event);
      return { eventId: event.id, matched };
    },
  };
}
