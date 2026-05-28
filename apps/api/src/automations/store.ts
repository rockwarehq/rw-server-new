import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Automation, AutomationStore } from "@rw/automations";
import { nanoid } from "nanoid";

/** Synthetic workspace id used by the file-backed mock store (no auth in dev). */
const DEV_WORKSPACE_ID = "dev";

const seedAutomation: Automation = {
  id: "atm_seed",
  workspaceId: DEV_WORKSPACE_ID,
  label: "Alert on job change at S-1",
  enabled: true,
  event: "job.changed",
  eventVersion: "1",
  conditions: {
    combinator: "and",
    rules: [{ field: "event.payload.station", operator: "=", value: "S-1" }],
  },
  // Two actions; both fire (in order) whenever the conditions match. Recipients are stored as
  // user ids — the editor picker resolves them to names + emails via `RefRegistry.list("users")`,
  // and the handler resolves them back to emails at run time (see actions/send-alert.ts / refs.ts).
  // Each action pins to a specific version of its handler; dispatch is strict on (type, version).
  actions: [
    {
      type: "sendAlert",
      version: "1",
      inputs: {
        text: "Job changed from {{event.payload.previousJob}} to {{event.payload.currentJob}} at {{event.payload.station}}",
        recipientUserIds: ["u_supervisor"],
      },
    },
    {
      type: "sendAlert",
      version: "1",
      inputs: {
        text: "FYI: shift lead notified of change at {{event.payload.station}}",
        recipientUserIds: ["u_shift_lead"],
      },
    },
  ],
};

/**
 * Backfill missing fields when loading older mock files.
 *   - Pre-multi-action: `action: AutomationAction` → `actions: AutomationAction[]`
 *   - Pre-versioning: missing `eventVersion` defaults to "1"; each action missing `version`
 *     defaults to "1". (Safe baseline — every existing schema launched at v1.)
 */
function migrateLegacy(raw: Record<string, unknown>): Automation {
  const stage1 = Array.isArray(raw.actions)
    ? raw
    : raw.action
      ? { ...raw, actions: [raw.action] }
      : { ...raw, actions: [] };

  const actions = (stage1.actions as Array<Record<string, unknown>>).map((a) => ({
    ...a,
    version: typeof a.version === "string" ? a.version : "1",
  }));

  return {
    ...stage1,
    workspaceId: typeof stage1.workspaceId === "string" ? stage1.workspaceId : DEV_WORKSPACE_ID,
    eventVersion: typeof stage1.eventVersion === "string" ? stage1.eventVersion : "1",
    actions,
  } as unknown as Automation;
}

/**
 * MOCK, file-backed implementation of @rw/automations' `AutomationStore`. Persists automations to a JSON
 * file so they survive restarts in development. Stand-in for a real database — swap it for a
 * @rw/db-backed implementation later; nothing else in the app changes.
 *
 * Remember the store only persists *definitions*: after any upsert/remove the caller must call
 * `engine.reload()` (see the `AutomationStore` doc in @rw/automations). The oRPC handlers do this today.
 *
 * File location: the `filePath` arg, else $AUTOMATIONS_MOCK_FILE, else ./.automations-mock.json (cwd).
 */
export function createFileAutomationStore(filePath?: string): AutomationStore {
  const path = resolve(filePath ?? process.env.AUTOMATIONS_MOCK_FILE ?? ".automations-mock.json");
  const automations = new Map<string, Automation>();

  load();

  function load(): void {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
        for (const item of raw) {
          const t = migrateLegacy(item);
          automations.set(t.id, t);
        }
        return;
      } catch {
        // Corrupt/unreadable file — fall through and reseed.
      }
    }
    automations.set(seedAutomation.id, seedAutomation);
    save();
  }

  function save(): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...automations.values()], null, 2));
  }

  return {
    list: () => [...automations.values()],
    get: (id) => automations.get(id),
    // Writes are sync internally (file I/O); the AutomationStore interface declares them async so
    // the same shape covers Prisma-backed implementations. Wrapping in async is essentially free.
    upsert: async (t) => {
      automations.set(t.id, t);
      save();
      return t;
    },
    remove: async (id) => {
      const ok = automations.delete(id);
      if (ok) save();
      return ok;
    },
    newId: () => `atm_${nanoid(8)}`,
  };
}
