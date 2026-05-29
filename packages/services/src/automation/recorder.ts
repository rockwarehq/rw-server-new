import type { RunRecorder } from "@rw/automations";
import prisma from "@rw/db";

/**
 * Prisma-backed implementation of @rw/automations' `RunRecorder`. Writes audit rows for every
 * `fire()` call:
 *   - `startRun(event)` → `AutomationRun` row (status set later by `finishRun`).
 *   - `recordAction(...)` → one `AutomationActionRun` row per action attempt.
 *   - `finishRun(runId, ...)` → updates the run row with final status + finishedAt AND fans
 *     `matched` out into one `AutomationRunMatch` row per matched automation. Both writes happen
 *     in a single transaction so we don't end up with the run finalized but missing matches (or
 *     vice versa) on a partial failure.
 */
export function createDbRunRecorder(): RunRecorder {
  return {
    async startRun({ event }) {
      const row = await prisma.automationRun.create({
        data: {
          eventType: event.type,
          eventVersion: event.version,
          // AppEvent.id is a UUID v4 generated inside fire(); column is `@db.Uuid`.
          eventId: event.id,
          // JSON column; Prisma stores the payload as-raised (after zod validation, pre-dispatch).
          payload: event.payload as unknown as Parameters<typeof prisma.automationRun.create>[0]["data"]["payload"],
          // status set on finishRun; the schema requires it, so we open with SUCCESS as a placeholder
          // — finishRun always overwrites it with the actual outcome.
          status: "SUCCESS",
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
      // Atomic: update the run row's terminal state AND write one match row per matched automation.
      // Order preserved via matchIdx so consumers can reconstruct dispatch order.
      await prisma.$transaction([
        ...matched.map((automationId, matchIdx) =>
          prisma.automationRunMatch.create({
            data: { runId, automationId, matchIdx },
          }),
        ),
        prisma.automationRun.update({
          where: { id: runId },
          data: { status, error, finishedAt: new Date() },
        }),
      ]);
    },
  };
}
