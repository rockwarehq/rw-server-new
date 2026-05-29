import { type ActionHandler, type ActionRegistry, type ActionSchema, createActionRegistry } from "@rw/automations";
import * as sendAlert from "./send-alert.js";

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
