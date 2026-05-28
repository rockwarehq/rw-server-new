import type { ActionSchema, EventSchema, EventType } from "@rw/triggers";

/**
 * Single source of truth for this app's event + action SCHEMAS. Served to clients
 * used by the engine to validate + drive evaluation
 *
 * Behavior attached to these schemas lives elsewhere and is wired in registry.ts:
 *   - how an event becomes facts  -> a ContextBuilder (registry.ts, @rw/triggers)
 *   - what an action does          -> an ActionHandler (actions.ts)
 * Adding an event/action type = a schema entry here + its behavior in the registry. The engine,
 * ingestion, and validation (in @rw/triggers) derive from these declarations.
 */

/** Every event type the app understands, keyed by type. */
export const EVENT_SCHEMAS: Record<EventType, EventSchema> = {
  "job.changed": {
    type: "job.changed",
    displayName: "Job Changed",
    payload: {
      previousJob: { type: "string", title: "Previous Job" },
      currentJob: { type: "string", title: "Current Job" },
      department: { type: "string", title: "Department" },
      station: { type: "string", title: "Station" },
      businessDate: { type: "string", title: "Business Date" },
      shift: { type: "string", title: "Shift" },
    },
  },
};

/** Every action the app understands, keyed by type. */
export const ACTION_SCHEMAS: Record<string, ActionSchema> = {
  sendAlert: {
    type: "sendAlert",
    displayName: "Send Alert",
    inputSchema: {
      required: ["text", "emails"],
      properties: {
        text: {
          type: "string",
          title: "Alert Text",
          description: "Message to log. Supports {{event.payload.*}} variables.",
        },
        emails: {
          type: "array",
          items: { type: "string" },
          title: "Recipient Emails",
          description: "One email per row. Supports variables.",
        },
      },
    },
  },
  // Later: "createForm", "sendEmail", … declared here, handlers registered in registry.ts.
};
