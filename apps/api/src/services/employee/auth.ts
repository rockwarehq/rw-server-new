import prisma from "@rw/db";
import { securityConfig } from "../../config.js";
import { comparePassword } from "../auth/session.js";
import { logEvent } from "@rw/services/audit/index";
import { getByBadgeNumber, getByEmployeeNumber } from "./crud.js";

// ============================================================================
// Types
// ============================================================================

export type AuthMethod = "EMPLOYEE_ID" | "PIN" | "BADGE" | "GENERIC";

export interface AuthCredentials {
  employeeNumber?: string;
  pin?: string;
  badgeNumber?: string;
  employeeId?: string;
  genericName?: string;
}

export interface AuthResult {
  employeeId: string | null;
  versionId: string | null;
  firstName: string;
  lastName: string;
  role: string;
  employeeNumber: string | null;
}

interface AuthContext {
  displayId: string;
  stationId: string;
}

// ============================================================================
// Default lockout config (mirrors securityConfig for workspace users)
// ============================================================================

const DEFAULT_MAX_ATTEMPTS = securityConfig.maxLoginAttempts;

// ============================================================================
// Main auth dispatcher
// ============================================================================

export async function authenticate(
  siteId: string,
  method: AuthMethod,
  credentials: AuthCredentials,
  context: AuthContext,
  config?: { maxFailedAttempts?: number; lockoutMinutes?: number; allowAutoCreate?: boolean },
): Promise<{ success: true; data: AuthResult } | { success: false; error: string }> {
  const maxAttempts = config?.maxFailedAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const lockoutMs = (config?.lockoutMinutes ?? 15) * 60 * 1000;

  const allowAutoCreate = config?.allowAutoCreate ?? false;

  switch (method) {
    case "GENERIC":
      return authenticateGeneric(credentials, context);
    case "EMPLOYEE_ID":
      return authenticateEmployeeId(siteId, credentials, context, maxAttempts, lockoutMs, allowAutoCreate);
    case "PIN":
      return authenticatePin(siteId, credentials, context, maxAttempts, lockoutMs);
    case "BADGE":
      return authenticateBadge(siteId, credentials, context, maxAttempts, lockoutMs, allowAutoCreate);
    default:
      return { success: false, error: `Unknown auth method: ${method}` };
  }
}

// ============================================================================
// Per-method handlers
// ============================================================================

async function authenticateGeneric(
  credentials: AuthCredentials,
  context: AuthContext,
): Promise<{ success: true; data: AuthResult } | { success: false; error: string }> {
  const name = credentials.genericName?.trim();
  if (!name) {
    return { success: false, error: "Name is required" };
  }

  // Split on first space for first/last name
  const spaceIdx = name.indexOf(" ");
  const firstName = spaceIdx > 0 ? name.slice(0, spaceIdx) : name;
  const lastName = spaceIdx > 0 ? name.slice(spaceIdx + 1) : "";

  await logEvent({
    action: "OPERATOR_LOGON",
    metadata: {
      stationId: context.stationId,
      displayId: context.displayId,
      method: "GENERIC",
      genericName: name,
    },
  });

  return {
    success: true,
    data: {
      employeeId: null,
      versionId: null,
      firstName,
      lastName,
      role: "Operator",
      employeeNumber: null,
    },
  };
}

async function authenticateEmployeeId(
  siteId: string,
  credentials: AuthCredentials,
  context: AuthContext,
  _maxAttempts: number,
  _lockoutMs: number,
  allowAutoCreate: boolean,
): Promise<{ success: true; data: AuthResult } | { success: false; error: string }> {
  if (!credentials.employeeId && !credentials.employeeNumber) {
    return { success: false, error: "Employee identifier is required" };
  }

  const employee = await resolveEmployee(siteId, credentials);
  if (!employee) {
    if (allowAutoCreate && credentials.employeeNumber) {
      // Auto-create only fires when an unknown employee number was scanned
      // or typed — a missing UUID lookup is always treated as not-found.
      return {
        success: true,
        data: {
          employeeId: null,
          versionId: null,
          firstName: credentials.employeeNumber,
          lastName: "",
          role: "Operator",
          employeeNumber: credentials.employeeNumber,
        },
      };
    }
    await logFailure(siteId, null, "EMPLOYEE_ID", "employee_not_found", context);
    return { success: false, error: "Employee not found" };
  }

  if (employee.status !== "ACTIVE") {
    await logFailure(siteId, employee.id, "EMPLOYEE_ID", "inactive", context);
    return { success: false, error: "Employee account is inactive" };
  }

  // No secret required for EMPLOYEE_ID — identity only
  return {
    success: true,
    data: {
      employeeId: employee.id,
      versionId: employee.version?.id ?? null,
      firstName: employee.version?.firstName ?? "",
      lastName: employee.version?.lastName ?? "",
      role: employee.siteAccess[0]?.role.name ?? "Operator",
      employeeNumber: employee.version?.employeeNumber ?? null,
    },
  };
}

