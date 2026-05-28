import { QB_OPERATORS } from "./qb-to-engine.js";
import type { ActionSchema, Catalog, EventSchema, EventType, FactDef, TemplateVariable } from "./types.js";

/**
 * Builds the editor catalog (fields, template variables, operators) that a UI renders from. Pure
 * function over the schemas it's handed — the consuming app owns the concrete `EVENT_SCHEMAS` /
 * `ACTION_SCHEMAS` and their defaults.
 */

/** Condition-builder fields for one event type: event.type + each payload field. */
function factsFor(schema: EventSchema): FactDef[] {
  return [
    { id: "event.type", label: "Event Type", type: "string" },
    ...Object.entries(schema.payload).map(
      ([key, prop]): FactDef => ({
        id: `event.payload.${key}`,
        label: prop.title,
        type: "string",
      }),
    ),
  ];
}

/** Template variables insertable into action inputs: payload fields + event/system tokens. */
function variablesFor(schema: EventSchema): TemplateVariable[] {
  return [
    ...Object.entries(schema.payload).map(
      ([key, prop]): TemplateVariable => ({
        key: `event.payload.${key}`,
        label: prop.title,
        example: "",
      }),
    ),
    { key: "event.type", label: "Event Type", example: schema.type },
    { key: "event.id", label: "Event ID", example: "ab12cd34" },
    { key: "event.ts", label: "Event Timestamp", example: new Date().toISOString() },
    { key: "sys.timestamp", label: "Now (ISO)", example: new Date().toISOString() },
  ];
}

/** Build the editor catalog for one event type + one action, from the given schema sets. */
export function buildCatalog(
  eventSchemas: Record<EventType, EventSchema>,
  actionSchemas: Record<string, ActionSchema>,
  eventType: EventType,
  actionType: string,
): Catalog {
  const event = eventSchemas[eventType];
  const action = actionSchemas[actionType];
  if (!event) throw new Error(`unknown event type: ${eventType}`);
  if (!action) throw new Error(`unknown action type: ${actionType}`);
  return {
    event,
    action,
    actions: Object.values(actionSchemas),
    facts: factsFor(event),
    variables: variablesFor(event),
    operators: QB_OPERATORS,
  };
}
