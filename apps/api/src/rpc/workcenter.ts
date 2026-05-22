import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { workcenter } from "@rw/services/facility/index";
import { getAccessibleSites, hasPermission } from "@rw/services/iam/index";
import { Principal } from "../services/auth/index.js";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  siteId: z.uuid(),
  parentId: z.uuid().optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const moveInputSchema = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  parentId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures
// ============================================================================

/**
 * Create a new workcenter
 */
export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }
  if (!(await hasPermission(context.iam.id, "facility:write", { workspaceId, siteId: input.siteId }))) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:write" });
  }

  const result = await workcenter.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND" || code === "PARENT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "SITE_MISMATCH") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * List workcenters
 */
export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const access = await getAccessibleSites(context.iam.id, "facility:read", workspaceId);
  if (input.siteId && !access.all && !access.siteIds.includes(input.siteId)) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:read" });
  }
  return workcenter.list({ ...input, siteIds: input.siteId || access.all ? undefined : access.siteIds });
});

/**
 * Get workcenter by ID
 */
export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;

  const result = await workcenter.getById(input.id, workspaceId);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Workcenter not found" });
  }
  if ("error" in result) {
    throw new ORPCError("FORBIDDEN", {
      message: result.error as string,
      cause: result,
    });
  }
  if (
    context.iam.principal !== Principal.DISPLAY &&
    (!context.iam.id ||
      !workspaceId ||
      !(await hasPermission(context.iam.id, "facility:read", { workspaceId, siteId: result.data.siteId })))
  ) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:read" });
  }
  return result.data;
});

/**
 * Update workcenter
 */
export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  const workspaceId = context.iam.workspaceId;

  const existing = await workcenter.getById(id, workspaceId);
  if (!existing || "error" in existing) {
    throw new ORPCError("NOT_FOUND", { message: "Workcenter not found" });
  }
  if (
    !workspaceId ||
    !(await hasPermission(context.iam.id, "facility:write", { workspaceId, siteId: existing.data.siteId }))
  ) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:write" });
  }

  const result = await workcenter.update(id, updateData, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "WORKCENTER_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Move workcenter to a new parent (within same site)
 */
export const move = authRequired.input(moveInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;

  const existing = await workcenter.getById(input.id, workspaceId);
  if (!existing || "error" in existing) {
    throw new ORPCError("NOT_FOUND", { message: "Workcenter not found" });
  }
  if (
    !workspaceId ||
    !(await hasPermission(context.iam.id, "facility:write", { workspaceId, siteId: existing.data.siteId }))
  ) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:write" });
  }

  const result = await workcenter.move(input.id, input.parentId, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "WORKCENTER_NOT_FOUND" || code === "PARENT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "SITE_MISMATCH" || code === "CIRCULAR_REFERENCE") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Delete workcenter
 */
export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;

  const existing = await workcenter.getById(input.id, workspaceId);
  if (!existing || "error" in existing) {
    throw new ORPCError("NOT_FOUND", { message: "Workcenter not found" });
  }
  if (
    !workspaceId ||
    !(await hasPermission(context.iam.id, "facility:admin", { workspaceId, siteId: existing.data.siteId }))
  ) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:admin" });
  }

  const result = await workcenter.remove(input.id, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "WORKCENTER_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "WORKSPACE_MISMATCH") {
      throw new ORPCError("FORBIDDEN", {
        message: result.error as string,
        cause: result,
      });
    }
    // HAS_CHILDREN, HAS_STATIONS
    throw new ORPCError("CONFLICT", {
      message: result.error as string,
      cause: result,
    });
  }
  return { success: true };
});
