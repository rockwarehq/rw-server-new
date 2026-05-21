// ── ShiftInstance auto-materialization ────────────────────────────
//
// Ensures ShiftInstance rows exist for all active ShiftAssignments,
// looking ahead a configurable number of days (default 7).
//
// Runs from the 60-second background worker. Idempotent — uses
// Prisma createMany with skipDuplicates (leveraging the unique
// constraint on [assignmentId, startTime]).
//
// Flow:
//   1. Find active ShiftAssignment records (not ended)
//   2. For each assignment, for each date in [today, today + lookahead]:
//      a. Compute which rotation day applies
//      b. Get ShiftDefinitions for that rotation day
//      c. Convert local start times to UTC using site timezone
//      d. Compute businessDate using pattern's useEndDateForBusinessDate
//   3. Batch insert all new ShiftInstance rows

import prisma from "@rw/db";
import { getSiteTimezone, getLocalCalendarDate } from "../../metrics/bucket.js";

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

const DEFAULT_LOOKAHEAD_DAYS = 7;

// ── Types ────────────────────────────────────────────────────────

export interface ShiftBoundaryCandidate {
  siteId: string;
  workCenterId: string | null;
  startTime: Date;
  endTime: Date;
}

export interface MaterializeResult {
  /** Number of ShiftInstance rows created (0 if all already existed). */
  created: number;
  /** All candidate shift windows (including pre-existing) for boundary scheduling. */
  candidates: ShiftBoundaryCandidate[];
}

export interface ReconcileResult {
  /** Number of new ShiftInstance rows created for the new assignment. */
  created: number;
  /** Number of old ShiftInstance rows deleted (not in use). */
  deleted: number;
  /** Number of old ShiftInstance rows preserved (in use by MetricBucket or ItemDispositionLog). */
  preserved: number;
}

/** Shape of a single ShiftInstance row before insertion. */
interface InstanceRow {
  assignmentId: string;
  definitionId: string;
  siteId: string;
  workCenterId: string | null;
  shiftName: string;
  businessDate: Date;
  startTime: Date;
  endTime: Date;
}

/** Minimal assignment shape needed by the materialization helpers. */
interface AssignmentWithPattern {
  id: string;
  siteId: string;
  workCenterId: string | null;
  rotationStartDate: Date;
  rotationEndDate: Date | null;
  rotationStartDefinition: {
    dayOfRotation: number;
    sortOrder: number;
  } | null;
  pattern: {
    totalDaysInRotation: number;
    useEndDateForBusinessDate: boolean;
    shifts: Array<{
      id: string;
      dayOfRotation: number;
      sortOrder: number;
      startDayOffset: number;
      startTime: string;
      durationHrs: number;
      shiftName: string;
    }>;
  };
}

/** A reserved time window that new shifts must not overlap with. */
interface ReservedWindow {
  startMs: number;
  endMs: number;
}

// ── Include used to fetch assignments with everything we need ────

const assignmentIncludeForMaterialize = {
  pattern: {
    include: {
      shifts: {
        orderBy: { sortOrder: "asc" as const },
      },
    },
  },
  rotationStartDefinition: {
    select: {
      dayOfRotation: true,
      sortOrder: true,
    },
  },
};

// ── Public API ───────────────────────────────────────────────────

/**
 * Materialize ShiftInstance rows for all active assignments.
 *
 * Ensures concrete, pre-computed shift windows exist for the next
 * `lookaheadDays` days so that the metrics system can resolve shifts
 * via simple indexed lookups.
 *
 * Safe to call frequently — uses skipDuplicates to avoid inserting
 * rows that already exist.
 */
