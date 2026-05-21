// Shift resolution — queries ShiftInstance rows from the database.
//
// Resolution priority:
//   1. Workcenter-level ShiftInstance (if entity is a STATION with a workcenter,
//      or a WORKCENTER directly)
//   2. Site-level ShiftInstance (workCenterId IS NULL)
//   3. null (no shift schedule — callers fall back to clock-aligned buckets)
//
// Two layers of caching:
//   1. Per-pipeline (MetricsContext): eliminates redundant lookups within a
//      single pipeline run (cycle completion, background-worker tick).
//   2. Process-level TTL cache: shares results across independent pipeline
//      runs. ShiftInstance data is stable for the duration of a shift (hours),
//      so even a short TTL (30s) dramatically reduces DB queries.
//
// All async functions accept an optional MetricsContext for per-pipeline
// caching. When provided, DB lookups are cached and reused within the
// same pipeline execution.

import prisma from "@rw/db";
import type { MetricsContext } from "./context.js";
import { TtlCache } from "./ttl-cache.js";

// ── Process-level TTL caches ─────────────────────────────────────
// These survive across pipeline executions. A 30-second TTL is very
// conservative — ShiftInstance rows don't change mid-shift.

const SHIFT_TTL_MS = 30_000;
const SHIFT_CACHE_MAX = 2_000;

/** Sentinel for "we queried and got null". */
const NULL_SHIFT = Symbol("nullShift");
type CachedShift = ShiftWindow | typeof NULL_SHIFT;

const processShiftCache = new TtlCache<CachedShift>({ ttlMs: SHIFT_TTL_MS, maxSize: SHIFT_CACHE_MAX });
const processAnchorCache = new TtlCache<Date>({ ttlMs: SHIFT_TTL_MS, maxSize: SHIFT_CACHE_MAX });
const processWcIdCache = new TtlCache<string | typeof NULL_SHIFT>({ ttlMs: 60_000, maxSize: 500 });

/** Clear all process-level caches (for testing). */
export function clearProcessCaches(): void {
  processShiftCache.clear();
  processAnchorCache.clear();
  processWcIdCache.clear();
}

export interface ShiftWindow {
  shiftName: string;
  startTime: Date;
  durationSeconds: number;
  /** ID of the ShiftInstance row this window was resolved from. */
  shiftInstanceId: string;
}

export interface HourBucket {
  startTime: Date;
  durationSeconds: number;
}

const MS_PER_HOUR = 3_600_000;

// ── Shift resolution (DB-driven) ─────────────────────────────────

type EntityType = "STATION" | "WORKCENTER" | "SITE" | "JOB";

/**
 * Resolve the shift for a specific entity at a given timestamp.
 *
 * Queries ShiftInstance rows from the database. Resolution order:
 *   1. If entity is a STATION, look up its workcenterId. If it has one,
 *      check for a workcenter-level ShiftInstance first.
 *   2. If entity is a WORKCENTER, check for a workcenter-level ShiftInstance.
 *   3. Fall back to site-level ShiftInstance (workCenterId IS NULL).
 *   4. Return null if no ShiftInstance covers this timestamp.
 *
 * @param entityType - STATION, WORKCENTER, SITE, or JOB
 * @param entityId   - The entity's UUID
 * @param siteId     - The site this entity belongs to
 * @param timestamp  - The point in time to resolve
 * @param ctx        - Optional per-pipeline cache
 */
export async function getShiftForEntity(
  entityType: EntityType,
  entityId: string,
  siteId: string,
  timestamp: Date,
  ctx?: MetricsContext,
): Promise<ShiftWindow | null> {
  // Layer 1: per-pipeline cache (free, no TTL overhead)
  if (ctx) {
    const cached = ctx.getShiftCached(entityType, entityId, siteId, timestamp);
    if (cached !== undefined) return cached;
  }

  // Layer 2: process-level TTL cache (survives across pipelines)
  const pKey = `${entityType}:${entityId}:${siteId}:${timestamp.getTime()}`;
  const processCached = processShiftCache.get(pKey);
  if (processCached !== undefined) {
    const result = processCached === NULL_SHIFT ? null : processCached;
    ctx?.setShiftCached(entityType, entityId, siteId, timestamp, result);
    return result;
  }

  // Layer 3: DB query
  const result = await queryShiftForEntity(entityType, entityId, siteId, timestamp, ctx);

  // Populate both caches
  processShiftCache.set(pKey, result ?? NULL_SHIFT);
  ctx?.setShiftCached(entityType, entityId, siteId, timestamp, result);
  return result;
}

