import type { ActionRegistry } from "./actions.js";
import { buildCatalog } from "./catalog.js";
import type { ContextBuilder } from "./context.js";
import { createAutomationEngine, type AutomationEngine } from "./engine.js";
import type { RunRecorder } from "./recorder.js";
import { createRefRegistry, type RefContext, type RefOption, type RefRegistry } from "./refs.js";
import type { AutomationStore } from "./store.js";
import type { ActionSchema, AppEvent, Catalog, EventSchema, EventType } from "./types.js";
import { createValidators } from "./validate.js";

/**
 * Everything the engine needs from the consuming app. The app supplies its domain (schemas,
 * fact builders, action handlers, store); the engine supplies the evaluation machinery.
 */
export interface AutomationFrameworkConfig {
  /** Event types the app understands, keyed by type. */
  eventSchemas: Record<EventType, EventSchema>;
  /** Actions the app understands, keyed by type. */
  actionSchemas: Record<string, ActionSchema>;
  /** Where automation definitions live. */
  store: AutomationStore;
  /** Per-event-type fact builders (SEAM A). Must include every key in `eventSchemas`. */
  contextBuilders: Record<EventType, ContextBuilder>;
  /** Registered action handlers (SEAM C). */
  actions: ActionRegistry;
  /**
   * Optional ref-data-source registry. Only required if any action input schema declares
   * `ref: { source: ... }`. Startup validation throws if a declared source isn't registered.
   */
  refs?: RefRegistry;
  /** Audit sink for `fire()` runs. Defaults to `noopRunRecorder` when omitted. */
  recorder?: RunRecorder;
}

/** Options for `fire()` — version can be specified to raise as a non-latest schema. */
export interface FireOptions {
  /** Event schema version to raise as. Defaults to the event's `latest`. */
  version?: string;
}

export interface AutomationFramework {
  store: AutomationStore;
  engine: AutomationEngine;
  /** The event schemas the framework was configured with (read-only — for RPC layers resolving `latest`). */
  eventSchemas: Record<EventType, EventSchema>;
  /** The action schemas the framework was configured with (read-only — for RPC layers resolving `latest`). */
  actionSchemas: Record<string, ActionSchema>;
  /**
   * Editor catalog for a specific event/action type and (optionally) versions. If a version is
   * omitted, each schema's `latest` is used. Throws on unknown type or version.
   */
  catalog(eventType: EventType, actionType: string, eventVersion?: string, actionVersion?: string): Catalog;
  /** Validate action inputs against a specific schema version. Throws on invalid; returns the normalized inputs on success. */
  validateActionInputs(actionType: string, version: string, inputs: unknown): Record<string, unknown>;
  /**
   * Picker-options endpoint for the editor UI. Resolves `source` against the configured
   * `RefRegistry` and calls its `list(ctx)`. Throws if `source` isn't registered.
   */
  listRefOptions(source: string, ctx?: RefContext): Promise<RefOption[]>;
  /**
   * Validate a payload against its event type's schema (at `opts.version` or `latest`), then build
   * + submit the event. The in-process entry point for raising events. Throws on invalid payload,
   * unknown event type, unknown version, or any misconfigured action in the matched set. See the
   * README's "Error model" for the convention.
   */
  fire(
    type: EventType,
    payload: Record<string, unknown>,
    opts?: FireOptions,
  ): Promise<{ eventId: string; matched: string[] }>;
}

/**
 * Assemble the framework from an app's domain config. Wires the engine, validators, and
 * `fire()` together and indexes the current automations (`engine.reload()`).
 *
 * Startup validation throws if any declared schema is inconsistent: missing context builder, missing
 * ref source, `latest` pointing at an absent version, or an action version declared in the schema
 * with no registered handler.
 */
export function createAutomationFramework(config: AutomationFrameworkConfig): AutomationFramework {
  const { store, eventSchemas, actionSchemas, contextBuilders } = config;
  const refs = config.refs ?? createRefRegistry();
  const validators = createValidators(eventSchemas, actionSchemas);

  // Fail fast: every declared event type must have a fact builder. Catches typos and missed
  // registrations at startup instead of silently using wrong facts at the first dispatch.
  for (const type of Object.keys(eventSchemas)) {
    if (!contextBuilders[type]) {
      throw new Error(`no context builder registered for event type "${type}"`);
    }
  }

  // Fail fast: every event schema's `latest` must point at an existing version.
  for (const [type, schema] of Object.entries(eventSchemas)) {
    if (!schema.versions[schema.latest]) {
      throw new Error(`event "${type}" latest="${schema.latest}" is not a key in versions`);
    }
  }

  // Fail fast: every action schema's `latest` must point at an existing version, and every
  // (type, version) declared in the schema must have a corresponding registered handler version.
  for (const [type, schema] of Object.entries(actionSchemas)) {
    if (!schema.versions[schema.latest]) {
      throw new Error(`action "${type}" latest="${schema.latest}" is not a key in versions`);
    }
    for (const v of Object.keys(schema.versions)) {
      if (!config.actions.get(type, v)) {
        throw new Error(`action "${type}@${v}" declared in schema has no registered handler version`);
      }
    }
  }

  // Fail fast: every `ref.source` declared in any action input schema (across all versions) must
  // be registered. Catches a missing RefSource at boot instead of when an editor opens a picker.
  for (const action of Object.values(actionSchemas)) {
    for (const [version, v] of Object.entries(action.versions)) {
      for (const [key, prop] of Object.entries(v.inputSchema.properties)) {
        if (prop.ref && !refs.get(prop.ref.source)) {
          throw new Error(
            `action "${action.type}@${version}" input "${key}" references unknown ref source "${prop.ref.source}"`,
          );
        }
      }
    }
  }

  const engine = createAutomationEngine({
    store,
    contextBuilders,
    actions: config.actions,
    recorder: config.recorder,
  });
  engine.reload();

  return {
    store,
    engine,
    eventSchemas,
    actionSchemas,
    catalog: (eventType, actionType, eventVersion, actionVersion) =>
      buildCatalog(eventSchemas, actionSchemas, eventType, actionType, eventVersion, actionVersion),
    validateActionInputs: validators.validateActionInputs,
    async listRefOptions(source, ctx = {}) {
      const ref = refs.get(source);
      if (!ref) throw new Error(`unknown ref source: ${source}`);
      return ref.list(ctx);
    },
    async fire(type, payload, opts) {
      const eventSchema = eventSchemas[type];
      if (!eventSchema) throw new Error(`unknown event type: ${type}`);
      const version = opts?.version ?? eventSchema.latest;
      const normalized = validators.validateEventPayload(type, version, payload);
      const event: AppEvent = {
        // UUID v4 — DB stores eventId as `@db.Uuid`, and a stable id format helps downstream
        // tracing (logs, audit rows, external systems) all line up. Uses the Web Crypto global
        // (`globalThis.crypto`) so the package stays isomorphic — works in Node 20+ and browsers
        // without a `node:crypto` import.
        id: globalThis.crypto.randomUUID(),
        type,
        version,
        ts: new Date().toISOString(),
        payload: normalized,
      };
      const matched = await engine.dispatch(event);
      return { eventId: event.id, matched };
    },
  };
}
