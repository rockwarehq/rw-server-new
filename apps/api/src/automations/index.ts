import {
  type AutomationFramework,
  type AutomationStore,
  createAutomationFramework,
  createRefRegistry,
} from "@rw/automations";
import { createDbAutomationStore } from "@rw/services/automation/store";
import { createDbRunRecorder } from "@rw/services/automation/recorder";
import { createDbUsersRefSource } from "@rw/services/automation/users-ref-source";
import { ACTION_SCHEMAS, buildActionRegistry } from "./actions/index.js";
import { buildContextBuilders, EVENT_SCHEMAS } from "./events/index.js";
import { usersRefSource as fileUsersRefSource } from "./refs.js";
import { createFileAutomationStore } from "./store.js";

export interface CreateAppAutomationFrameworkOptions {
  /** Pass a store explicitly to bypass the DB (the file-backed mock used by e2e does this). */
  store?: AutomationStore;
  /** Workspace this framework operates against. Required when omitting `store` (DB-backed mode). */
  workspaceId?: string;
}

/**
 * Build an automation framework wired with this app's events + actions + refs.
 *
 *   - DB-backed (default): pass `workspaceId`. Wires `createDbAutomationStore`, the audit recorder
 *     (writes AutomationRun + AutomationActionRun rows on every fire), and the DB-backed users ref
 *     source (picker lists workspace members).
 *   - File-mock: pass `store` (typically `createFileAutomationStore(path)`). Uses the in-memory
 *     users fixture from `./refs.js` and no audit recorder. The e2e test uses this branch.
 */
export async function createAppAutomationFramework(
  opts: CreateAppAutomationFrameworkOptions = {},
): Promise<AutomationFramework> {
  let store: AutomationStore;
  let refs: ReturnType<typeof createRefRegistry>;
  let recorder: Parameters<typeof createAutomationFramework>[0]["recorder"];

  if (opts.store) {
    // File-mock path: caller supplied the store; users come from the in-memory fixture; no audit.
    store = opts.store;
    refs = createRefRegistry().register(fileUsersRefSource);
    recorder = undefined;
  } else {
    if (!opts.workspaceId) {
      throw new Error(
        "createAppAutomationFramework: `workspaceId` is required when no `store` is provided (DB-backed mode)",
      );
    }
    const workspaceId = opts.workspaceId;
    store = await createDbAutomationStore(workspaceId);
    refs = createRefRegistry().register(createDbUsersRefSource(workspaceId));
    recorder = createDbRunRecorder(workspaceId);
  }

  return createAutomationFramework({
    eventSchemas: EVENT_SCHEMAS,
    actionSchemas: ACTION_SCHEMAS,
    store,
    contextBuilders: buildContextBuilders(),
    actions: buildActionRegistry(),
    refs,
    recorder,
  });
}

// Per-workspace framework cache. Concurrent first calls share one creation promise so the initial
// Prisma load runs at most once per workspace, even under burst traffic at boot.
const cache = new Map<string, AutomationFramework>();
const pending = new Map<string, Promise<AutomationFramework>>();

/**
 * Resolve the shared `AutomationFramework` for a workspace. First call builds + caches; subsequent
 * calls return the same instance. The oRPC layer calls this with `context.iam.workspaceId`.
 */
export async function getAutomationFramework(workspaceId: string): Promise<AutomationFramework> {
  const cached = cache.get(workspaceId);
  if (cached) return cached;
  const inflight = pending.get(workspaceId);
  if (inflight) return inflight;

  const promise = (async () => {
    const fw = await createAppAutomationFramework({ workspaceId });
    cache.set(workspaceId, fw);
    pending.delete(workspaceId);
    return fw;
  })();
  pending.set(workspaceId, promise);
  return promise;
}

export { createFileAutomationStore };

export type {
  AppEvent,
  Automation,
  AutomationAction,
  AutomationFramework,
  AutomationStore,
  Catalog,
  EventType,
} from "@rw/automations";