/** DB query for shift resolution (extracted for caching layers). */
async function queryShiftForEntity(
  entityType: EntityType,
  entityId: string,
  siteId: string,
  timestamp: Date,
  ctx?: MetricsContext,
): Promise<ShiftWindow | null> {
  // Determine the workcenterId to check for overrides
  let workCenterId: string | null = null;

  if (entityType === "STATION") {
    workCenterId = await resolveWorkcenterId(entityType, entityId, ctx);
  } else if (entityType === "WORKCENTER") {
    workCenterId = entityId;
  }
  // SITE and JOB: no workcenter override, site-level only

  // 1. Try workcenter-level ShiftInstance
  //    When overlapping assignments exist, the one with the latest
  //    rotationStartDate wins (most recently effective schedule).
  if (workCenterId) {
    const wcRows = await prisma.$queryRaw<Array<{ id: string; shiftName: string; startTime: Date; endTime: Date }>>`
      SELECT si."id", si."shiftName", si."startTime", si."endTime"
      FROM "ShiftInstance" si
      JOIN "ShiftAssignment" sa ON sa."id" = si."assignmentId"
      WHERE si."workCenterId" = ${workCenterId}::uuid
        AND si."startTime" <= ${timestamp}
        AND si."endTime" > ${timestamp}
      ORDER BY sa."rotationStartDate" DESC
      LIMIT 1
    `;
    if (wcRows.length > 0) {
      const wcInstance = wcRows[0];
      return {
        shiftName: wcInstance.shiftName,
        startTime: wcInstance.startTime,
        durationSeconds: (wcInstance.endTime.getTime() - wcInstance.startTime.getTime()) / 1000,
        shiftInstanceId: wcInstance.id,
      };
    }
  }

  // 2. Fall back to site-level ShiftInstance
  const siteRows = await prisma.$queryRaw<Array<{ id: string; shiftName: string; startTime: Date; endTime: Date }>>`
    SELECT si."id", si."shiftName", si."startTime", si."endTime"
    FROM "ShiftInstance" si
    JOIN "ShiftAssignment" sa ON sa."id" = si."assignmentId"
    WHERE si."siteId" = ${siteId}::uuid
      AND si."workCenterId" IS NULL
      AND si."startTime" <= ${timestamp}
      AND si."endTime" > ${timestamp}
    ORDER BY sa."rotationStartDate" DESC
    LIMIT 1
  `;

  if (siteRows.length > 0) {
    const siteInstance = siteRows[0];
    return {
      shiftName: siteInstance.shiftName,
      startTime: siteInstance.startTime,
      durationSeconds: (siteInstance.endTime.getTime() - siteInstance.startTime.getTime()) / 1000,
      shiftInstanceId: siteInstance.id,
    };
  }

  // 3. No shift schedule
  return null;
}

/**
 * Query all ShiftInstance rows that overlap a time range for a site.
 *
 * Used by resolveHourBucketForEntity when walking a range of timestamps —
 * preloading avoids N+1 queries per bucket.
 *
 * Resolution follows the same priority: workcenter-level first, then site-level.
 * Returns instances sorted by startTime.
 */