export async function materializeShiftInstances(options?: { lookaheadDays?: number }): Promise<MaterializeResult> {
  const lookaheadDays = options?.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS;
  const now = new Date();
  const todayMs = Math.floor(now.getTime() / MS_PER_DAY) * MS_PER_DAY;
  const today = new Date(todayMs);

  const assignments = await prisma.shiftAssignment.findMany({
    where: {
      OR: [{ rotationEndDate: null }, { rotationEndDate: { gte: today } }],
    },
    include: assignmentIncludeForMaterialize,
  });

  if (assignments.length === 0) {
    return { created: 0, candidates: [] };
  }

  const allRows: InstanceRow[] = [];
  for (const assignment of assignments) {
    const timezone = await getSiteTimezone(assignment.siteId);
    // Start 1 day before UTC today to ensure shifts for the current
    // local business day are materialized even when the UTC date is
    // ahead of the site's local date (e.g., 9pm ET = next day UTC).
    const fromMs = todayMs - MS_PER_DAY;
    const rows = buildInstanceRows(assignment, fromMs, lookaheadDays + 1, [], timezone);
    allRows.push(...rows);
  }

  const candidates: ShiftBoundaryCandidate[] = allRows.map((r) => ({
    siteId: r.siteId,
    workCenterId: r.workCenterId,
    startTime: r.startTime,
    endTime: r.endTime,
  }));

  if (allRows.length === 0) {
    return { created: 0, candidates };
  }

  const result = await prisma.shiftInstance.createMany({
    data: allRows,
    skipDuplicates: true,
  });

  return { created: result.count, candidates };
}

/**
 * Reconcile ShiftInstances when a new assignment is created or an
 * existing assignment's start parameters change.
 *
 * Handles the full transition between old and new shift schedules:
 *   1. Finds overlapping old assignments for the same (siteId, workCenterId)
 *   2. Auto-sets rotationEndDate on old assignments
 *   3. Identifies which old ShiftInstances are "in use" (referenced by
 *      MetricBucket or ItemDispositionLog)
 *   4. Deletes unused old instances from the new assignment's start onward
 *   5. Materializes the new assignment's shifts, skipping any that overlap
 *      with preserved (in-use) old instances
 */
export async function reconcileShiftInstances(assignmentId: string): Promise<ReconcileResult> {
  const now = new Date();
  const todayMs = Math.floor(now.getTime() / MS_PER_DAY) * MS_PER_DAY;

  // ── 1. Load the new assignment with pattern + shifts ──────────
  const newAssignment = await prisma.shiftAssignment.findUnique({
    where: { id: assignmentId },
    include: assignmentIncludeForMaterialize,
  });

  if (!newAssignment) {
    return { created: 0, deleted: 0, preserved: 0 };
  }

  const timezone = await getSiteTimezone(newAssignment.siteId);

  // ── 2. Find overlapping old assignments for same scope ────────
  const oldAssignments = await prisma.shiftAssignment.findMany({
    where: {
      id: { not: newAssignment.id },
      siteId: newAssignment.siteId,
      workCenterId: newAssignment.workCenterId,
      OR: [{ rotationEndDate: null }, { rotationEndDate: { gte: newAssignment.rotationStartDate } }],
    },
    select: { id: true, rotationEndDate: true },
  });

  let deleted = 0;
  let preserved = 0;
  const reservedWindows: ReservedWindow[] = [];

  if (oldAssignments.length > 0) {
    const oldAssignmentIds = oldAssignments.map((a) => a.id);

    // ── 3. Auto-end old assignments ───────────────────────────
    await prisma.shiftAssignment.updateMany({
      where: {
        id: { in: oldAssignmentIds },
        OR: [{ rotationEndDate: null }, { rotationEndDate: { gt: newAssignment.rotationStartDate } }],
      },
      data: {
        rotationEndDate: newAssignment.rotationStartDate,
      },
    });

    // ── 4. Find old ShiftInstances from new start onward ──────
    const oldInstances = await prisma.shiftInstance.findMany({
      where: {
        assignmentId: { in: oldAssignmentIds },
        // Any instance whose time window intersects the new assignment's
        // effective period: endTime > newStartDate (started before but
        // extends into) OR startTime >= newStartDate (starts after)
        endTime: { gt: newAssignment.rotationStartDate },
      },
      select: {
        id: true,
        startTime: true,
        endTime: true,
      },
    });

    if (oldInstances.length > 0) {
      const oldInstanceIds = oldInstances.map((i) => i.id);

      // ── 5. Check which are "in use" ──────────────────────────
      const inUseIds = await findInUseShiftInstanceIds(oldInstanceIds);

      const toDelete: string[] = [];
      for (const instance of oldInstances) {
        if (inUseIds.has(instance.id)) {
          // Preserve: record its time window so new shifts avoid it
          preserved++;
          reservedWindows.push({
            startMs: instance.startTime.getTime(),
            endMs: instance.endTime.getTime(),
          });
        } else {
          toDelete.push(instance.id);
        }
      }

      // ── 6. Delete unused old instances ─────────────────────
      if (toDelete.length > 0) {
        const deleteResult = await prisma.shiftInstance.deleteMany({
          where: { id: { in: toDelete } },
        });
        deleted = deleteResult.count;
      }
    }
  }

  // ── 7. Materialize new assignment's shifts ──────────────────
  // Start 1 day before UTC today to cover the current local business day
  const fromMs = todayMs - MS_PER_DAY;
  const rows = buildInstanceRows(newAssignment, fromMs, DEFAULT_LOOKAHEAD_DAYS + 1, reservedWindows, timezone);

  let created = 0;
  if (rows.length > 0) {
    const result = await prisma.shiftInstance.createMany({
      data: rows,
      skipDuplicates: true,
    });
    created = result.count;
  }

  return { created, deleted, preserved };
}

