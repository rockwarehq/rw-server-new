import { Engine } from "json-rules-engine";
import { type ActionRegistry, missingRequired } from "./actions.js";
import type { ContextBuilder } from "./context.js";
import { interpolateInputs } from "./interpolate.js";
import { qbToEngineConditions } from "./qb-to-engine.js";
import type { TriggerStore } from "./store.js";
import type { AppEvent, EventType, Trigger } from "./types.js";

export interface EngineDeps {
  store: TriggerStore;
  /** Per-event-type fact builders. Must cover every event type the framework will see. */
  contextBuilders: Record<EventType, ContextBuilder>;
  actions: ActionRegistry;
}

/**
 * Evaluates triggers and runs their actions. The evaluation core (json-rules-engine + condition
 * translation) is shared by every event type; the engine is pluggable in two places:
 *   - SEAM A: how an event becomes facts        -> ContextBuilder (per event type)
 *   - SEAM C: what a matched trigger's action does -> ActionRegistry
 *
 * Conditions are indexed per event type, so a trigger only runs against events of its own type.
 */
export interface TriggerEngine {
  /** Rebuild the per-event-type rule engines from the current enabled triggers. */
  reload(): void;
  /** Run all conditions for this event's type; fire the action of each matching trigger. */
  dispatch(event: AppEvent): Promise<string[]>;
}

export function createTriggerEngine(deps: EngineDeps): TriggerEngine {
  // Compiled engines, one per event type. Rebuilt by reload().
  let engines = new Map<EventType, Engine>();

  /**
   * Run every action on the trigger, in order. Throws on a missing handler or missing required
   * input — these are misconfigurations and abort the dispatch loop loudly. Actions that ran
   * before a throw have already produced their side effects; subsequent actions don't run.
   */
  async function runActions(trigger: Trigger, event: AppEvent): Promise<void> {
    for (const [idx, action] of trigger.actions.entries()) {
      const handler = deps.actions.get(action.type);
      if (!handler) {
        throw new Error(
          `trigger "${trigger.label}" (${trigger.id}) action #${idx} ("${action.type}"): no handler registered`,
        );
      }

      const inputs = interpolateInputs(action.inputs as Record<string, unknown>, { event });
      const missing = missingRequired(inputs, handler.inputSchema);
      if (missing) {
        throw new Error(
          `trigger "${trigger.label}" (${trigger.id}) action #${idx} ("${action.type}"): missing required input "${missing}"`,
        );
      }

      await handler.run(inputs, { trigger, eventId: event.id });
    }
  }

  return {
    reload(): void {
      const byType = new Map<EventType, Trigger[]>();
      for (const t of deps.store.list()) {
        if (!t.enabled) continue;
        const list = byType.get(t.event) ?? [];
        list.push(t);
        byType.set(t.event, list);
      }

      engines = new Map();
      for (const [type, triggers] of byType) {
        engines.set(type, buildEngine(triggers));
      }
    },

    async dispatch(event: AppEvent): Promise<string[]> {
      const engine = engines.get(event.type);
      if (!engine) return [];

      const builder = deps.contextBuilders[event.type];
      if (!builder) throw new Error(`no context builder registered for event type "${event.type}"`);
      const facts = await builder.build(event);
      const { results } = await engine.run(facts);

      const matched: string[] = [];
      for (const r of results) {
        const triggerId = r.event?.type;
        const trigger = triggerId ? deps.store.get(triggerId) : undefined;
        if (!trigger) continue;
        matched.push(trigger.id);
        await runActions(trigger, event);
      }
      return matched;
    },
  };
}

/** Build a json-rules-engine instance for one event type's triggers. */
function buildEngine(triggers: Trigger[]): Engine {
  const engine = new Engine([], { allowUndefinedFacts: true });

  // String operators that the query builder exposes but json-rules-engine lacks.
  engine.addOperator(
    "stringContains",
    (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.includes(b),
  );
  engine.addOperator(
    "stringStartsWith",
    (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.startsWith(b),
  );
  engine.addOperator(
    "stringEndsWith",
    (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.endsWith(b),
  );
  // NOTE: transition operators for telemetry (increments_up, changes_to, …) would be registered
  // here too, comparing current vs previous values placed in the fact map by a ContextBuilder.

  for (const t of triggers) {
    engine.addRule({
      conditions: qbToEngineConditions(t.conditions) as never,
      event: { type: t.id },
      priority: 10,
    });
  }
  return engine;
}
