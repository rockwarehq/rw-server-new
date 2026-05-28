import { ORPCError } from "@orpc/server";
import type { TriggerAction } from "@rw/triggers";
import * as z from "zod";
import { getTriggerFramework } from "../triggers/index.js";
import { publicProcedure } from "./middleware.js";

// NOTE: uses `publicProcedure` (no auth) because the framework is backed by a MOCK store today.
// When the store moves to @rw/db (workspace-scoped), switch these to `authRequired` and thread the
// workspace context, mirroring the other routers (e.g. metric-catalog.ts).

const conditionsSchema = z.object({
  combinator: z.string(),
  rules: z.array(z.any()),
  not: z.boolean().optional(),
});

const actionSchema = z.object({
  type: z.string(),
  inputs: z.record(z.string(), z.unknown()),
});

/** A trigger has one or more actions, run sequentially when conditions match. */
const actionsSchema = z.array(actionSchema).min(1);

/** Validate every action's inputs and return the normalized `TriggerAction[]`. Throws on the first bad one. */
function validateActions(
  fw: ReturnType<typeof getTriggerFramework>,
  actions: z.infer<typeof actionsSchema>,
): TriggerAction[] {
  return actions.map((a, idx) => {
    try {
      return { type: a.type, inputs: fw.validateActionInputs(a.type, a.inputs) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ORPCError("BAD_REQUEST", { message: `actions[${idx}].inputs invalid — ${msg}` });
    }
  });
}

/** Catalog (event + action schemas, facts, variables) — drives a UI editor. Both types must be picked by the client. */
export const getCatalog = publicProcedure
  .input(z.object({ eventType: z.string().min(1), actionType: z.string().min(1) }))
  .handler(async ({ input }) => getTriggerFramework().catalog(input.eventType, input.actionType));

export const listTriggers = publicProcedure.handler(async () => getTriggerFramework().store.list());

export const createTrigger = publicProcedure
  .input(
    z.object({
      label: z.string().min(1),
      enabled: z.boolean().optional(),
      conditions: conditionsSchema,
      actions: actionsSchema,
    }),
  )
  .handler(async ({ input }) => {
    const fw = getTriggerFramework();
    const actions = validateActions(fw, input.actions);

    const trigger = fw.store.upsert({
      id: fw.store.newId(),
      label: input.label,
      enabled: input.enabled ?? true,
      event: "job.changed",
      conditions: input.conditions,
      actions,
    });
    fw.engine.reload();
    return trigger;
  });

export const updateTrigger = publicProcedure
  .input(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      enabled: z.boolean().optional(),
      conditions: conditionsSchema.optional(),
      actions: actionsSchema.optional(),
    }),
  )
  .handler(async ({ input }) => {
    const fw = getTriggerFramework();
    const existing = fw.store.get(input.id);
    if (!existing) throw new ORPCError("NOT_FOUND", { message: "trigger not found" });

    const actions = input.actions ? validateActions(fw, input.actions) : existing.actions;

    const updated = fw.store.upsert({
      ...existing,
      label: input.label ?? existing.label,
      enabled: input.enabled ?? existing.enabled,
      conditions: input.conditions ?? existing.conditions,
      actions,
    });
    fw.engine.reload();
    return updated;
  });

export const deleteTrigger = publicProcedure.input(z.object({ id: z.string() })).handler(async ({ input }) => {
  const fw = getTriggerFramework();
  if (!fw.store.remove(input.id)) throw new ORPCError("NOT_FOUND", { message: "trigger not found" });
  fw.engine.reload();
  return { ok: true };
});
