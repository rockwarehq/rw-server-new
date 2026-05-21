import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { displayRequired } from "./middleware.js";
import { auth, logon, crud } from "../services/employee/index.js";
import prisma from "@rw/db";
import type { AuthMethod, AuthCredentials } from "../services/employee/auth.js";

// ============================================================================
// Input Schemas
// ============================================================================

const credentialsSchema = z.object({
  employeeId: z.uuid().optional(),
  employeeNumber: z.string().optional(),
  pin: z.string().optional(),
  badgeNumber: z.string().optional(),
  genericName: z.string().optional(),
});

const logonInputSchema = z.object({
  displayId: z.uuid(),
  method: z.enum(["EMPLOYEE_ID", "PIN", "BADGE", "GENERIC"]),
  credentials: credentialsSchema,
  multiLogonMode: z.enum(["useSite", "single", "multi"]).optional(),
  stationId: z.uuid(),
});

const logoffInputSchema = z.object({
  displayId: z.uuid(),
  sessionId: z.uuid(),
});

const displayIdSchema = z.object({
  displayId: z.uuid(),
});

// ============================================================================
// Helpers
// ============================================================================

interface OperatorLogonConfig {
  enabledMethods: string[];
  requireLogon: boolean;
  allowAutoCreate: boolean;
  maxFailedAttempts: number;
  lockoutMinutes: number;
  sessionTimeout: number | null;
  multiLogon: boolean;
  employeeDisplayFormat: "name" | "employeeNumber" | "badge" | "initials";
}

const DEFAULT_CONFIG: OperatorLogonConfig = {
  enabledMethods: ["BADGE", "EMPLOYEE_ID", "PIN", "GENERIC"],
  requireLogon: false,
  allowAutoCreate: false,
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
  sessionTimeout: null,
  multiLogon: true,
  employeeDisplayFormat: "name",
};

/**
 * Resolve display and get effective operator logon config (site merged with display overrides).
 */
async function resolveDisplayContext(displayId: string) {
  const display = await prisma.display.findUnique({
    where: { id: displayId },
    select: {
      id: true,
      status: true,
      siteId: true,
      stationId: true,
      attrs: true,
      site: { select: { id: true, attrs: true } },
    },
  });

  if (!display || display.status !== "CLAIMED") {
    return null;
  }

  if (!display.siteId) {
    return null;
  }

  // Merge site config with display overrides
  const siteAttrs = (display.site?.attrs as Record<string, unknown>) ?? {};
  const displayAttrs = (display.attrs as Record<string, unknown>) ?? {};

  const siteConfig = (siteAttrs.operatorLogon ?? {}) as Partial<OperatorLogonConfig>;
  const displayConfig = (displayAttrs.operatorLogon ?? {}) as Partial<OperatorLogonConfig>;

  const config: OperatorLogonConfig = {
    ...DEFAULT_CONFIG,
    ...siteConfig,
    ...displayConfig,
  };

  return {
    display,
    siteId: display.siteId,
    stationId: display.stationId,
    config,
  };
}

function assertDisplayIdentity(requestedDisplayId: string, authenticatedDisplayId: string) {
  if (requestedDisplayId !== authenticatedDisplayId) {
    throw new ORPCError("FORBIDDEN", { message: "Display token does not match requested display" });
  }
}

// ============================================================================
// Public Procedures (called from displays — no workspace auth)
// ============================================================================

/**
 * Get the operator logon configuration for a display.
 */
export const config = displayRequired.input(displayIdSchema).handler(async ({ input, context }) => {
  assertDisplayIdentity(input.displayId, context.iam.displayId);

  const ctx = await resolveDisplayContext(input.displayId);
  if (!ctx) {
    throw new ORPCError("NOT_FOUND", { message: "Display not found or not claimed" });
  }

  return {
    enabledMethods: ctx.config.enabledMethods,
    requireLogon: ctx.config.requireLogon,
    hasStation: !!ctx.stationId,
    multiLogon: ctx.config.multiLogon,
    employeeDisplayFormat: ctx.config.employeeDisplayFormat,
  };
});

/**
 * Authenticate and log on an operator at the display's station.
 */
