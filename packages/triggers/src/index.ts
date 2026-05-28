// @rw/triggers — a domain-agnostic event → condition → action engine.
//
// The consuming app supplies its domain (event/action schemas, fact builders, action handlers, and
// a store) and calls `createTriggerFramework(config)`. Everything below the seams — condition
// evaluation, ingestion, validation, interpolation — is fixed and reusable.

export {
  type ActionContext,
  type ActionHandler,
  type ActionRegistry,
  type ActionVersion,
  createActionRegistry,
  missingRequired,
} from "./actions.js";
export { buildCatalog } from "./catalog.js";
export { type ContextBuilder, statelessContextBuilder } from "./context.js";
export { createTriggerEngine, type EngineDeps, type TriggerEngine } from "./engine.js";
export {
  createTriggerFramework,
  type FireOptions,
  type TriggerFramework,
  type TriggerFrameworkConfig,
} from "./framework.js";
export { createSyncIngestRuntime, type IngestRuntime } from "./ingest.js";
export { interpolateInputs, type VariableContext } from "./interpolate.js";
export { type EngineCondition, OPERATOR_MAP, QB_OPERATORS, qbToEngineConditions } from "./qb-to-engine.js";
export type { RuleGroupType, RuleType } from "./query-builder-types.js";
export {
  createRefRegistry,
  type RefContext,
  type RefOption,
  type RefRegistry,
  type RefSource,
} from "./refs.js";
export { actionInputsToZod, formatZodError, payloadToZod } from "./schema-to-zod.js";
export type { TriggerStore } from "./store.js";
export type {
  ActionInputSchema,
  ActionSchema,
  ActionSchemaVersion,
  AppEvent,
  Catalog,
  EventSchema,
  EventSchemaVersion,
  EventType,
  FactDef,
  FactMap,
  RefAnnotation,
  SchemaProperty,
  TemplateVariable,
  Trigger,
  TriggerAction,
} from "./types.js";
export { createValidators, type Validators } from "./validate.js";
