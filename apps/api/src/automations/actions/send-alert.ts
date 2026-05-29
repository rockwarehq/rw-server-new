import type { ActionHandler } from "@rw/automations";
import { sendAlertEmail } from "@rw/services/email/index";
import { getUserById } from "@rw/services/user/automation-ref";

/**
 * `sendAlert` — emails an alert message to one or more picked users.
 *
 * Recipients are users because only `User` carries an email (employees don't — see
 * `@rw/services/user/automation-ref`). Per-version `inputSchema` + `run` live together so they
 * can't disagree. Stored input is user ids; the handler resolves them to emails at run time via
 * `@rw/services/user/automation-ref` (no framework hydration today, see @rw/automations README
 * "Ref data sources"). The `text` and `subject` arrive already interpolated by the engine
 * (`{{event.payload.*}}` resolved); `subject` is user-defined and falls back to the firing
 * event's name when left blank.
 *
 * Add a new version (e.g. switch from a flat `recipientUserIds` to a structured
 * `{ to: [ids], cc: [ids] }`) by adding a `"2"` entry; v1 automations keep running against the v1
 * handler. Bump `latest` when the editor should default to the new version for new automations.
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
          subject: {
            type: "string",
            title: "Alert Subject",
            description: "Email subject. Supports {{event.payload.*}} variables. Defaults to the event name if blank.",
          },
          text: {
            type: "string",
            title: "Alert Text",
            description: "Message body to email. Supports {{event.payload.*}} variables.",
          },
          recipientUserIds: {
            type: "array",
            items: { type: "string" },
            title: "Recipients",
            description: "Pick one or more users; the alert logs each user's email.",
            // Editor renders a multi-select populated by `RefRegistry.list("users")` (see
            // @rw/services/user/automation-ref). Stored value is `string[]` of user ids;
            // handler resolves ids → emails at run time.
            ref: { source: "users", multi: true },
          },
        },
      },
      async run(inputs, ctx) {
        const text = String(inputs.text ?? "");
        const subject = String(inputs.subject ?? "").trim() || ctx.automation.event;
        const ids = Array.isArray(inputs.recipientUserIds) ? inputs.recipientUserIds.map(String) : [];

        const recipients: string[] = [];
        for (const id of ids) {
          const user = await getUserById(id);
          if (user) recipients.push(user.email);
          else console.warn(`[automations] sendAlert: unknown user id "${id}" — skipped`);
        }

        if (recipients.length === 0) {
          console.warn(`[automations] sendAlert (${ctx.automation.label}): no recipients resolved — skipped`);
          return;
        }

        const result = await sendAlertEmail({ to: recipients, subject, message: text });
        if (!result.success) {
          throw new Error(`sendAlert email failed: ${result.error}`);
        }
      },
    },
  },
};