// ── Core Materialization Logic ──────────────────────────────────

/**
 * Build ShiftInstance rows for a single assignment over a date range.
 *
 * @param assignment      - The assignment with its pattern and shifts
 * @param fromDayMs       - Start of the date range (UTC midnight ms)
 * @param lookaheadDays   - How many days forward to generate
 * @param reservedWindows - Optional time windows to avoid (from preserved old shifts)
 * @returns Array of instance rows ready for insertion
 */
function buildInstanceRows(
  assignment: AssignmentWithPattern,
  fromDayMs: number,
  lookaheadDays: number,
  reservedWindows: ReservedWindow[] = [],
  timezone: string = "UTC",
): InstanceRow[] {
  const { pattern } = assignment;
  const rotationStartMs = floorToDay(assignment.rotationStartDate).getTime();
  const rows: InstanceRow[] = [];

  for (let dayOffset = 0; dayOffset <= lookaheadDays; dayOffset++) {
    const targetMs = fromDayMs + dayOffset * MS_PER_DAY;
    const targetDate = new Date(targetMs);

    // Skip dates before the assignment takes effect
    if (targetMs < rotationStartMs) continue;

    // Skip dates after the assignment ends
    if (assignment.rotationEndDate) {
      const endMs = floorToDay(assignment.rotationEndDate).getTime();
      if (targetMs > endMs) continue;
    }

    // Compute which rotation day applies
    const startDay = assignment.rotationStartDefinition?.dayOfRotation ?? 1;
    const daysSinceStart = Math.floor((targetMs - rotationStartMs) / MS_PER_DAY);
    const rotationDay = ((daysSinceStart + startDay - 1) % pattern.totalDaysInRotation) + 1;

    // Get shift definitions for this rotation day
    let defsForDay = pattern.shifts.filter((d) => d.dayOfRotation === rotationDay);
    if (defsForDay.length === 0) continue;

    // On the first day, skip shifts before the start definition
    if (daysSinceStart === 0 && assignment.rotationStartDefinition) {
      const minSortOrder = assignment.rotationStartDefinition.sortOrder;
      defsForDay = defsForDay.filter((d) => d.sortOrder >= minSortOrder);
      if (defsForDay.length === 0) continue;
    }

    // Compute UTC start/end for each shift definition
    const shiftsForDay: Array<{
      definition: (typeof defsForDay)[0];
      utcStartMs: number;
      utcEndMs: number;
    }> = [];

    for (const def of defsForDay) {
      const { utcStartMs, utcEndMs } = computeShiftUtcTimes(
        targetMs,
        def.startDayOffset,
        def.startTime,
        def.durationHrs,
      );

      // Skip shifts that overlap with reserved windows (in-use old shifts)
      if (reservedWindows.length > 0 && overlapsAny(utcStartMs, utcEndMs, reservedWindows)) {
        continue;
      }

      shiftsForDay.push({ definition: def, utcStartMs, utcEndMs });
    }

    if (shiftsForDay.length === 0) continue;

    // Compute business date using local calendar dates (not UTC)
    const businessDate = computeBusinessDate(
      targetDate,
      shiftsForDay.map((s) => s.utcEndMs),
      pattern.useEndDateForBusinessDate,
      timezone,
    );

    // Build instance data for each shift
    for (const { definition, utcStartMs, utcEndMs } of shiftsForDay) {
      rows.push({
        assignmentId: assignment.id,
        definitionId: definition.id,
        siteId: assignment.siteId,
        workCenterId: assignment.workCenterId,
        shiftName: definition.shiftName,
        businessDate,
        startTime: new Date(utcStartMs),
        endTime: new Date(utcEndMs),
      });
    }
  }

  return rows;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Find which ShiftInstance IDs are "in use" — referenced by at least
 * one MetricBucket or ItemDispositionLog row.
 *
 * Uses two batched queries instead of N individual lookups.
 */
async function findInUseShiftInstanceIds(instanceIds: string[]): Promise<Set<string>> {
  if (instanceIds.length === 0) return new Set();

  // MetricBucket.shiftInstanceId has no FK constraint — raw query for DISTINCT
  const metricRefs = await prisma.$queryRawUnsafe<Array<{ shiftInstanceId: string }>>(
    `SELECT DISTINCT "shiftInstanceId" FROM "MetricBucket"
     WHERE "shiftInstanceId" = ANY($1::uuid[])`,
    instanceIds,
  );

  // ItemDispositionLog.shiftInstanceId has a real FK
  const dispositionRefs = await prisma.$queryRawUnsafe<Array<{ shiftInstanceId: string }>>(
    `SELECT DISTINCT "shiftInstanceId" FROM "ItemDispositionLog"
     WHERE "shiftInstanceId" = ANY($1::uuid[])`,
    instanceIds,
  );

  const inUse = new Set<string>();
  for (const row of metricRefs) inUse.add(row.shiftInstanceId);
  for (const row of dispositionRefs) inUse.add(row.shiftInstanceId);

  return inUse;
}

/**
 * Check whether a time window [startMs, endMs) overlaps with any
 * of the reserved windows.
 *
 * Two windows overlap if: startA < endB AND endA > startB
 */
function overlapsAny(startMs: number, endMs: number, windows: ReservedWindow[]): boolean {
  for (const w of windows) {
    if (startMs < w.endMs && endMs > w.startMs) return true;
  }
  return false;
}

/**
 * Floor a Date to UTC midnight (start of day).
 */
function floorToDay(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MS_PER_DAY) * MS_PER_DAY);
}

