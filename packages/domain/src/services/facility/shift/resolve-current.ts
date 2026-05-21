import prisma from "@rw/db";
import { resolveEntityPath } from "../../metrics/hierarchy.js";
import { MetricsContext } from "../../metrics/context.js";
import { publishCurrentShiftMetric } from "../station/state.js";

interface StationShiftRow {
  stationId: string;
  siteId: string;
  stationName: string;
  shiftName: string | null;
  shiftInstanceId: string | null;
}

interface WorkcenterShiftRow {
  workcenterId: string;
  siteId: string;
  workcenterName: string;
  shiftName: string | null;
  shiftInstanceId: string | null;
}

/**
 * Resolve the active shift for every non-deleted station and workcenter and
 * publish live `currentShift` / `currentShiftInstanceId` events for each.
 *
 * Two separate queries:
 * - Per-station (workcenter shift takes precedence over site fallback)
 * - Per-workcenter (workcenter shift takes precedence over site fallback)
 *
 * Workcenter-scoped events let dashboards that aggregate at the workcenter
 * level (e.g. operator screen) subscribe at the workcenter entity instead of
 * arbitrarily picking a station to listen on.
 *
 * Returns the combined number of events published (stations + workcenters).
 *
 * Read-only — no DB writes.
 */
export async function publishCurrentShiftForStations(): Promise<number> {
  const now = new Date();

  const [stationRows, workcenterRows] = await Promise.all([
    prisma.$queryRaw<StationShiftRow[]>`
      SELECT
        s.id            AS "stationId",
        s."siteId",
        s.name          AS "stationName",
        COALESCE(wc_shift."shiftName", site_shift."shiftName")             AS "shiftName",
        COALESCE(wc_shift."shiftInstanceId", site_shift."shiftInstanceId") AS "shiftInstanceId"
      FROM "Station" s
      LEFT JOIN LATERAL (
        SELECT si.id AS "shiftInstanceId", si."shiftName"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."workCenterId" = s."workcenterId"
          AND si."startTime" <= ${now}
          AND si."endTime"   >  ${now}
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) wc_shift ON true
      LEFT JOIN LATERAL (
        SELECT si.id AS "shiftInstanceId", si."shiftName"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."siteId" = s."siteId"
          AND si."workCenterId" IS NULL
          AND si."startTime" <= ${now}
          AND si."endTime"   >  ${now}
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) site_shift ON wc_shift."shiftName" IS NULL
      WHERE s."deletedAt" IS NULL
    `,
    prisma.$queryRaw<WorkcenterShiftRow[]>`
      SELECT
        wc.id           AS "workcenterId",
        wc."siteId",
        wc.name         AS "workcenterName",
        COALESCE(wc_shift."shiftName", site_shift."shiftName")             AS "shiftName",
        COALESCE(wc_shift."shiftInstanceId", site_shift."shiftInstanceId") AS "shiftInstanceId"
      FROM "Workcenter" wc
      LEFT JOIN LATERAL (
        SELECT si.id AS "shiftInstanceId", si."shiftName"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."workCenterId" = wc.id
          AND si."startTime" <= ${now}
          AND si."endTime"   >  ${now}
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) wc_shift ON true
      LEFT JOIN LATERAL (
        SELECT si.id AS "shiftInstanceId", si."shiftName"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."siteId" = wc."siteId"
          AND si."workCenterId" IS NULL
          AND si."startTime" <= ${now}
          AND si."endTime"   >  ${now}
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) site_shift ON wc_shift."shiftName" IS NULL
    `,
  ]);

  if (stationRows.length === 0 && workcenterRows.length === 0) return 0;

  const ctx = new MetricsContext();

  for (const row of stationRows) {
    const path = await resolveEntityPath("STATION", row.stationId, row.siteId, undefined, ctx);
    publishCurrentShiftMetric(
      "STATION",
      row.stationId,
      row.siteId,
      row.stationName,
      path,
      row.shiftName,
      row.shiftInstanceId,
      now,
    );
  }

  for (const row of workcenterRows) {
    const path = await resolveEntityPath("WORKCENTER", row.workcenterId, row.siteId, undefined, ctx);
    publishCurrentShiftMetric(
      "WORKCENTER",
      row.workcenterId,
      row.siteId,
      row.workcenterName,
      path,
      row.shiftName,
      row.shiftInstanceId,
      now,
    );
  }

  return stationRows.length + workcenterRows.length;
}