async function authenticatePin(
  siteId: string,
  credentials: AuthCredentials,
  context: AuthContext,
  maxAttempts: number,
  lockoutMs: number,
): Promise<{ success: true; data: AuthResult } | { success: false; error: string }> {
  if (!credentials.pin) {
    return { success: false, error: "PIN is required" };
  }

  const employee = await resolveEmployee(siteId, credentials);
  if (!employee) {
    return { success: false, error: "Employee not found" };
  }

  const lockoutResult = checkLockout(employee);
  if (lockoutResult) return lockoutResult;

  if (!employee.versionId) {
    return { success: false, error: "Employee profile is incomplete" };
  }

  const version = await prisma.employeeVersion.findUnique({
    where: { id: employee.versionId },
  });

  if (!version?.pinHash) {
    await logFailure(siteId, employee.id, "PIN", "no_pin_set", context);
    return { success: false, error: "PIN not configured for this employee" };
  }

  const valid = await comparePassword(credentials.pin, version.pinHash);
  if (!valid) {
    await handleFailedAttempt(employee.id, maxAttempts, lockoutMs, siteId, "PIN", context);
    return { success: false, error: "Invalid PIN" };
  }

  await resetFailedAttempts(employee.id);
  return {
    success: true,
    data: {
      employeeId: employee.id,
      versionId: version.id,
      firstName: version.firstName,
      lastName: version.lastName,
      role: employee.siteAccess[0]?.role.name ?? "Operator",
      employeeNumber: version.employeeNumber,
    },
  };
}

async function authenticateBadge(
  siteId: string,
  credentials: AuthCredentials,
  context: AuthContext,
  _maxAttempts: number,
  _lockoutMs: number,
  allowAutoCreate: boolean,
): Promise<{ success: true; data: AuthResult } | { success: false; error: string }> {
  if (!credentials.badgeNumber) {
    return { success: false, error: "Badge number is required" };
  }

  const result = await getByBadgeNumber(siteId, credentials.badgeNumber);
  if (!result) {
    if (allowAutoCreate) {
      // Return success with null employeeId — RPC layer will auto-create
      return {
        success: true,
        data: {
          employeeId: null,
          versionId: null,
          firstName: credentials.badgeNumber,
          lastName: "",
          role: "Operator",
          employeeNumber: null,
        },
      };
    }
    await logFailure(siteId, null, "BADGE", "badge_not_found", context);
    return { success: false, error: "Badge not recognized" };
  }

  const { data: employee } = result;
  if (employee.status !== "ACTIVE") {
    await logFailure(siteId, employee.id, "BADGE", "inactive", context);
    return { success: false, error: "Employee account is inactive" };
  }

  // Badge is a physical token — no secret comparison needed
  return {
    success: true,
    data: {
      employeeId: employee.id,
      versionId: employee.version?.id ?? null,
      firstName: employee.version?.firstName ?? "",
      lastName: employee.version?.lastName ?? "",
      role: employee.siteAccess[0]?.role.name ?? "Operator",
      employeeNumber: employee.version?.employeeNumber ?? null,
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve an employee by explicit employee id, badge, or employee number.
 */
async function resolveEmployee(siteId: string, credentials: AuthCredentials) {
  if (credentials.employeeId) {
    const result = await prisma.employee.findFirst({
      where: {
        id: credentials.employeeId,
        status: "ACTIVE",
        siteAccess: { some: { siteId, status: "ACTIVE" } },
      },
      include: {
        version: true,
        siteAccess: {
          where: { siteId },
          include: { role: { select: { name: true } } },
        },
      },
    });
    return result;
  }
  if (credentials.badgeNumber) {
    const result = await getByBadgeNumber(siteId, credentials.badgeNumber);
    return result?.data ?? null;
  }
  if (credentials.employeeNumber) {
    const result = await getByEmployeeNumber(siteId, credentials.employeeNumber);
    return result?.data ?? null;
  }
  return null;
}

function checkLockout(employee: { lockedUntil: Date | null }): { success: false; error: string } | null {
  if (employee.lockedUntil && employee.lockedUntil > new Date()) {
    const minutesRemaining = Math.ceil((employee.lockedUntil.getTime() - Date.now()) / 60000);
    return {
      success: false,
      error: `Account locked. Try again in ${minutesRemaining} minute${minutesRemaining === 1 ? "" : "s"}.`,
    };
  }
  return null;
}

async function handleFailedAttempt(
  employeeId: string,
  maxAttempts: number,
  lockoutMs: number,
  siteId: string,
  method: string,
  context: AuthContext,
) {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { failedLoginAttempts: true },
  });

  const attempts = (employee?.failedLoginAttempts ?? 0) + 1;
  const shouldLock = attempts >= maxAttempts;
  const lockout = shouldLock ? new Date(Date.now() + lockoutMs) : null;

  await prisma.employee.update({
    where: { id: employeeId },
    data: {
      failedLoginAttempts: attempts,
      lockedUntil: lockout,
    },
  });

  await logFailure(siteId, employeeId, method, "invalid_credentials", context, {
    attempts,
    locked: shouldLock,
  });
}

async function resetFailedAttempts(employeeId: string) {
  await prisma.employee.update({
    where: { id: employeeId },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });
}

async function logFailure(
  siteId: string,
  employeeId: string | null,
  method: string,
  reason: string,
  context: AuthContext,
  extra?: Record<string, unknown>,
) {
  await logEvent({
    action: "OPERATOR_LOGON_FAILED",
    metadata: {
      siteId,
      employeeId,
      method,
      reason,
      stationId: context.stationId,
      displayId: context.displayId,
      ...extra,
    },
  });
}
