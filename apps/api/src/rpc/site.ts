import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { site } from "@rw/services/facility/index";
import { Principal } from "../services/auth/index.js";
import { getAccessibleSites, hasPermission } from "@rw/services/iam/index";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  timezone: z.string().min(1).optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const listInputSchema = z.object({
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures
// ============================================================================

/**
 * Create a new site
 */
export const create = authRequired.input(createInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  if (!(await hasPermission(context.iam.id, "facility:write", { workspaceId }))) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:write" });
  }

  const result = await site.create({ ...input, workspaceId });
  if ("error" in result) {
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * List sites in workspace
 */
export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const access = await getAccessibleSites(context.iam.id, "facility:read", workspaceId);
  return site.list({ ...input, workspaceId, siteIds: access.all ? undefined : access.siteIds });
});

/**
 * Get site by ID
 */
export const get = userOrDisplayRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  if (context.iam.principal === Principal.DISPLAY && input.id !== context.iam.siteId) {
    throw new ORPCError("FORBIDDEN", {
      message: "Display can only access its own site",
    });
  }

  const result = await site.getById(input.id, workspaceId);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Site not found" });
  }
  if ("error" in result) {
    throw new ORPCError("FORBIDDEN", {
      message: result.error as string,
      cause: result,
    });
  }
  if (
    context.iam.principal === Principal.USER &&
    !(await hasPermission(context.iam.id, "facility:read", { workspaceId, siteId: input.id }))
  ) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:read" });
  }
  return result.data;
});

const treeInputSchema = z.object({
  siteId: z.uuid().optional(),
});

/**
 * Get site tree (Site -> Workcenter -> Station)
 * If siteId is provided, returns single site tree
 * If siteId is omitted, returns all sites in workspace
 */
export const tree = userOrDisplayRequired.input(treeInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  if (context.iam.principal === Principal.DISPLAY) {
    const siteId = context.iam.siteId;
    if (!siteId) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Display site context required",
      });
    }

    if (input.siteId && input.siteId !== siteId) {
      throw new ORPCError("FORBIDDEN", {
        message: "Display can only access its site tree",
      });
    }

    const result = await site.getSiteTree(siteId, workspaceId);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "SITE_NOT_FOUND") {
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

    if (input.siteId) {
      return result.data;
    }

    return [result.data];
  }

  if (context.iam.principal !== Principal.USER) {
    throw new ORPCError("UNAUTHORIZED", { message: "Authentication required" });
  }
  const userId = context.iam.id;
  if (!userId) {
    throw new ORPCError("UNAUTHORIZED", { message: "Authentication required" });
  }

  // If siteId provided, return single site tree
  if (input.siteId) {
    const result = await site.getSiteTree(input.siteId, workspaceId);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "SITE_NOT_FOUND") {
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
    if (!(await hasPermission(userId, "facility:read", { workspaceId, siteId: input.siteId }))) {
      throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:read" });
    }
    return result.data;
  }

  // No siteId, return full workspace tree
  const access = await getAccessibleSites(userId, "facility:read", workspaceId);
  return site.getTree(workspaceId, access.all ? undefined : access.siteIds);
});

/**
 * Update site
 */
export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const { id, ...updateData } = input;
  const workspaceId = context.iam.workspaceId;

  if (!workspaceId || !(await hasPermission(context.iam.id, "facility:write", { workspaceId, siteId: id }))) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:write" });
  }

  const result = await site.update(id, updateData, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND") {
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
 * Delete site
 */
export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;

  if (!workspaceId || !(await hasPermission(context.iam.id, "facility:admin", { workspaceId, siteId: input.id }))) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:admin" });
  }

  const result = await site.remove(input.id, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND") {
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
    // HAS_WORKCENTERS, HAS_GATEWAYS, HAS_DATASOURCES
    throw new ORPCError("CONFLICT", {
      message: result.error as string,
      cause: result,
    });
  }
  return { success: true };
});

const siteIdInputSchema = z.object({
  siteId: z.uuid(),
});

/**
 * Get device tree for a site (Gateway -> Datasources)
 * Returns all gateways with their assigned datasources (all statuses)
 */
export const deviceTree = authRequired.input(siteIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;

  if (!workspaceId || !(await hasPermission(context.iam.id, "facility:read", { workspaceId, siteId: input.siteId }))) {
    throw new ORPCError("FORBIDDEN", { message: "Missing permission: facility:read" });
  }

  const result = await site.getDeviceTree(input.siteId, workspaceId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND") {
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