export const operatorLogon = displayRequired.input(logonInputSchema).handler(async ({ input, context }) => {
  assertDisplayIdentity(input.displayId, context.iam.displayId);

  const ctx = await resolveDisplayContext(input.displayId);
  if (!ctx) {
    throw new ORPCError("NOT_FOUND", { message: "Display not found or not claimed" });
  }

  // If the display was provisioned to a station, the client must log on at
  // that one — otherwise honor the operator-picked station.
  if (ctx.stationId && ctx.stationId !== input.stationId) {
    throw new ORPCError("BAD_REQUEST", { message: "Display is provisioned to a different station" });
  }

  // Verify the station belongs to this display's site.
  const station = await prisma.station.findUnique({
    where: { id: input.stationId },
    select: { id: true, siteId: true },
  });
  if (!station || station.siteId !== ctx.siteId) {
    throw new ORPCError("BAD_REQUEST", { message: "Selected station is not at this site" });
  }

  // Check method is enabled
  if (!ctx.config.enabledMethods.includes(input.method)) {
    throw new ORPCError("BAD_REQUEST", { message: `Auth method '${input.method}' is not enabled` });
  }

  const authContext = {
    displayId: input.displayId,
    stationId: input.stationId,
  };

  // Authenticate (allowAutoCreate lets BADGE/EMPLOYEE_ID return success
  // with null employeeId when the employee doesn't exist yet)
  const authResult = await auth.authenticate(
    ctx.siteId,
    input.method as AuthMethod,
    input.credentials as AuthCredentials,
    authContext,
    {
      maxFailedAttempts: ctx.config.maxFailedAttempts,
      lockoutMinutes: ctx.config.lockoutMinutes,
      allowAutoCreate: ctx.config.allowAutoCreate,
    },
  );

  if (!authResult.success) {
    throw new ORPCError("FORBIDDEN", { message: authResult.error });
  }

  // Auto-create employee if auth returned null employeeId (new badge/employee ID)
  let employeeId = authResult.data.employeeId;
  let versionId = authResult.data.versionId;

  if (!employeeId && input.method !== "GENERIC") {
    const autoCreateResult = await crud.create({
      siteId: ctx.siteId,
      employeeNumber: input.credentials.employeeNumber || input.credentials.badgeNumber || `AUTO-${Date.now()}`,
      firstName: authResult.data.firstName || "Unknown",
      lastName: authResult.data.lastName || "",
      badgeNumber: input.credentials.badgeNumber,
    });
    employeeId = autoCreateResult.data.id;
    versionId = autoCreateResult.data.versionId;
  }

  // Single-logon enforcement: auto-logoff existing sessions before creating new one
  const multiLogonResolved =
    input.multiLogonMode === "single"
      ? { allowed: false, source: "component" as const }
      : input.multiLogonMode === "multi"
        ? { allowed: true, source: "component" as const }
        : { allowed: ctx.config.multiLogon, source: "site" as const };

  if (!multiLogonResolved.allowed) {
    const scope = multiLogonResolved.source === "site" ? "station" : "display";
    await logon.logoffByScope(scope, input.displayId, input.stationId);
  }

  // Create logon session
  const session = await logon.logon({
    employeeId,
    versionId,
    stationId: input.stationId,
    displayId: input.displayId,
    logonMethod: input.method,
    genericName: input.method === "GENERIC" ? input.credentials.genericName : undefined,
  });

  if ("error" in session) {
    const code = session.code === "ALREADY_LOGGED_ON" ? "CONFLICT" : "INTERNAL_SERVER_ERROR";
    throw new ORPCError(code, { message: session.error });
  }

  // Return updated session list
  const activeSessions = await logon.getActiveSessions(input.displayId);

  return {
    session: session.data,
    activeSessions: activeSessions.data,
  };
});

/**
 * Log off an operator from the display's station.
 */
export const operatorLogoff = displayRequired.input(logoffInputSchema).handler(async ({ input, context }) => {
  assertDisplayIdentity(input.displayId, context.iam.displayId);

  const result = await logon.logoff(input.sessionId, input.displayId);
  if ("error" in result) {
    const code = result.code === "NOT_FOUND" ? "NOT_FOUND" : result.code === "FORBIDDEN" ? "FORBIDDEN" : "BAD_REQUEST";
    throw new ORPCError(code, { message: result.error });
  }

  const activeSessions = await logon.getActiveSessions(input.displayId);
  return { activeSessions: activeSessions.data };
});

/**
 * Log off all operators from the display's station.
 */
export const operatorLogoffAll = displayRequired.input(displayIdSchema).handler(async ({ input, context }) => {
  assertDisplayIdentity(input.displayId, context.iam.displayId);

  const result = await logon.logoffAll(input.displayId);
  return { count: result.data.count, activeSessions: [] };
});

/**
 * Get active logon sessions for the display's station.
 */
export const activeSessions = displayRequired.input(displayIdSchema).handler(async ({ input, context }) => {
  assertDisplayIdentity(input.displayId, context.iam.displayId);

  const result = await logon.getActiveSessions(input.displayId);
  return result.data;
});

/**
 * List active employees for the display's site, used to populate the operator
 * logon directory. Returns only the minimum public-safe fields.
 */
const employeesInputSchema = z.object({
  displayId: z.uuid(),
  search: z.string().optional(),
});

export const employees = displayRequired.input(employeesInputSchema).handler(async ({ input, context }) => {
  assertDisplayIdentity(input.displayId, context.iam.displayId);

  const ctx = await resolveDisplayContext(input.displayId);
  if (!ctx) {
    throw new ORPCError("NOT_FOUND", { message: "Display not found or not claimed" });
  }

  const result = await crud.list({
    siteId: ctx.siteId,
    status: "ACTIVE",
    search: input.search,
    limit: 0,
  });

  return result.data.map((e) => ({
    id: e.id,
    employeeNumber: e.version?.employeeNumber ?? null,
    firstName: e.version?.firstName ?? null,
    lastName: e.version?.lastName ?? null,
  }));
});
