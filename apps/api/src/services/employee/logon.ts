import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { publishMetricValueChange } from "@rw/services/rpc/metrics-bus";
import { logEvent } from "@rw/services/audit/index";
import { getCurrentShift } from "@rw/services/facility/shift/current";
import { resolveEntityPath } from "@rw/services/metrics/hierarchy";

// ============================================================================
// Types
// ============================================================================

export interface LogonInput {
  employeeId: string | null;
  versionId: string | null;
  stationId: string;
  displayId: string;
  logonMethod: string;
  genericName?: string;
}

// Public session shape (returned to clients)
const sessionSelect = {
  id: true,
  employeeId: true,
  stationId: true,
  displayId: true,
  genericName: true,
  logonMethod: true,
  logonTime: true,
  logoffTime: true,
  employee: {
    select: {
      id: true,
      version: {
        select: {
          firstName: true,
          lastName: true,
          employeeNumber: true,
        },
      },
    },
  },
  version: {
    select: {
      id: true,
      version: true,
      badgeNumber: true,
      firstName: true,
      lastName: true,
      employeeNumber: true,
    },
  },
} as const;

// ============================================================================
// Live metric: currentLogons
// ============================================================================

interface LogonNameSession {
  genericName: string | null;
  version: { firstName: string | null; lastName: string | null; employeeNumber: string | null } | null;
}

export function formatStationLogons(sessions: ReadonlyArray<LogonNameSession>): string | null {
  if (sessions.length === 0) return null;
  return sessions
    .map((s) => {
      if (s.genericName) return s.genericName;
      const fullName = [s.version?.firstName, s.version?.lastName].filter(Boolean).join(" ").trim();
      return fullName || s.version?.employeeNumber || "Unknown";
    })
    .join(", ");
}

async function distinctActiveStationIds(where: Prisma.StationLogonSessionWhereInput): Promise<string[]> {
  const rows = await prisma.stationLogonSession.findMany({
    where,
    select: { stationId: true },
    distinct: ["stationId"],
  });
  return rows.map((r) => r.stationId);
}

export async function publishStationCurrentLogonsMetric(stationId: string, observedAt: Date): Promise<void> {
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { siteId: true, name: true },
  });
  if (!station) return;

  const sessions = await prisma.stationLogonSession.findMany({
    where: { stationId, logoffTime: null },
    select: {
      genericName: true,
      version: { select: { firstName: true, lastName: true, employeeNumber: true } },
    },
    orderBy: { logonTime: "asc" },
  });

  const path = await resolveEntityPath("STATION", stationId, station.siteId);
  publishMetricValueChange({
    siteId: station.siteId,
    entityType: "STATION",
    entityId: stationId,
    metricKey: "currentLogons",
    sourceType: "live",
    value: formatStationLogons(sessions),
    observedAt,
    entityName: station.name,
    path,
  });
}

async function publishLogonsForStations(stationIds: ReadonlyArray<string>, observedAt: Date): Promise<void> {
  await Promise.all(stationIds.map((id) => publishStationCurrentLogonsMetric(id, observedAt)));
}

// ============================================================================
// Operations
// ============================================================================

/**
 * Create a logon session for an employee (or generic name) at a station.
 */
export async function logon(input: LogonInput) {
  const { employeeId, versionId, stationId, displayId, logonMethod, genericName } = input;

  // Find the current shift instance for audit/time tracking
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { siteId: true, workcenterId: true },
  });

  if (!station) return { error: "Station not found", code: "STATION_NOT_FOUND" };

  // Prevent duplicate logons for the same employee at this display
  if (employeeId) {
    const existing = await prisma.stationLogonSession.findFirst({
      where: { employeeId, displayId, logoffTime: null },
      select: { id: true },
    });
    if (existing) return { error: "Employee is already logged on at this display", code: "ALREADY_LOGGED_ON" };
  }

  let shiftInstanceId: string | null = null;
  const shiftResult = await getCurrentShift(station.siteId, station.workcenterId ?? undefined);
  if ("success" in shiftResult && shiftResult.data.shift) {
    shiftInstanceId = shiftResult.data.shift.shiftInstanceId;
  }

  const session = await prisma.stationLogonSession.create({
    data: {
      employeeId,
      versionId,
      stationId,
      displayId,
      logonMethod,
      genericName: genericName || null,
      shiftInstanceId,
    },
    select: sessionSelect,
  });

  await logEvent({
    action: "OPERATOR_LOGON",
    metadata: {
      sessionId: session.id,
      employeeId,
      stationId,
      displayId,
      logonMethod,
      genericName,
      shiftInstanceId,
    },
  });

  await publishStationCurrentLogonsMetric(stationId, session.logonTime);

  return { data: session };
}

