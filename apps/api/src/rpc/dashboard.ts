import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { dashboard } from "@rw/services/dashboard/index";
import { Principal } from "../services/auth/index.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures
// ============================================================================

/**
 * Create a new dashboard
 */
export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await dashboard.create(input, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * List dashboards
 */
export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  if (context.iam.principal === Principal.DISPLAY) {
    if (input.siteId && input.siteId !== context.iam.siteId) {
      throw new ORPCError("FORBIDDEN", { message: "Display can only access dashboards in its site" });
    }

    return dashboard.list({ ...input, siteId: context.iam.siteId }, workspaceId);
  }

  return dashboard.list(input, workspaceId);
});

/**
 * Get dashboard by ID
 */
export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await dashboard.getById(input.id, workspaceId);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Dashboard not found" });
  }
  if ("error" in result) {
    const code = result.code as string;
    if (code === "DASHBOARD_DELETED") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }

  if (context.iam.principal === Principal.DISPLAY && result.data.siteId !== context.iam.siteId) {
    throw new ORPCError("FORBIDDEN", { message: "Display can only access dashboards in its site" });
  }

  return result.data;
});

/**
 * Update dashboard
 */
export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const { id, ...updateData } = input;
  const result = await dashboard.update(id, updateData, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "DASHBOARD_NOT_FOUND" || code === "DASHBOARD_DELETED") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * Delete dashboard (soft delete)
 */
export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await dashboard.remove(input.id, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "DASHBOARD_NOT_FOUND" || code === "DASHBOARD_DELETED") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return { success: true };
});
