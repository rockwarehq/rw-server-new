import type { Automation, AutomationAction, AutomationStore, RuleGroupType } from "@rw/automations";
import prisma from "@rw/db";
import { nanoid } from "nanoid";

/**
 * Prisma-backed implementation of @rw/automations' `AutomationStore`.
 *
 * Initial load fills an in-memory `Map` so `list()` / `get()` stay synchronous (the engine's hot
 * path expects sync reads). Writes go to Postgres AND update the cache in lockstep.
 *
 * Workspace-scoped: each call to `createDbAutomationStore(workspaceId)` returns a store that only
 * sees rows in that workspace. The app keeps one store per workspace; see
 * apps/api/src/automations/index.ts for the workspace-scoped framework cache.
 *
 * MULTI-INSTANCE CAVEAT: another instance writing to the same workspace won't refresh THIS
 * instance's cache. Plan documented in @rw/automations' `store.ts` — Redis pub/sub on the
 * automation id to broadcast reloads. Single-instance is fine for now.
 */
export async function createDbAutomationStore(workspaceId: string): Promise<AutomationStore> {
  // Initial load. The engine wants a sync list, so we hydrate once at construction.
  const rows = await prisma.automation.findMany({ where: { workspaceId } });
  const cache = new Map<string, Automation>(rows.map((r) => [r.id, rowToAutomation(r)]));

  return {
    list: () => [...cache.values()],
    get: (id) => cache.get(id),

    async upsert(automation) {
      if (automation.workspaceId !== workspaceId) {
        throw new Error(
          `automation.workspaceId mismatch: store is scoped to "${workspaceId}", got "${automation.workspaceId}"`,
        );
      }
      const row = await prisma.automation.upsert({
        where: { id: automation.id },
        create: {
          id: automation.id,
          workspaceId,
          label: automation.label,
          enabled: automation.enabled,
          event: automation.event,
          eventVersion: automation.eventVersion,
          // JSON columns; Prisma serializes structured values directly.
          conditions: automation.conditions as unknown as Parameters<
            typeof prisma.automation.upsert
          >[0]["create"]["conditions"],
          actions: automation.actions as unknown as Parameters<typeof prisma.automation.upsert>[0]["create"]["actions"],
        },
        update: {
          label: automation.label,
          enabled: automation.enabled,
          event: automation.event,
          eventVersion: automation.eventVersion,
          conditions: automation.conditions as unknown as Parameters<
            typeof prisma.automation.upsert
          >[0]["update"]["conditions"],
          actions: automation.actions as unknown as Parameters<typeof prisma.automation.upsert>[0]["update"]["actions"],
        },
      });
      const out = rowToAutomation(row);
      cache.set(out.id, out);
      return out;
    },

    async remove(id) {
      // The cache + DB are kept consistent: if the DB delete fails (no row), the cache miss tells
      // the caller the same thing it'd see if it had just done a get() first.
      if (!cache.has(id)) return false;
      try {
        await prisma.automation.delete({ where: { id, workspaceId } });
      } catch {
        // Row was already gone (race) — proceed to clear cache below.
      }
      cache.delete(id);
      return true;
    },

    newId: () => `atm_${nanoid(8)}`,
  };
}

/** Turn a Prisma row into the in-memory `Automation` the engine expects. */
function rowToAutomation(row: {
  id: string;
  workspaceId: string;
  label: string;
  enabled: boolean;
  event: string;
  eventVersion: string;
  conditions: unknown;
  actions: unknown;
}): Automation {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    label: row.label,
    enabled: row.enabled,
    event: row.event,
    eventVersion: row.eventVersion,
    conditions: row.conditions as RuleGroupType,
    actions: row.actions as AutomationAction[],
  };
}
