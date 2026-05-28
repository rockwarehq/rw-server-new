import type { RunRecorder } from "@rw/automations";
import prisma from "@rw/db";

/**
 * Prisma-backed implementation of @rw/automations' `RunRecorder`. Writes audit rows for every
 * `fire()` call:
 *   - `startRun(event)` → `AutomationRun` row (status set later by `finishRun`).
 *   - `recordAction(...)` → one `AutomationActionRun` row per action attempt.
 *   - `finishRun(runId, ...)` → updates the run row with final status + finishedAt.
 *
 * Workspace-scoped: each invocation pins to a workspaceId; the framework wires one recorder per
 * workspace alongside the store + ref source.
 */
export function createDbRunRecorder(workspaceId: string): RunRecorder {
  return {
    async startRun({ event }) {
      const row = await prisma.automationRun.create({
        data: {
          workspaceId,
          eventType: event.type,
          eventVersion: event.version,
          eventId: event.id,
          // JSON column; Prisma stores the payload as-raised (after zod validation, pre-dispatch).
          payload: event.payload as unknown as Parameters<typeof prisma.automationRun.create>[0]["data"]["payload"],
          // status set on finishRun; the schema requires it, so we open with SUCCESS as a placeholder
          // — finishRun always overwrites it (even when SUCCESS, the matched + finishedAt are filled in).
          status: "SUCCESS",
          matched: [],
        },
      });
      return row.id;
    },

    async recordAction(input) {
      await prisma.automationActionRun.create({
        data: {
          runId: input.runId,
          automationId: input.automationId,
          actionIdx: input.actionIdx,
          actionType: input.actionType,
          actionVersion: input.actionVersion,
          status: input.status,
          error: input.error,
          startedAt: new Date(input.startedAt),
          finishedAt: new Date(input.finishedAt),
        },
      });
    },

    async finishRun(runId, { matched, status, error }) {
      await prisma.automationRun.update({
        where: { id: runId },
        data: {
          matched,
          status,
          error,
          finishedAt: new Date(),
        },
      });
    },
  };
}
