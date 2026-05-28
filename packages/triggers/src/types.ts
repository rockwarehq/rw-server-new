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
  /** Schema version this payload was raised against (defaults to the event's `latest` at fire time). */
  version: string;
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
  /**
   * Marks this property as a reference to an external data source (users, channels, teams, …).
   * The stored value is the source's id (or `string[]` of ids when `multi: true`); the editor uses
   * `RefRegistry.list(source)` to populate a picker showing `label` and storing `id`. Resolution
   * back to the full object at action-run time is the handler's responsibility today — see
   * `RefSource` in @rw/triggers and the README's "Ref data sources" section.
   */
  ref?: RefAnnotation;
}

/** Describes a picker-style reference field; sits on a SchemaProperty. */
export interface RefAnnotation {
  /** Key registered in the RefRegistry (e.g. "users", "slackChannels"). */
  source: string;
  /** True for multi-select (`type: "array"`); false/omitted for single-select (`type: "string"`). */
  multi?: boolean;
}

/** JSON-schema-ish description of an action's inputs: required keys + their properties. */
export interface ActionInputSchema {
  required: string[];
  properties: Record<string, SchemaProperty>;
}

// =============================================================================
// VERSIONED SCHEMAS
// -----------------------------------------------------------------------------
// Each event type / action type carries a `latest` pointer and a `versions` map.
// Stored triggers pin the exact version they were authored against:
//   - `Trigger.eventVersion` + `TriggerAction.version` are the pins.
//   - `AppEvent.version` is set at raise time (defaults to the event's `latest`).
// Authoring a NEW trigger uses `latest` for both. Dispatch resolution: STRICT for
// action handler lookup (must match a registered version), LENIENT for event
// version (conditions evaluate against the actual raised payload regardless of
// the trigger's pinned event version — silent mismatches surface in run history).
// =============================================================================

/** One version's payload shape for an event type. */
export interface EventSchemaVersion {
  payload: Record<string, SchemaProperty>;
}

/** Declares an event type and the shape of its payload across versions. */
export interface EventSchema {
  type: EventType;
  displayName: string;
  /** Version key the editor / `fire()` use when the caller doesn't pick one. Must be a key in `versions`. */
  latest: string;
  /** All known versions of this event's payload shape, keyed by version. */
  versions: Record<string, EventSchemaVersion>;
}

/** One version's input shape for an action type. */
export interface ActionSchemaVersion {
  inputSchema: ActionInputSchema;
}

/** Declares an action type and the shape of its inputs across versions. */
export interface ActionSchema {
  type: string;
  displayName: string;
  /** Version key the editor uses when authoring a new trigger. Must be a key in `versions`. */
  latest: string;
  /** All known versions of this action's input shape, keyed by version. */
  versions: Record<string, ActionSchemaVersion>;
}

/** A template variable users can insert into action inputs. */
export interface TemplateVariable {
  key: string; // e.g. "event.payload.currentJob"
  label: string;
  example: string;
}

/**
 * A trigger's action: a registered action `type` + version pin + its inputs. Inputs are an
 * open record so any action's shape can be carried without a per-action type — validation is
 * derived from the version-specific inputSchema (see schema-to-zod.ts).
 */
export interface TriggerAction {
  type: string;
  /** Action schema version this input was authored against; strict-resolved to a handler at dispatch. */
  version: string;
  inputs: Record<string, unknown>;
}

/**
 * A trigger: tied to a single event (pinned to a version), a condition predicate, and one or
 * more actions (each pinned to its own version). Actions run sequentially when conditions match;
 * if action N throws, actions N+1… don't run for that event (the throw aborts the dispatch loop
 * for the trigger).
 */
export interface Trigger {
  id: string;
  label: string;
  enabled: boolean;
  event: EventType;
  /** Event schema version this trigger was authored against. Informational at dispatch; used for editor + audit. */
  eventVersion: string;
  conditions: RuleGroupType;
  actions: TriggerAction[];
}

/**
 * Everything the editor UI needs to render itself for a specific (event version, action version)
 * pair, served over the API. Facts + variables reflect the chosen event version's payload.
 */
export interface Catalog {
  event: EventSchema;
  /** The selected version of the event (must be a key in `event.versions`). */
  eventVersion: string;
  /** The default action (convenience). */
  action: ActionSchema;
  /** The selected version of the action (must be a key in `action.versions`). */
  actionVersion: string;
  /** Every action the editor can offer — the form renders from the selected one. */
  actions: ActionSchema[];
  facts: FactDef[];
  variables: TemplateVariable[];
  operators: string[];
}