/**
 * End a specific logon session.
 */
export async function logoff(sessionId: string, displayId: string) {
  const session = await prisma.stationLogonSession.findUnique({
    where: { id: sessionId },
    select: { id: true, displayId: true, logoffTime: true },
  });

  if (!session) return { error: "Session not found", code: "NOT_FOUND" };
  if (session.displayId !== displayId) return { error: "Session does not belong to this display", code: "FORBIDDEN" };
  if (session.logoffTime) return { error: "Session already ended", code: "ALREADY_ENDED" };

  const updated = await prisma.stationLogonSession.update({
    where: { id: sessionId },
    data: { logoffTime: new Date() },
    select: sessionSelect,
  });

  await logEvent({
    action: "OPERATOR_LOGOFF",
    metadata: {
      sessionId: updated.id,
      employeeId: updated.employeeId,
      stationId: updated.stationId,
      displayId: updated.displayId,
    },
  });

  await publishStationCurrentLogonsMetric(updated.stationId, updated.logoffTime ?? new Date());

  return { data: updated };
}

/**
 * End all active logon sessions at this display.
 */
export async function logoffAll(displayId: string) {
  const now = new Date();
  const affectedStationIds = await distinctActiveStationIds({ displayId, logoffTime: null });
  const result = await prisma.stationLogonSession.updateMany({
    where: {
      displayId,
      logoffTime: null,
    },
    data: { logoffTime: now },
  });

  await logEvent({
    action: "OPERATOR_LOGOFF",
    metadata: {
      displayId,
      allSessions: true,
      count: result.count,
    },
  });

  await publishLogonsForStations(affectedStationIds, now);

  return { data: { count: result.count } };
}

/**
 * Log off active sessions by scope. Used for single-logon enforcement.
 * - "station": ends all active sessions at the given station (falls back
 *   to the display's provisioned stationId when no stationId is supplied,
 *   for callers that don't know the operator-picked station)
 * - "display": ends all active sessions at the specific display
 */
export async function logoffByScope(scope: "station" | "display", displayId: string, stationId?: string) {
  const where: Prisma.StationLogonSessionWhereInput = { logoffTime: null };

  if (scope === "station") {
    let resolvedStationId = stationId;
    if (!resolvedStationId) {
      const display = await prisma.display.findUnique({
        where: { id: displayId },
        select: { stationId: true },
      });
      resolvedStationId = display?.stationId ?? undefined;
    }
    if (!resolvedStationId) return { data: { count: 0 } };
    where.stationId = resolvedStationId;
  } else {
    where.displayId = displayId;
  }

  const now = new Date();
  const affectedStationIds = await distinctActiveStationIds(where);
  const result = await prisma.stationLogonSession.updateMany({
    where,
    data: { logoffTime: now },
  });

  await logEvent({
    action: "OPERATOR_LOGOFF",
    metadata: {
      displayId,
      scope,
      autoLogoff: true,
      count: result.count,
    },
  });

  await publishLogonsForStations(affectedStationIds, now);

  return { data: { count: result.count } };
}

/**
 * Get all active (open) logon sessions for a display.
 */
export async function getActiveSessions(displayId: string) {
  const sessions = await prisma.stationLogonSession.findMany({
    where: {
      displayId,
      logoffTime: null,
    },
    select: sessionSelect,
    orderBy: { logonTime: "asc" },
  });

  return { data: sessions };
}
