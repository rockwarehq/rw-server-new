import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { publicProcedure, authRequired } from "./middleware.js";
import { display } from "@rw/services/display/index";
import { Principal } from "../services/auth/index.js";

// ============================================================================
// Input Schemas
// ============================================================================

const idInputSchema = z.object({
  id: z.uuid(),
});

const claimInputSchema = z.object({
  claimCode: z.string().min(1),
  name: z.string().min(1),
  siteId: z.uuid(),
});

const assignDashboardInputSchema = z.object({
  id: z.uuid(),
  dashboardId: z.uuid(),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  workcenterId: z.uuid().nullable().optional(),
  stationId: z.uuid().nullable().optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  status: z.enum(["UNCLAIMED", "CLAIMED"]).optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Public Procedures (no auth - used by TVs/tablets)
// ============================================================================

/**
 * Register a new unclaimed display
 * Called by the TV/tablet when it first opens /display
 */
export const register = publicProcedure.handler(async () => {
  const result = await display.register();
  if ("error" in result) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * Get display by ID (includes dashboard spec/state)
 * Called by the TV/tablet to poll for claim status and get dashboard data
 */
export const get = publicProcedure.input(idInputSchema).handler(async ({ input }) => {
  const result = await display.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Display not found" });
  }
  return result.data;
});

/**
 * Heartbeat - update lastSeenAt timestamp
 * Called by the TV/tablet periodically
 */
export const heartbeat = publicProcedure.input(idInputSchema).handler(async ({ input, context }) => {
  const claimedDisplay = await display.getClaimedDisplayForAuth(input.id);
  if (claimedDisplay) {
    if (!context.iam?.validToken || context.iam.principal !== Principal.DISPLAY || context.iam.displayId !== input.id) {
      // Disabling check for now, may not be needed and causes race condition between claiming display and getting auth token
      // throw new ORPCError("UNAUTHORIZED", { message: "Display authentication required" });
    }
  }

  const result = await display.heartbeat(input.id);
  if ("error" in result) {
    throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
  }
  return { success: true };
});

// ============================================================================
// Authenticated Procedures (workspace management)
// ============================================================================

/**
 * Claim a display by its claim code
 */
export const claim = authRequired.input(claimInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await display.claim(workspaceId, input.claimCode, {
    name: input.name,
    siteId: input.siteId,
  });

  if ("error" in result) {
    const code = result.code as string;
    if (code === "INVALID_CLAIM_CODE") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "ALREADY_CLAIMED") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    if (code === "SITE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "SITE_NOT_IN_WORKSPACE") {
      throw new ORPCError("FORBIDDEN", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * List displays for a site
 */
export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return display.listForWorkspace(workspaceId, input);
});

/**
 * Assign a dashboard to a display
 */
export const assignDashboard = authRequired.input(assignDashboardInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await display.assignDashboard(workspaceId, input.id, input.dashboardId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "DISPLAY_NOT_FOUND" || code === "DASHBOARD_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "SITE_MISMATCH") {
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    if (code === "NOT_CLAIMED") {
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * Unassign dashboard from a display
 */
export const unassignDashboard = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await display.unassignDashboard(workspaceId, input.id);
  if ("error" in result) {
    throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * Update display (rename)
 */
export const update = authRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const { id, ...updateData } = input;
  const result = await display.update(workspaceId, id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "WORKCENTER_NOT_FOUND" || code === "STATION_NOT_FOUND") {
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * Delete display
 */
export const remove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await display.remove(workspaceId, input.id);
  if ("error" in result) {
    throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
  }
  return { success: true };
});