export async function getShiftInstancesForRange(
  siteId: string,
  workCenterId: string | null,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<ShiftWindow[]> {
  // Try workcenter-level first.
  // When overlapping assignments produce duplicate instances for the same
  // startTime, DISTINCT ON + rotationStartDate DESC keeps only the newest.
  if (workCenterId) {
    const wcInstances = await prisma.$queryRaw<
      Array<{ id: string; shiftName: string; startTime: Date; endTime: Date }>
    >`
      SELECT DISTINCT ON (si."startTime")
        si."id", si."shiftName", si."startTime", si."endTime"
      FROM "ShiftInstance" si
      JOIN "ShiftAssignment" sa ON sa."id" = si."assignmentId"
      WHERE si."workCenterId" = ${workCenterId}::uuid
        AND si."startTime" < ${rangeEnd}
        AND si."endTime" > ${rangeStart}
      ORDER BY si."startTime" ASC, sa."rotationStartDate" DESC
    `;
    if (wcInstances.length > 0) {
      return wcInstances.map((i) => ({
        shiftName: i.shiftName,
        startTime: i.startTime,
        durationSeconds: (i.endTime.getTime() - i.startTime.getTime()) / 1000,
        shiftInstanceId: i.id,
      }));
    }
  }

  // Fall back to site-level
  const instances = await prisma.$queryRaw<Array<{ id: string; shiftName: string; startTime: Date; endTime: Date }>>`
    SELECT DISTINCT ON (si."startTime")
      si."id", si."shiftName", si."startTime", si."endTime"
    FROM "ShiftInstance" si
    JOIN "ShiftAssignment" sa ON sa."id" = si."assignmentId"
    WHERE si."siteId" = ${siteId}::uuid
      AND si."workCenterId" IS NULL
      AND si."startTime" < ${rangeEnd}
      AND si."endTime" > ${rangeStart}
    ORDER BY si."startTime" ASC, sa."rotationStartDate" DESC
  `;

  return instances.map((i) => ({
    shiftName: i.shiftName,
    startTime: i.startTime,
    durationSeconds: (i.endTime.getTime() - i.startTime.getTime()) / 1000,
    shiftInstanceId: i.id,
  }));
}

// ── Hour bucket helpers (shift-aligned) ──────────────────────────

/**
 * Compute the business-day anchor time for a given shift.
 *
 * The anchor is the start of the first shift on the same business date.
 * Hour buckets are aligned to this point and tick every 60 minutes from it.
 *
 * For the first shift of the day, the anchor is its own start time.
 * For later shifts, the anchor is the first shift's start from the
 * same business day.
 *
 * We derive this from the ShiftInstance's businessDate + the earliest
 * shift on that date. When ShiftInstance data is unavailable (e.g. for
 * the pure-computation path), falls back to using the shift's own start
 * floored to the earliest shift of the day.
 */
async function getAnchorTime(
  shift: ShiftWindow,
  siteId: string,
  workCenterId: string | null,
  ctx?: MetricsContext,
): Promise<Date> {
  // Layer 1: per-pipeline cache
  if (ctx) {
    const cached = ctx.getAnchorCached(shift, siteId, workCenterId);
    if (cached !== undefined) return cached;
  }

  // Layer 2: process-level TTL cache
  const aKey = `a:${shift.startTime.getTime()}:${siteId}:${workCenterId ?? "null"}`;
  const processCached = processAnchorCache.get(aKey);
  if (processCached !== undefined) {
    ctx?.setAnchorCached(shift, siteId, workCenterId, processCached);
    return processCached;
  }

  // Layer 3: DB query — result is cached below
  // Query the earliest ShiftInstance on the same business date.
  // First, find the current shift instance to get the businessDate.
  //
  // Resolution priority mirrors getShiftForEntity:
  //   1. workcenter-level ShiftInstance (if workCenterId is non-null)
  //   2. site-level ShiftInstance (workCenterId IS NULL)
  //   3. fallback: shift's own startTime

  let currentInstance: { businessDate: Date } | null = null;

  // 1. Try workcenter-level
  if (workCenterId) {
    const rows = await prisma.$queryRaw<Array<{ businessDate: Date }>>`
      SELECT si."businessDate"
      FROM "ShiftInstance" si
      JOIN "ShiftAssignment" sa ON sa."id" = si."assignmentId"
      WHERE si."siteId" = ${siteId}::uuid
        AND si."workCenterId" = ${workCenterId}::uuid
        AND si."startTime" = ${shift.startTime}
      ORDER BY sa."rotationStartDate" DESC
      LIMIT 1
    `;
    currentInstance = rows[0] ?? null;
  }

  // 2. Fall back to site-level
  if (!currentInstance) {
    const rows = await prisma.$queryRaw<Array<{ businessDate: Date }>>`
      SELECT si."businessDate"
      FROM "ShiftInstance" si
      JOIN "ShiftAssignment" sa ON sa."id" = si."assignmentId"
      WHERE si."siteId" = ${siteId}::uuid
        AND si."workCenterId" IS NULL
        AND si."startTime" = ${shift.startTime}
      ORDER BY sa."rotationStartDate" DESC
      LIMIT 1
    `;
    currentInstance = rows[0] ?? null;
  }

  if (currentInstance) {
    // Find the first shift on this business date (same resolution priority).
    // rotationStartDate DESC tiebreaker ensures we pick from the newest
    // assignment if duplicates exist for the same startTime.
    let firstShift: { startTime: Date } | null = null;

    if (workCenterId) {
      const rows = await prisma.$queryRaw<Array<{ startTime: Date }>>`
        SELECT si."startTime"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa."id" = si."assignmentId"
        WHERE si."siteId" = ${siteId}::uuid
          AND si."workCenterId" = ${workCenterId}::uuid
          AND si."businessDate" = ${currentInstance.businessDate}
        ORDER BY si."startTime" ASC, sa."rotationStartDate" DESC
        LIMIT 1
      `;
      firstShift = rows[0] ?? null;
    }

    if (!firstShift) {
      const rows = await prisma.$queryRaw<Array<{ startTime: Date }>>`
        SELECT si."startTime"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa."id" = si."assignmentId"
        WHERE si."siteId" = ${siteId}::uuid
          AND si."workCenterId" IS NULL
          AND si."businessDate" = ${currentInstance.businessDate}
        ORDER BY si."startTime" ASC, sa."rotationStartDate" DESC
        LIMIT 1
      `;
      firstShift = rows[0] ?? null;
    }

    if (firstShift) {
      processAnchorCache.set(aKey, firstShift.startTime);
      ctx?.setAnchorCached(shift, siteId, workCenterId, firstShift.startTime);
      return firstShift.startTime;
    }
  }

  // Fallback: use the shift's own startTime as anchor.
  // This is correct for the first shift but may be wrong for later shifts.
  processAnchorCache.set(aKey, shift.startTime);
  ctx?.setAnchorCached(shift, siteId, workCenterId, shift.startTime);
  return shift.startTime;
}

/**
 * Generate all hour bucket windows for a shift, aligned to the
 * business-day anchor.
 *
 * Hours tick every 60 minutes from the anchor (first shift of the day).
 * The first bucket in a shift may be partial (completing the hour
 * from the previous shift), and the last bucket may be partial
 * (the remaining time before the shift ends).
 *
 * Exception: The first shift always starts on the anchor, so its first
 * hour is always a full 60 minutes.
 */
export function getHourBucketsForShift(shift: ShiftWindow, anchorMs: number): HourBucket[] {
  const shiftStartMs = shift.startTime.getTime();
  const shiftEndMs = shiftStartMs + shift.durationSeconds * 1000;

  // Find the first grid line at or before shiftStart
  // Grid ticks: anchor, anchor+1h, anchor+2h, ...
  const msSinceAnchor = shiftStartMs - anchorMs;
  const fullHoursBefore = Math.floor(msSinceAnchor / MS_PER_HOUR);
  let gridCursor = anchorMs + fullHoursBefore * MS_PER_HOUR;

  // If the grid cursor is before the shift start (shift doesn't start
  // on a grid line), the first bucket starts at shiftStart and ends
  // at the next grid line.
  if (gridCursor < shiftStartMs) {
    gridCursor += MS_PER_HOUR;
  }

  const buckets: HourBucket[] = [];

  // Partial first bucket: shiftStart → first grid line
  if (gridCursor > shiftStartMs && gridCursor <= shiftEndMs) {
    buckets.push({
      startTime: new Date(shiftStartMs),
      durationSeconds: (gridCursor - shiftStartMs) / 1000,
    });
  } else if (gridCursor > shiftEndMs) {
    // Entire shift fits within one grid hour — single partial bucket
    buckets.push({
      startTime: new Date(shiftStartMs),
      durationSeconds: shift.durationSeconds,
    });
    return buckets;
  }

  // Full hour buckets on the grid
  while (gridCursor + MS_PER_HOUR <= shiftEndMs) {
    buckets.push({
      startTime: new Date(gridCursor),
      durationSeconds: 3600,
    });
    gridCursor += MS_PER_HOUR;
  }

  // Partial last bucket: last grid line → shiftEnd
  if (gridCursor < shiftEndMs) {
    buckets.push({
      startTime: new Date(gridCursor),
      durationSeconds: (shiftEndMs - gridCursor) / 1000,
    });
  }

  return buckets;
}

// ── Clock-hour helpers (no shift schedule) ───────────────────────
// When an entity has no shift assignment, hour buckets are
// clock-aligned to local midnight (based on site timezone).

/**
 * Get the UTC offset in milliseconds for a given IANA timezone
 * at a specific point in time. Handles DST transitions correctly.
 */
export function getTimezoneOffsetMs(timezone: string, date: Date): number {
  // Format the date in the target timezone to extract components
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);

  // Construct a UTC date from the local components
  const localAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  );

  // offset = localTime - utcTime
  return localAsUtc - date.getTime();
}

