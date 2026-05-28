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

// Per-action input: type + optional version (defaults to the action's `latest`) + inputs.
const actionSchema = z.object({
  type: z.string(),
  version: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.unknown()),
});

/** A trigger has one or more actions, run sequentially when conditions match. */
const actionsSchema = z.array(actionSchema).min(1);

/**
 * Validate every action's inputs (against the chosen version's inputSchema) and return the
 * normalized `TriggerAction[]`. If a client omits `version`, the action's `latest` is filled in.
 * Throws on the first bad action.
 */
function validateActions(
  fw: ReturnType<typeof getTriggerFramework>,
  actions: z.infer<typeof actionsSchema>,
): TriggerAction[] {
  return actions.map((a, idx) => {
    const schema = fw.actionSchemas[a.type];
    if (!schema) {
      throw new ORPCError("BAD_REQUEST", { message: `actions[${idx}].type unknown: "${a.type}"` });
    }
    const version = a.version ?? schema.latest;
    if (!schema.versions[version]) {
      throw new ORPCError("BAD_REQUEST", {
        message: `actions[${idx}] unknown version: "${a.type}@${version}" (known: ${Object.keys(schema.versions).join(", ")})`,
      });
    }
    try {
      return { type: a.type, version, inputs: fw.validateActionInputs(a.type, version, a.inputs) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ORPCError("BAD_REQUEST", { message: `actions[${idx}].inputs invalid — ${msg}` });
    }
  });
}

/**
 * Catalog (event + action schemas, facts, variables) for a specific (eventType, actionType) — and
 * optionally specific versions. If a version is omitted, the framework uses each schema's `latest`.
 */
export const getCatalog = publicProcedure
  .input(
    z.object({
      eventType: z.string().min(1),
      actionType: z.string().min(1),
      eventVersion: z.string().min(1).optional(),
      actionVersion: z.string().min(1).optional(),
    }),
  )
  .handler(async ({ input }) =>
    getTriggerFramework().catalog(input.eventType, input.actionType, input.eventVersion, input.actionVersion),
  );

/**
 * Picker options for a ref-typed action input. The editor calls this to populate a dropdown for
 * any `SchemaProperty` declaring `ref: { source }`. Throws BAD_REQUEST if the source isn't
 * registered (which means it isn't referenced by any current schema either — startup validation
 * would have caught that — so this is really a defense against typo'd client calls).
 */
export const listRefOptions = publicProcedure
  .input(z.object({ source: z.string().min(1) }))
  .handler(async ({ input }) => {
    try {
      return await getTriggerFramework().listRefOptions(input.source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ORPCError("BAD_REQUEST", { message: msg });
    }
  });

export const listTriggers = publicProcedure.handler(async () => getTriggerFramework().store.list());

export const createTrigger = publicProcedure
  .input(
    z.object({
      label: z.string().min(1),
      enabled: z.boolean().optional(),
      // Trigger pins to a specific event schema version (defaults to event's `latest`).
      event: z.string().min(1).default("job.changed"),
      eventVersion: z.string().min(1).optional(),
      conditions: conditionsSchema,
      actions: actionsSchema,
    }),
  )
  .handler(async ({ input }) => {
    const fw = getTriggerFramework();
    const eventSchema = fw.eventSchemas[input.event];
    if (!eventSchema) throw new ORPCError("BAD_REQUEST", { message: `unknown event type: "${input.event}"` });
    const eventVersion = input.eventVersion ?? eventSchema.latest;
    if (!eventSchema.versions[eventVersion]) {
      throw new ORPCError("BAD_REQUEST", {
        message: `unknown event version: "${input.event}@${eventVersion}" (known: ${Object.keys(eventSchema.versions).join(", ")})`,
      });
    }
    const actions = validateActions(fw, input.actions);

    const trigger = fw.store.upsert({
      id: fw.store.newId(),
      label: input.label,
      enabled: input.enabled ?? true,
      event: input.event,
      eventVersion,
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
      eventVersion: z.string().min(1).optional(),
      conditions: conditionsSchema.optional(),
      actions: actionsSchema.optional(),
    }),
  )
  .handler(async ({ input }) => {
    const fw = getTriggerFramework();
    const existing = fw.store.get(input.id);
    if (!existing) throw new ORPCError("NOT_FOUND", { message: "trigger not found" });

    let eventVersion = existing.eventVersion;
    if (input.eventVersion) {
      const eventSchema = fw.eventSchemas[existing.event];
      if (!eventSchema?.versions[input.eventVersion]) {
        throw new ORPCError("BAD_REQUEST", {
          message: `unknown event version: "${existing.event}@${input.eventVersion}"`,
        });
      }
      eventVersion = input.eventVersion;
    }

    const actions = input.actions ? validateActions(fw, input.actions) : existing.actions;

    const updated = fw.store.upsert({
      ...existing,
      label: input.label ?? existing.label,
      enabled: input.enabled ?? existing.enabled,
      eventVersion,
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
