import { createTriggerFramework, type TriggerFramework, type TriggerStore } from "@rw/triggers";
import { ACTION_SCHEMAS, EVENT_SCHEMAS } from "./catalog.js";
import { buildActionRegistry, buildContextBuilders } from "./registry.js";
import { createFileTriggerStore } from "./store.js";

export interface CreateAppTriggerFrameworkOptions {
  store?: TriggerStore;
}

export function createAppTriggerFramework(opts: CreateAppTriggerFrameworkOptions = {}): TriggerFramework {
  return createTriggerFramework({
    eventSchemas: EVENT_SCHEMAS,
    actionSchemas: ACTION_SCHEMAS,
    store: opts.store ?? createFileTriggerStore(),
    contextBuilders: buildContextBuilders(),
    actions: buildActionRegistry(),
  });
}

let singleton: TriggerFramework | undefined;

/** Lazily-created shared framework instance (mock store). Used by the oRPC layer. */
export function getTriggerFramework(): TriggerFramework {
  if (!singleton) singleton = createAppTriggerFramework();
  return singleton;
}

export type {
  AppEvent,
  Catalog,
  EventType,
  Trigger,
  TriggerAction,
  TriggerFramework,
  TriggerStore,
} from "@rw/triggers";
