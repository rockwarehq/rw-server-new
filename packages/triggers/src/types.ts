// =============================================================================
// TRIGGER FRAMEWORK — CONTRACT TYPES
// -----------------------------------------------------------------------------
// Ported from the eventdrivenarch-simple reference. Pure contract/domain types
// shared between the framework, its API surface, and (eventually) a UI. Schema
// *data* is served at runtime via the catalog; these types describe the shapes.
// =============================================================================

import type { RuleGroupType } from "./query-builder-types.js";

/**
 * Identifies an event type. A plain string (not a literal union) so new event
 * types can be registered in the catalog without editing this type.
 */
export type EventType = string;

/** A runtime event flowing into the engine. */
export interface AppEvent {
  id: string;
  type: EventType;
  ts: string;
  payload: Record<string, unknown>;
}

/** The flat fact map an event is evaluated against. Produced by a ContextBuilder. */
export type FactMap = Record<string, unknown>;

/** A field offered in the condition builder. */
export interface FactDef {
  id: string; // e.g. "event.payload.station"
  label: string;
  type: "string" | "number" | "boolean";
  enumValues?: string[];
}

/** A JSON-schema-ish property used by the event + action schemas. */
export interface SchemaProperty {
  type: "string" | "number" | "array";
  title: string;
  description?: string;
  enum?: string[];
  items?: { type: "string" };
}

/** JSON-schema-ish description of an action's inputs: required keys + their properties. */
export interface ActionInputSchema {
  required: string[];
  properties: Record<string, SchemaProperty>;
}

/** Declares an event type and the shape of its payload. */
export interface EventSchema {
  type: EventType;
  displayName: string;
  payload: Record<string, SchemaProperty>;
}

/** Declares an action type and the shape of its inputs. */
export interface ActionSchema {
  type: string;
  displayName: string;
  inputSchema: ActionInputSchema;
}

/** A template variable users can insert into action inputs. */
export interface TemplateVariable {
  key: string; // e.g. "event.payload.currentJob"
  label: string;
  example: string;
}

/**
 * A trigger's action: a registered action `type` plus its inputs. Inputs are an
 * open record so any action's shape can be carried without a per-action type —
 * validation is derived from the action's inputSchema (see schema-to-zod.ts).
 */
export interface TriggerAction {
  type: string;
  inputs: Record<string, unknown>;
}

/**
 * A trigger: tied to a single event, a condition predicate, and one or more actions.
 * Actions run sequentially when conditions match; if action N throws, actions N+1… don't run
 * for that event (the throw aborts the dispatch loop for the trigger).
 */
export interface Trigger {
  id: string;
  label: string;
  enabled: boolean;
  event: EventType;
  conditions: RuleGroupType;
  actions: TriggerAction[];
}

/** Everything the editor UI needs to render itself, served over the API. */
export interface Catalog {
  event: EventSchema;
  /** The default action (convenience). */
  action: ActionSchema;
  /** Every action the editor can offer — the form renders from the selected one. */
  actions: ActionSchema[];
  facts: FactDef[];
  variables: TemplateVariable[];
  operators: string[];
}
