import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { Principal } from "../services/auth/index.js";
import { site } from "@rw/services/facility/index";
import { authRequired, userOrDisplayRequired } from "./middleware.js";

const andonRuleInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().nullable().optional(),
  expression: z.string(),
  referencedVariables: z.array(z.string()),
  colorHex: z.string(),
  enabled: z.boolean().optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable().optional(),
  expression: z.string().optional(),
  referencedVariables: z.array(z.string()).optional(),
  colorHex: z.string().optional(),
  enabled: z.boolean().optional(),
});

const deleteInputSchema = z.object({
  id: z.uuid(),
});

const reorderInputSchema = z.object({
  siteId: z.uuid(),
  orderedIds: z.array(z.uuid()),
});

function requireWorkspaceId(workspaceId?: string) {
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return workspaceId;
}

function hasAndonRuleError(result: unknown): result is { error: string; code: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    typeof result.error === "string" &&
    "code" in result &&
    typeof result.code === "string"
  );
}

function mapAndonRuleError(result: { error: string; code: string }): never {
  if (result.code === "SITE_NOT_FOUND" || result.code === "RULE_NOT_FOUND") {
    throw new ORPCError("NOT_FOUND", { message: result.error, cause: result });
  }

  if (result.code === "WORKSPACE_MISMATCH") {
    throw new ORPCError("FORBIDDEN", { message: result.error, cause: result });
  }

  throw new ORPCError("BAD_REQUEST", { message: result.error, cause: result });
}

export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const workspaceId = requireWorkspaceId(context.iam.workspaceId);

  if (context.iam.principal === Principal.DISPLAY && input.siteId !== context.iam.siteId) {
    throw new ORPCError("FORBIDDEN", { message: "Display can only access Andon rules for its site" });
  }

  const result = await site.andonRules.list(input, workspaceId);
  if (hasAndonRuleError(result)) {
    mapAndonRuleError(result);
  }

  return result.data;
});

export const create = authRequired.input(andonRuleInputSchema).handler(async ({ input, context }) => {
  const workspaceId = requireWorkspaceId(context.iam.workspaceId);

  const result = await site.andonRules.create(input, workspaceId);
  if (hasAndonRuleError(result)) {
    mapAndonRuleError(result);
  }

  return result.data;
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = requireWorkspaceId(context.iam.workspaceId);

  const result = await site.andonRules.update(input, workspaceId);
  if (hasAndonRuleError(result)) {
    mapAndonRuleError(result);
  }

  return result.data;
});

export const remove = authRequired.input(deleteInputSchema).handler(async ({ input, context }) => {
  const workspaceId = requireWorkspaceId(context.iam.workspaceId);

  const result = await site.andonRules.remove(input.id, workspaceId);
  if (hasAndonRuleError(result)) {
    mapAndonRuleError(result);
  }

  return { success: true };
});

export const reorder = authRequired.input(reorderInputSchema).handler(async ({ input, context }) => {
  const workspaceId = requireWorkspaceId(context.iam.workspaceId);

  const result = await site.andonRules.reorder(input, workspaceId);
  if (hasAndonRuleError(result)) {
    mapAndonRuleError(result);
  }

  return { success: true };
});
