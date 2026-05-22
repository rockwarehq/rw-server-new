// Resolve the current business date and active shift for a site,
// optionally scoped to a specific workcenter.
//
// Resolution priority (mirrors metrics/shift.ts):
//   1. Workcenter-level ShiftInstance (if workCenterId provided)
//   2. Site-level ShiftInstance (workCenterId IS NULL)
//   3. No active shift — business date derived from site timezone

import prisma from "@rw/db";
import { getLocalCalendarDate } from "@rw/services/metrics/bucket";

export interface CurrentShiftResult {
  businessDate: string; // ISO date e.g. "2026-03-19"
  shift: {
    shiftInstanceId: string;
    shiftName: string;
    startTime: string; // ISO datetime
    endTime: string; // ISO datetime
  } | null;
  timezone: string;
}

/**
 * Get the current business date and active shift for a site.
 *
 * When a workCenterId is provided, workcenter-level shift assignments
 * are checked first before falling back to site-level assignments.
 *
 * When no shift covers the current time, the business date is derived
 * from the site's IANA timezone (local calendar date).
 */
export async function getCurrentShift(
  siteId: string,
  workCenterId?: string,
): Promise<{ success: true; data: CurrentShiftResult } | { error: string; code: string }> {
  // 1. Look up site for timezone
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { timezone: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  const now = new Date();
  const { timezone } = site;

  // 2. Try workcenter-level ShiftInstance first
  if (workCenterId) {
    const wcInstance = await prisma.shiftInstance.findFirst({
      where: {
        workCenterId,
        startTime: { lte: now },
        endTime: { gt: now },
      },
      orderBy: { assignment: { rotationStartDate: "desc" } },
    });

    if (wcInstance) {
      return {
        success: true,
        data: {
          businessDate: formatDate(wcInstance.businessDate),
          shift: {
            shiftInstanceId: wcInstance.id,
            shiftName: wcInstance.shiftName,
            startTime: wcInstance.startTime.toISOString(),
            endTime: wcInstance.endTime.toISOString(),
          },
          timezone,
        },
      };
    }
  }

  // 3. Fall back to site-level ShiftInstance
  const siteInstance = await prisma.shiftInstance.findFirst({
    where: {
      siteId,
      workCenterId: null,
      startTime: { lte: now },
      endTime: { gt: now },
    },
    orderBy: { assignment: { rotationStartDate: "desc" } },
  });

  if (siteInstance) {
    return {
      success: true,
      data: {
        businessDate: formatDate(siteInstance.businessDate),
        shift: {
          shiftInstanceId: siteInstance.id,
          shiftName: siteInstance.shiftName,
          startTime: siteInstance.startTime.toISOString(),
          endTime: siteInstance.endTime.toISOString(),
        },
        timezone,
      },
    };
  }

  // 4. No active shift — derive business date from local calendar date
  const businessDate = getLocalCalendarDate(now, timezone);

  return {
    success: true,
    data: {
      businessDate: formatDate(businessDate),
      shift: null,
      timezone,
    },
  };
}

/** Format a Date as an ISO date string (YYYY-MM-DD). */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