/**
 * Get the start of the local day (midnight) for a timestamp,
 * expressed in UTC. Uses the site's IANA timezone (e.g. "Africa/Johannesburg").
 *
 * For UTC+2: local midnight = 22:00 UTC previous calendar day.
 * e.g., 2026-03-05 15:00 UTC → local 17:00 → local midnight
 *       = 2026-03-05 00:00 local → 2026-03-04 22:00 UTC
 *
 * Handles DST correctly: the offset is computed at the given timestamp,
 * then again verified at the resulting midnight.
 */
export function getLocalMidnightUTC(timestamp: Date, timezone: string): Date {
  // Floor to the nearest second before computing the timezone offset.
  // Intl.DateTimeFormat only has second precision, so sub-second input
  // causes the offset to be wrong by up to 999ms — which leaks into
  // the returned midnight value (e.g. 22:00:00.999Z instead of .000Z).
  const flooredMs = Math.floor(timestamp.getTime() / 1000) * 1000;
  const floored = new Date(flooredMs);

  const offsetMs = getTimezoneOffsetMs(timezone, floored);
  // Convert to local time, floor to day, convert back to UTC
  const localMs = flooredMs + offsetMs;
  const MS_PER_DAY = 86_400_000;
  const localDayMs = Math.floor(localMs / MS_PER_DAY) * MS_PER_DAY;
  return new Date(localDayMs - offsetMs);
}