/**
 * Parse a "HH:mm" time string into milliseconds since midnight.
 */
function parseLocalTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * MS_PER_HOUR + minutes * MS_PER_MINUTE;
}

/**
 * Compute the absolute UTC start and end times for a shift definition
 * on a given target date.
 *
 * ShiftDefinition.startTime is stored as UTC "HH:mm" — the frontend
 * converts from the user's local timezone to UTC before saving.
 *
 * @param targetDayMs   - The target date as UTC midnight ms
 * @param startDayOffset - Number of calendar days after targetDay the shift starts
 * @param startTimeStr  - UTC start time in "HH:mm" format
 * @param durationHrs   - Shift duration in fractional hours
 */
function computeShiftUtcTimes(
  targetDayMs: number,
  startDayOffset: number,
  startTimeStr: string,
  durationHrs: number,
): { utcStartMs: number; utcEndMs: number } {
  const timeMs = parseLocalTime(startTimeStr);
  const utcStartMs = targetDayMs + startDayOffset * MS_PER_DAY + timeMs;
  const utcEndMs = utcStartMs + durationHrs * MS_PER_HOUR;

  return { utcStartMs, utcEndMs };
}

/**
 * Compute the business date for a block of shifts on a rotation day.
 *
 * Uses the site's timezone to determine the LOCAL calendar date, not
 * the UTC date. This matters when shifts cross UTC midnight but not
 * local midnight (e.g., a shift ending at 03:00 UTC is still April 9
 * in America/New_York because 03:00 UTC = 11:00 PM ET on April 9).
 *
 * @param targetDate                - The rotation day's anchor date
 * @param shiftEndTimesMs           - UTC end times of all shifts on this day
 * @param useEndDateForBusinessDate - Pattern flag controlling the rule
 * @param timezone                  - IANA timezone string (e.g., "America/New_York")
 */
function computeBusinessDate(
  targetDate: Date,
  shiftEndTimesMs: number[],
  useEndDateForBusinessDate: boolean,
  timezone: string,
): Date {
  if (!useEndDateForBusinessDate) {
    // Business date = local calendar date of the rotation day anchor
    return getLocalCalendarDate(targetDate, timezone);
  }

  // Business date = local calendar date when the LAST shift ends
  const lastEndMs = Math.max(...shiftEndTimesMs);
  return getLocalCalendarDate(new Date(lastEndMs), timezone);
}
