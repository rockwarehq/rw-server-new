import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Trigger, TriggerStore } from "@rw/triggers";
import { nanoid } from "nanoid";

const seedTrigger: Trigger = {
  id: "trg_seed",
  label: "Alert on job change at S-1",
  enabled: true,
  event: "job.changed",
  conditions: {
    combinator: "and",
    rules: [{ field: "event.payload.station", operator: "=", value: "S-1" }],
  },
  // Two actions; both fire (in order) whenever the conditions match.
  actions: [
    {
      type: "sendAlert",
      inputs: {
        text: "Job changed from {{event.payload.previousJob}} to {{event.payload.currentJob}} at {{event.payload.station}}",
        emails: ["supervisor@example.com"],
      },
    },
    {
      type: "sendAlert",
      inputs: {
        text: "FYI: shift lead notified of change at {{event.payload.station}}",
        emails: ["shift-lead@example.com"],
      },
    },
  ],
};

/** Pre-multi-action triggers stored `action: TriggerAction`; promote to `actions: TriggerAction[]`. */
function migrateLegacy(raw: Record<string, unknown>): Trigger {
  if (Array.isArray(raw.actions)) return raw as unknown as Trigger;
  if (raw.action) {
    const { action, ...rest } = raw;
    return { ...rest, actions: [action] } as unknown as Trigger;
  }
  return { ...raw, actions: [] } as unknown as Trigger;
}

/**
 * MOCK, file-backed implementation of @rw/triggers' `TriggerStore`. Persists triggers to a JSON
 * file so they survive restarts in development. Stand-in for a real database — swap it for a
 * @rw/db-backed implementation later; nothing else in the app changes.
 *
 * Remember the store only persists *definitions*: after any upsert/remove the caller must call
 * `engine.reload()` (see the `TriggerStore` doc in @rw/triggers). The oRPC handlers do this today.
 *
 * File location: the `filePath` arg, else $TRIGGERS_MOCK_FILE, else ./.triggers-mock.json (cwd).
 */
export function createFileTriggerStore(filePath?: string): TriggerStore {
  const path = resolve(filePath ?? process.env.TRIGGERS_MOCK_FILE ?? ".triggers-mock.json");
  const triggers = new Map<string, Trigger>();

  load();

  function load(): void {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
        for (const item of raw) {
          const t = migrateLegacy(item);
          triggers.set(t.id, t);
        }
        return;
      } catch {
        // Corrupt/unreadable file — fall through and reseed.
      }
    }
    triggers.set(seedTrigger.id, seedTrigger);
    save();
  }

  function save(): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...triggers.values()], null, 2));
  }

  return {
    list: () => [...triggers.values()],
    get: (id) => triggers.get(id),
    upsert: (t) => {
      triggers.set(t.id, t);
      save();
      return t;
    },
    remove: (id) => {
      const ok = triggers.delete(id);
      if (ok) save();
      return ok;
    },
    newId: () => `trg_${nanoid(8)}`,
  };
}
