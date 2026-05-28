import { type ActionHandler, type ActionRegistry, type ActionSchema, createActionRegistry } from "@rw/triggers";
import * as sendAlert from "./send-alert.js";

/**
 * Action aggregator. Each action module exports one versioned `handler: ActionHandler`; this file
 * builds two views from it:
 *   - `ACTION_SCHEMAS`: catalog view (no `run`) — what the editor + RPC layer see.
 *   - `buildActionRegistry()`: full handlers (with `run`) — what dispatch uses, keyed by (type, version).
 *
 * Add a new action = drop a module in this folder, add one import + one entry below. Each
 * version's `inputSchema` is the single source of truth — the catalog view is derived from the
 * handler, so they can't disagree.
 */

const modules: readonly { handler: ActionHandler }[] = [sendAlert] as const;

/** Catalog view: strip `run` from each version so schemas are serializable + don't leak code. */
function toActionSchema(h: ActionHandler): ActionSchema {
  return {
    type: h.type,
    displayName: h.displayName,
    latest: h.latest,
    versions: Object.fromEntries(Object.entries(h.versions).map(([v, av]) => [v, { inputSchema: av.inputSchema }])),
  };
}

/** Every action the app understands, keyed by type. Each entry carries `latest` + `versions`. */
export const ACTION_SCHEMAS: Record<string, ActionSchema> = Object.fromEntries(
  modules.map((m) => [m.handler.type, toActionSchema(m.handler)]),
);

/** Registered action handlers (SEAM C). One per action module. */
export function buildActionRegistry(): ActionRegistry {
  const reg = createActionRegistry();
  for (const m of modules) reg.register(m.handler);
  return reg;
}
