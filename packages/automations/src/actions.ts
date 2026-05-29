import type { ActionInputSchema, Automation } from "./types.js";

/** Everything an action handler receives when it runs. */
export interface ActionContext {
  automation: Automation;
  eventId: string;
}

/** One version's behavior: input shape + run function. Schema and run can't drift — they live in the same object. */
export interface ActionVersion {
  inputSchema: ActionInputSchema;
  run(inputs: Record<string, unknown>, ctx: ActionContext): void | Promise<void>;
}

/**
 * SEAM C — a runnable action with one or more versions. Each entry in `versions` is a
 * self-contained `(inputSchema, run)` pair; stored automations pin a specific version via
 * `AutomationAction.version`, and dispatch resolves the handler with a strict `(type, version)` lookup.
 *
 * Register actions (sendAlert, createForm, sendEmail, …) in the consuming app's composition root.
 * Adding a new version of an existing action = add a `versions[<v>]` entry; the framework keeps
 * old versions working as long as their key stays in the map.
 */
export interface ActionHandler {
  type: string;
  /** Editor-facing label, mirrored onto the derived `ActionSchema` for the catalog. */
  displayName: string;
  /** Version key used when authoring a NEW automation. Must be a key in `versions`. */
  latest: string;
  /** All known versions of this action's behavior, keyed by version. */
  versions: Record<string, ActionVersion>;
}

/** Returns the first missing required input key, or null if all required inputs are present. */
export function missingRequired(inputs: Record<string, unknown>, schema: ActionInputSchema): string | null {
  for (const key of schema.required) {
    const v = inputs[key];
    if (v == null) return key;
    if (typeof v === "string" && v === "") return key;
    if (Array.isArray(v) && v.filter((x) => x !== "" && x != null).length === 0) return key;
  }
  return null;
}

/** A registry of action handlers, keyed by `type`. Per-version lookup happens on `get`. */
export interface ActionRegistry {
  /** Add a handler (with all its versions). Returns the registry so calls can be chained. */
  register(handler: ActionHandler): ActionRegistry;
  /** Look up a specific version of a handler. Returns undefined if the type OR the version isn't registered. */
  get(type: string, version: string): ActionVersion | undefined;
  /** The `latest` pointer for a type, or undefined if the type isn't registered. */
  latest(type: string): string | undefined;
  /** All registered action types (for startup validation + introspection). */
  types(): string[];
  /** All registered (type, version) pairs (for startup validation + introspection). */
  entries(): Array<{ type: string; version: string }>;
}

export function createActionRegistry(): ActionRegistry {
  const handlers = new Map<string, ActionHandler>();
  const registry: ActionRegistry = {
    register(handler) {
      handlers.set(handler.type, handler);
      return registry;
    },
    get(type, version) {
      return handlers.get(type)?.versions[version];
    },
    latest(type) {
      return handlers.get(type)?.latest;
    },
    types() {
      return [...handlers.keys()];
    },
    entries() {
      const out: Array<{ type: string; version: string }> = [];
      for (const [type, h] of handlers) {
        for (const v of Object.keys(h.versions)) out.push({ type, version: v });
      }
      return out;
    },
  };
  return registry;
}
