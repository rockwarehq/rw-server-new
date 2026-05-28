import type { ActionInputSchema, Trigger } from "./types.js";

/** Everything an action handler receives when it runs. */
export interface ActionContext {
  trigger: Trigger;
  eventId: string;
}

/**
 * SEAM C — a runnable action. `inputSchema` drives validation (and the editor UI); `run` does the
 * work. Register handlers (sendAlert, createForm, sendEmail, …) in the consuming app's composition
 * root — the engine resolves the handler by `trigger.action.type`, so adding an action never
 * touches the engine.
 */
export interface ActionHandler {
  type: string;
  inputSchema: ActionInputSchema;
  run(inputs: Record<string, unknown>, ctx: ActionContext): void | Promise<void>;
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

/** A registry of action handlers, keyed by `type`. */
export interface ActionRegistry {
  /** Add a handler. Returns the registry so calls can be chained. */
  register(handler: ActionHandler): ActionRegistry;
  /** Look up a handler by its action type. */
  get(type: string): ActionHandler | undefined;
}

export function createActionRegistry(): ActionRegistry {
  const handlers = new Map<string, ActionHandler>();
  const registry: ActionRegistry = {
    register(handler) {
      handlers.set(handler.type, handler);
      return registry;
    },
    get(type) {
      return handlers.get(type);
    },
  };
  return registry;
}