/**
 * Generate 24 clock-aligned hour buckets for the local day
 * containing the timestamp. Each bucket is a full 60 minutes.
 *
 * Used when an entity has no shift schedule.
 */
export function getClockHourBucketsForDay(timestamp: Date, timezone: string): HourBucket[] {
  const midnight = getLocalMidnightUTC(timestamp, timezone);
  const midnightMs = midnight.getTime();
  const buckets: HourBucket[] = [];

  for (let i = 0; i < 24; i++) {
    buckets.push({
      startTime: new Date(midnightMs + i * MS_PER_HOUR),
      durationSeconds: 3600,
    });
  }

  return buckets;
}

/**
 * Resolve which clock-aligned hour bucket a timestamp falls in.
 *
 * Used when an entity has no shift schedule.
 */
export function resolveClockHourBucket(timestamp: Date, timezone: string): HourBucket {
  const midnight = getLocalMidnightUTC(timestamp, timezone);
  const msSinceMidnight = timestamp.getTime() - midnight.getTime();
  const hourIndex = Math.floor(msSinceMidnight / MS_PER_HOUR);
  return {
    startTime: new Date(midnight.getTime() + hourIndex * MS_PER_HOUR),
    durationSeconds: 3600,
  };
}

// ── Entity-aware wrappers ────────────────────────────────────────

/**
 * Resolve the workcenterId for an entity (for shift instance lookup).
 * Returns null for SITE and JOB entities, the entityId itself for
 * WORKCENTER, and queries the station's workcenterId for STATION.
 */
