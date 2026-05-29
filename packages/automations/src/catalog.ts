import { QB_OPERATORS } from "./qb-to-engine.js";
import type {
  ActionSchema,
  Catalog,
  EventSchema,
  EventSchemaVersion,
  EventType,
  FactDef,
  TemplateVariable,
} from "./types.js";

/**
 * Builds the editor catalog (fields, template variables, operators) that a UI renders from. Pure
 * function over the schemas it's handed — the consuming app owns the concrete `EVENT_SCHEMAS` /
 * `ACTION_SCHEMAS` and their defaults.
 *
 * Version-aware: both the event and the action are looked up by `(type, version)`. Caller may pass
 * `undefined` for either version to mean "use the schema's `latest`" — useful for authoring new
 * automations, where the editor doesn't know which version to pick yet.
 */

/**
 * Condition-builder fields for one event payload shape: `event.type` + each payload field. A field
 * declared with `ref: { source }` carries that annotation through to the FactDef so the editor can
 * render a picker (same registry as action-input refs).
 */
function factsFor(payload: EventSchemaVersion["payload"]): FactDef[] {
  return [
    { id: "event.type", label: "Event Type", type: "string" },
    // Display-only fields (`matchable: false`, e.g. names) are usable as template variables but not
    // offered for matching — match on the stable id, not a mutable name.
    ...Object.entries(payload)
      .filter(([, prop]) => prop.matchable !== false)
      .map(([key, prop]): FactDef => {
        const fact: FactDef = {
          id: `event.payload.${key}`,
          label: prop.title,
          type: "string",
        };
        if (prop.ref) fact.ref = prop.ref;
        return fact;
      }),
  ];
}

/** Template variables insertable into action inputs: payload fields (for the selected version) + event/system tokens. */
function variablesFor(schema: EventSchema, payload: EventSchemaVersion["payload"]): TemplateVariable[] {
  return [
    ...Object.entries(payload).map(
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

/**
 * Build the editor catalog for one (event type, event version) + (action type, action version),
 * from the given schema sets. `eventVersion` / `actionVersion` may be omitted to use each schema's
 * `latest`.
 */
export function buildCatalog(
  eventSchemas: Record<EventType, EventSchema>,
  actionSchemas: Record<string, ActionSchema>,
  eventType: EventType,
  actionType: string,
  eventVersion?: string,
  actionVersion?: string,
): Catalog {
  const event = eventSchemas[eventType];
  const action = actionSchemas[actionType];
  if (!event) throw new Error(`unknown event type: ${eventType}`);
  if (!action) throw new Error(`unknown action type: ${actionType}`);

  const evVersion = eventVersion ?? event.latest;
  const acVersion = actionVersion ?? action.latest;

  const evPayload = event.versions[evVersion];
  if (!evPayload) {
    const known = Object.keys(event.versions).join(", ");
    throw new Error(`unknown event version: ${eventType}@${evVersion} (known: ${known})`);
  }
  if (!action.versions[acVersion]) {
    const known = Object.keys(action.versions).join(", ");
    throw new Error(`unknown action version: ${actionType}@${acVersion} (known: ${known})`);
  }

  return {
    event,
    eventVersion: evVersion,
    action,
    actionVersion: acVersion,
    actions: Object.values(actionSchemas),
    facts: factsFor(evPayload.payload),
    variables: variablesFor(event, evPayload.payload),
    operators: QB_OPERATORS,
  };
}
