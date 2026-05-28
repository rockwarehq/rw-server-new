import type { ActionHandler } from "@rw/triggers";
import { getUserById } from "../refs.js";

/**
 * `sendAlert` — logs an alert text and the resolved emails of one or more picked users.
 *
 * Per-version `inputSchema` + `run` live together so they can't disagree. Stored input is user
 * ids; the handler resolves them to `User` objects at run time (no framework hydration today,
 * see @rw/triggers README "Ref data sources").
 *
 * Add a new version (e.g. switch from a flat `recipientUserIds` to a structured
 * `{ to: [ids], cc: [ids] }`) by adding a `"2"` entry; v1 triggers keep running against the v1
 * handler. Bump `latest` when the editor should default to the new version for new triggers.
 *
 * Replace this with a real `sendEmail` handler by writing a sibling module and adding it to
 * `actions/index.ts`.
 */
export const handler: ActionHandler = {
  type: "sendAlert",
  displayName: "Send Alert",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["text", "recipientUserIds"],
        properties: {
          text: {
            type: "string",
            title: "Alert Text",
            description: "Message to log. Supports {{event.payload.*}} variables.",
          },
          recipientUserIds: {
            type: "array",
            items: { type: "string" },
            title: "Recipients",
            description: "Pick one or more users; the alert logs each user's email.",
            // Editor renders a multi-select populated by `RefRegistry.list("users")` (see refs.ts).
            // Stored value is `string[]` of user ids; the handler resolves ids → emails at run time.
            ref: { source: "users", multi: true },
          },
        },
      },
      run(inputs, ctx) {
        const text = String(inputs.text ?? "");
        const ids = Array.isArray(inputs.recipientUserIds) ? inputs.recipientUserIds.map(String) : [];

        const recipients: string[] = [];
        for (const id of ids) {
          const user = getUserById(id);
          if (user) recipients.push(`${user.name} <${user.email}>`);
          else console.warn(`[triggers] sendAlert: unknown user id "${id}" — skipped`);
        }

        console.log(
          `[triggers] ALERT (${ctx.trigger.label}): ${text} -> ${recipients.join(", ") || "(no recipients)"}`,
        );
      },
    },
  },
};
