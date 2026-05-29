import { type AutomationFramework, createAutomationFramework, createRefRegistry } from "@rw/automations";
import { createDbRunRecorder } from "@rw/services/automation/recorder";
import { createDbAutomationStore } from "@rw/services/automation/store";
import { stationsAutomationRef } from "@rw/services/facility/station/automation-ref";
import { workCentersAutomationRef } from "@rw/services/facility/workcenter/automation-ref";
import { jobsAutomationRef } from "@rw/services/job/automation-ref";
import { usersAutomationRef } from "@rw/services/user/automation-ref";
import { ACTION_SCHEMAS, buildActionRegistry } from "./actions/index.js";
import { buildContextBuilders, EVENT_SCHEMAS } from "./events/index.js";

/**
 * Build the DB-backed automation framework wired with this app's events + actions + refs.
 * Automations are global — there's no workspace scoping. Wires:
 *   - `createDbAutomationStore` — automation definitions in Postgres.
 *   - the audit recorder — writes `AutomationRun` + `AutomationActionRun` rows on every fire.
 *   - the DB-backed ref sources — pickers list every user / job / station / work center.
 */
export async function createAppAutomationFramework(): Promise<AutomationFramework> {
  const store = await createDbAutomationStore();
  const refs = createRefRegistry()
    .register(usersAutomationRef)
    .register(workCentersAutomationRef)
    .register(stationsAutomationRef)
    .register(jobsAutomationRef);

  return createAutomationFramework({
    eventSchemas: EVENT_SCHEMAS,
    actionSchemas: ACTION_SCHEMAS,
    store,
    contextBuilders: buildContextBuilders(),
    actions: buildActionRegistry(),
    refs,
    recorder: createDbRunRecorder(),
  });
}

// Single shared framework. Concurrent first calls share one creation promise so the initial Prisma
// load runs at most once, even under burst traffic at boot.
let cached: AutomationFramework | undefined;
let pending: Promise<AutomationFramework> | undefined;

/**
 * Resolve the shared `AutomationFramework`. First call builds + caches; subsequent calls return the
 * same instance.
 */
export async function getAutomationFramework(): Promise<AutomationFramework> {
  if (cached) return cached;
  if (pending) return pending;

  pending = (async () => {
    const fw = await createAppAutomationFramework();
    cached = fw;
    pending = undefined;
    return fw;
  })();
  return pending;
}

export type {
  AppEvent,
  Automation,
  AutomationAction,
  AutomationFramework,
  AutomationStore,
  Catalog,
  EventType,
} from "@rw/automations";