async function resolveWorkcenterId(
  entityType: EntityType,
  entityId: string,
  ctx?: MetricsContext,
): Promise<string | null> {
  if (entityType === "WORKCENTER") return entityId;
  if (entityType === "STATION") {
    // Layer 1: per-pipeline cache
    if (ctx) {
      const cached = ctx.getWorkCenterIdCached(entityType, entityId);
      if (cached !== undefined) return cached;
    }

    // Layer 2: process-level TTL cache
    const wcKey = `wc:${entityId}`;
    const processCached = processWcIdCache.get(wcKey);
    if (processCached !== undefined) {
      const result = processCached === NULL_SHIFT ? null : (processCached as string);
      ctx?.setWorkCenterIdCached(entityType, entityId, result);
      return result;
    }

    // Layer 3: DB query
    const rows = await prisma.$queryRaw<Array<{ workcenterId: string | null }>>`
      SELECT "workcenterId" FROM "Station" WHERE "id" = ${entityId}::uuid LIMIT 1
    `;
    const result = rows[0]?.workcenterId ?? null;
    processWcIdCache.set(wcKey, result ?? NULL_SHIFT);
    ctx?.setWorkCenterIdCached(entityType, entityId, result);
    return result;
  }
  return null;
}

/**
 * Generate hour buckets for a specific entity.
 *
 * With shift schedule: shift-aligned hours (partial at boundaries).
 * Without: 24 clock-aligned hours from local midnight.
 */
export async function getHourBucketsForEntity(
  entityType: EntityType,
  entityId: string,
  siteId: string,
  timestamp: Date,
  timezone: string,
  ctx?: MetricsContext,
): Promise<HourBucket[]> {
  // Check cache
  if (ctx) {
    const cached = ctx.getHourBucketsCached(entityType, entityId, siteId, timestamp);
    if (cached) return cached;
  }

  const shift = await getShiftForEntity(entityType, entityId, siteId, timestamp, ctx);
  let result: HourBucket[];
  if (shift) {
    const workCenterId = await resolveWorkcenterId(entityType, entityId, ctx);
    const anchor = await getAnchorTime(shift, siteId, workCenterId, ctx);
    result = getHourBucketsForShift(shift, anchor.getTime());
  } else {
    result = getClockHourBucketsForDay(timestamp, timezone);
  }

  ctx?.setHourBucketsCached(entityType, entityId, siteId, timestamp, result);
  return result;
}

/**
 * Resolve which hour bucket a timestamp falls in, for a specific entity.
 *
 * With shift schedule: shift-aligned hour bucket.
 * Without: clock-aligned hour bucket from local midnight.
 */
export async function resolveHourBucketForEntity(
  entityType: EntityType,
  entityId: string,
  siteId: string,
  timestamp: Date,
  timezone: string,
  ctx?: MetricsContext,
): Promise<HourBucket> {
  // Check cache
  if (ctx) {
    const cached = ctx.getHourBucketCached(entityType, entityId, siteId, timestamp);
    if (cached) return cached;
  }

  const shift = await getShiftForEntity(entityType, entityId, siteId, timestamp, ctx);
  let result: HourBucket;
  if (shift) {
    const workCenterId = await resolveWorkcenterId(entityType, entityId, ctx);
    const anchor = await getAnchorTime(shift, siteId, workCenterId, ctx);
    result = findHourBucketInShift(shift, anchor.getTime(), timestamp);
  } else {
    result = resolveClockHourBucket(timestamp, timezone);
  }

  ctx?.setHourBucketCached(entityType, entityId, siteId, timestamp, result);
  return result;
}

// ── Shared helper ────────────────────────────────────────────────

function findHourBucketInShift(shift: ShiftWindow, anchorMs: number, timestamp: Date): HourBucket {
  const buckets = getHourBucketsForShift(shift, anchorMs);
  const ts = timestamp.getTime();

  for (const bucket of buckets) {
    const bucketStart = bucket.startTime.getTime();
    const bucketEnd = bucketStart + bucket.durationSeconds * 1000;
    if (ts >= bucketStart && ts < bucketEnd) {
      return bucket;
    }
  }

  throw new Error(`No hour bucket found for ${timestamp.toISOString()} in shift "${shift.shiftName}"`);
}
