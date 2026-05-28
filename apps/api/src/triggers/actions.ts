import type { ActionHandler } from "@rw/triggers";
import { ACTION_SCHEMAS } from "./catalog.js";

/**
 * Example action. "Execute" logs the interpolated message + recipients (no real email is sent —
 * this is the placeholder a real `sendEmail`/`createForm` handler would replace). Register it in
 * registry.ts; the engine (in @rw/triggers) resolves it by `trigger.action.type`.
 */
export const sendAlertHandler: ActionHandler = {
  type: "sendAlert",
  inputSchema: ACTION_SCHEMAS.sendAlert?.inputSchema ?? { required: [], properties: {} },
  run(inputs, ctx) {
    const text = String(inputs.text ?? "");
    const emails = Array.isArray(inputs.emails) ? inputs.emails.map(String).filter((e) => e.length > 0) : [];

    console.log(`[triggers] ALERT (${ctx.trigger.label}): ${text} -> ${emails.join(", ") || "(no recipients)"}`);
  },
};
