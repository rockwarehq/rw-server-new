// ── Metric bucket scaffolding ────────────────────────────────────
// Ensures empty bucket rows exist so that time periods with zero
// activity still appear in queries. Also provides bucket-start
// resolution helpers.
//
// KPI population is handled by recalc.ts (updateCountBased,
// updateTimeBased, recalcAll) — this module only creates empty rows.

import prisma from "@rw/db";
import { Prisma } from "@rw/db";
import {
  getShiftForEntity,
  getHourBucketsForEntity,
  resolveHourBucketForEntity,
  getLocalMidnightUTC,
  getTimezoneOffsetMs,
} from "./shift.js";
import { scheduleNextShiftBuckets } from "../../queues/metric-buckets.js";
import { onBucketsChanged, ZERO_SNAPSHOT, type BucketChange } from "./sync.js";
import { resolveEntityPath, resolveEntityName } from "./hierarchy.js";
import { MetricsContext } from "./context.js";
import { TtlCache } from "./ttl-cache.js";

// ── Process-level timezone cache ─────────────────────────────────
// Timezones effectively never change at runtime, so a long TTL is safe.
const processTzCache = new TtlCache<string>({ ttlMs: 300_000, maxSize: 100 });

// ── Site timezone lookup ─────────────────────────────────────────

/**
 * Fetch the IANA timezone for a site. Falls back to "UTC" if the
 * site is not found (shouldn't happen in practice).
 */
export async function getSiteTimezone(siteId: string, ctx?: MetricsContext): Promise<string> {
  // Layer 1: per-pipeline cache
  if (ctx) {
    const cached = ctx.getTimezoneCached(siteId);
    if (cached !== undefined) return cached;
  }

  // Layer 2: process-level TTL cache
  const processCached = processTzCache.get(siteId);
  if (processCached !== undefined) {
    ctx?.setTimezoneCached(siteId, processCached);
    return processCached;
  }

  // Layer 3: DB query
  const rows = await prisma.$queryRaw<Array<{ timezone: string }>>`
    SELECT timezone FROM "Site" WHERE id = ${siteId}::uuid LIMIT 1
  `;
  const result = rows[0]?.timezone ?? "UTC";
  processTzCache.set(siteId, result);
  ctx?.setTimezoneCached(siteId, result);
  return result;
}

// ── Business date helpers ────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/**
 * Resolve the business date for a bucket.
 *
 * With a shift schedule: queries ShiftInstance.businessDate.
 * Without a shift schedule: computes the local calendar date from the
 * bucket's startTime using the site's IANA timezone.
 *
 * Returns a Date floored to UTC midnight (suitable for @db.Date).
 */
export async function resolveBusinessDate(
  startTime: Date,
  shiftInstanceId: string | null,
  timezone: string,
): Promise<Date> {
  if (shiftInstanceId) {
    const rows = await prisma.$queryRaw<Array<{ businessDate: Date }>>`
      SELECT "businessDate" FROM "ShiftInstance" WHERE id = ${shiftInstanceId}::uuid LIMIT 1
    `;
    if (rows[0]) return rows[0].businessDate;
  }

  // No shift schedule — derive from local calendar date.
  // Convert UTC startTime to local time, extract the calendar date.
  return getLocalCalendarDate(startTime, timezone);
}

/**
 * Get the local calendar date for a UTC timestamp.
 *
 * Unlike getLocalMidnightUTC (which returns local midnight as a UTC
 * timestamp), this returns a Date representing just the calendar date
 * in the site's timezone, floored to UTC midnight for @db.Date storage.
 *
 * Example: 2026-03-12 22:00 UTC with Africa/Johannesburg (UTC+2)
 *   → local time is 2026-03-13 00:00 SAST
 *   → business date = 2026-03-13 (stored as 2026-03-13 00:00 UTC)
 */
export function getLocalCalendarDate(timestamp: Date, timezone: string): Date {
  const offsetMs = getTimezoneOffsetMs(timezone, timestamp);
  const localMs = timestamp.getTime() + offsetMs;
  const localDayMs = Math.floor(localMs / MS_PER_DAY) * MS_PER_DAY;
  return new Date(localDayMs);
}

// ── Bucket-start helpers ─────────────────────────────────────────

/** Truncate a date to the start of its clock minute. */
function minuteFloor(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

/** Truncate a date to the start of the calendar day (UTC midnight). */
function dayFloor(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * For a given granularity, return the bucket startTime and durationSeconds
 * that contain `timestamp`.
 *
 * HOUR and SHIFT buckets are entity-aware — when DB-driven shift lookup
 * is wired up, different entities can resolve to different schedules.
 *
 * With a shift schedule: HOUR buckets are aligned to the business-day
 * anchor (Shift 1 start). SHIFT buckets match the shift window.
 *
 * Without a shift schedule: HOUR buckets are clock-aligned to local
 * midnight (using the site's IANA timezone). SHIFT granularity falls
 * back to a full local day.
 */
export async function resolveBucket(
  granularity: "MINUTE" | "HOUR" | "SHIFT" | "DAY",
  timestamp: Date,
  entityType: "STATION" | "WORKCENTER" | "SITE" | "JOB",
  entityId: string,
  siteId: string,
  timezone: string,
  ctx?: MetricsContext,
): Promise<{ startTime: Date; durationSeconds: number }> {
  switch (granularity) {
    case "MINUTE":
      return { startTime: minuteFloor(timestamp), durationSeconds: 60 };
    case "HOUR":
      return resolveHourBucketForEntity(entityType, entityId, siteId, timestamp, timezone, ctx);
    case "SHIFT": {
      const shift = await getShiftForEntity(entityType, entityId, siteId, timestamp, ctx);
      if (!shift) {
        // No shift schedule — fall back to full local day.
        return { startTime: getLocalMidnightUTC(timestamp, timezone), durationSeconds: 86400 };
      }
      return shift;
    }
    case "DAY":
      return { startTime: dayFloor(timestamp), durationSeconds: 86400 };
  }
}

// ── Ensure buckets exist ─────────────────────────────────────────

export interface EnsureBucketsInput {
  siteId: string;
  entityType: "STATION" | "WORKCENTER" | "SITE" | "JOB";
  entityId: string;
  timestamp: Date;
  /** Human-readable entity name. When omitted, resolved via resolveEntityName(). */
  entityName?: string;
  /** Hierarchical dotted path. When omitted, resolved via resolveEntityPath(). */
  path?: string;
}

/**
 * Ensure that empty buckets exist for the current time period.
 *
 * With a shift schedule: creates shift bucket + shift-aligned hour
 * buckets, and schedules a delayed job for the next shift boundary.
 *
 * Without a shift schedule: creates 24 clock-aligned hour buckets
 * for the local day (no shift bucket, no boundary scheduling).
 *
 * Called before updating KPIs so that hours with zero cycles still
 * have a row (all KPIs = 0) rather than being absent. Uses createMany
 * with skipDuplicates so existing buckets are untouched.
 */
export async function ensureBuckets(input: EnsureBucketsInput, ctx?: MetricsContext) {
  const timezone = await getSiteTimezone(input.siteId, ctx);
  return ensureBucketsInternal(input, timezone, ctx);
}

async function ensureBucketsInternal(input: EnsureBucketsInput, timezone: string, ctx?: MetricsContext) {
  const shift = await getShiftForEntity(input.entityType, input.entityId, input.siteId, input.timestamp, ctx);
  const hourBuckets = await getHourBucketsForEntity(
    input.entityType,
    input.entityId,
    input.siteId,
    input.timestamp,
    timezone,
    ctx,
  );

  // Resolve path and entity name (skip DB when caller provides them)
  const [path, entityName] = await Promise.all([
    resolveEntityPath(input.entityType, input.entityId, input.siteId, input.path, ctx),
    resolveEntityName(input.entityType, input.entityId, input.entityName, ctx),
  ]);

  // Resolve businessDate: from ShiftInstance when available, else from local calendar date
  const shiftInstanceId = shift?.shiftInstanceId ?? null;
  const businessDate = await resolveBusinessDate(input.timestamp, shiftInstanceId, timezone);
  const businessShift = shift?.shiftName ?? null;

  // Resolve current job for STATION entities
  let currentJobId: string | null = null;
  let currentJobName: string | null = null;
  if (input.entityType === "STATION") {
    const jobRows = await prisma.$queryRaw<Array<{ currentJobId: string | null; jobName: string | null }>>`
      SELECT s."currentJobId", jb.name AS "jobName"
      FROM "Station" s
      LEFT JOIN "Job" j ON j.id = s."currentJobId"
      LEFT JOIN "JobBlob" jb ON jb.id = j."currentBlobId"
      WHERE s.id = ${input.entityId}::uuid
      LIMIT 1
    `;
    currentJobId = jobRows[0]?.currentJobId ?? null;
    currentJobName = jobRows[0]?.jobName ?? null;
  }

  const buckets: Array<{
    siteId: string;
    entityType: "STATION" | "WORKCENTER" | "SITE" | "JOB";
    entityId: string;
    entityName: string;
    path: string;
    granularity: "MINUTE" | "HOUR" | "SHIFT" | "DAY";
    granularityName: string;
    startTime: Date;
    durationSeconds: number;
    totalCycles: number;
    shiftInstanceId?: string | null;
    businessDate?: Date | null;
    businessShift?: string | null;
    currentJobId?: string | null;
    currentJobName?: string | null;
  }> = [];

  // Shift bucket (only when a shift schedule exists)
  if (shift) {
    buckets.push({
      siteId: input.siteId,
      entityType: input.entityType,
      entityId: input.entityId,
      entityName,
      path,
      granularity: "SHIFT",
      granularityName: shift.shiftName,
      startTime: shift.startTime,
      durationSeconds: shift.durationSeconds,
      totalCycles: 0,
      shiftInstanceId: shift.shiftInstanceId,
      businessDate,
      businessShift,
      currentJobId,
      currentJobName,
    });
  }

  // Hour buckets — tag with the shift instance when shift-aligned,
  // null for clock-aligned hours (no shift schedule).
  const hourShiftInstanceId = shift?.shiftInstanceId ?? null;
  for (const hb of hourBuckets) {
    buckets.push({
      siteId: input.siteId,
      entityType: input.entityType,
      entityId: input.entityId,
      entityName,
      path,
      granularity: "HOUR",
      granularityName: "Hour",
      startTime: hb.startTime,
      durationSeconds: hb.durationSeconds,
      totalCycles: 0,
      shiftInstanceId: hourShiftInstanceId,
      businessDate,
      businessShift,
      currentJobId,
      currentJobName,
    });
  }

  if (buckets.length > 0) {
    const valueRows = buckets.map(
      (b) => Prisma.sql`(
        gen_random_uuid(),
        ${b.siteId}::uuid,
        ${b.entityType}::"BucketEntityType",
        ${b.entityId}::uuid,
        ${b.entityName},
        ${b.path},
        ${b.granularity}::"BucketGranularity",
        ${b.granularityName},
        ${b.startTime},
        ${b.durationSeconds},
        0,
        ${b.shiftInstanceId ?? null},
        ${b.businessDate ?? null},
        ${b.businessShift ?? null},
        ${b.currentJobId ?? null},
        ${b.currentJobName ?? null},
        NOW(), NOW()
      )`,
    );

    // RETURNING with ON CONFLICT DO NOTHING only returns actually-inserted
    // rows, not conflicted ones — so we can publish BucketChange events
    // solely for newly-created buckets and avoid spamming downstream with
    // zero-valued snapshots for buckets that already have real data.
    const inserted = await prisma.$queryRaw<
      Array<{ entityType: string; entityId: string; granularity: string; startTime: Date }>
    >`
      INSERT INTO "MetricBucket" (
        id, "siteId", "entityType", "entityId", "entityName", path,
        granularity, "granularityName", "startTime", "durationSeconds",
        "totalCycles",
        "shiftInstanceId", "businessDate", "businessShift",
        "currentJobId", "currentJobName",
        "createdAt", "updatedAt"
      ) VALUES ${Prisma.join(valueRows)}
      ON CONFLICT ("entityType", "entityId", granularity, "startTime") DO NOTHING
      RETURNING "entityType", "entityId", granularity, "startTime"
    `;

    // Schedule next shift boundary job (only when a shift schedule exists).
    // Without a schedule, the 60s safety timer in background-workers
    // handles day rollover by calling ensureBuckets() periodically.
    if (shift) {
      scheduleNextShiftBuckets(input).catch((err) => {
        console.error(
          `[metrics] Failed to schedule next shift buckets for ${input.entityType} ${input.entityId}:`,
          err,
        );
      });
    }

    if (inserted.length > 0) {
      const insertedKeys = new Set(
        inserted.map((r) => `${r.entityType}|${r.entityId}|${r.granularity}|${r.startTime.toISOString()}`),
      );
      const changes: BucketChange[] = buckets
        .filter((b) => insertedKeys.has(`${b.entityType}|${b.entityId}|${b.granularity}|${b.startTime.toISOString()}`))
        .map((b) => ({
          siteId: b.siteId,
          entityType: b.entityType,
          entityId: b.entityId,
          entityName: b.entityName,
          path: b.path,
          granularity: b.granularity,
          granularityName: b.granularityName,
          startTime: b.startTime,
          durationSeconds: b.durationSeconds,
          shiftInstanceId: b.shiftInstanceId ?? null,
          businessDate: b.businessDate ?? null,
          businessShift: b.businessShift ?? null,
          snapshot: {
            ...ZERO_SNAPSHOT,
            shiftInstanceId: b.shiftInstanceId ?? null,
            businessDate: b.businessDate ? b.businessDate.toISOString().slice(0, 10) : null,
            businessShift: b.businessShift ?? null,
            currentJobId: b.currentJobId ?? null,
            currentJobName: b.currentJobName ?? null,
          },
        }));

      if (changes.length > 0) {
        onBucketsChanged(changes).catch((err) => {
          console.error(`[metrics] Failed to notify bucket changes for ${input.entityType} ${input.entityId}:`, err);
        });
      }
    }
  }
}

/**
 * Batch-ensure buckets for multiple entities at once.
 *
 * Shares a single MetricsContext so shift lookups, timezone lookups, etc.
 * are resolved once and reused across all entities.
 */
export async function ensureBucketsBatch(inputs: EnsureBucketsInput[], ctx?: MetricsContext) {
  const sharedCtx = ctx ?? new MetricsContext();

  // Pre-resolve timezones (usually all the same site)
  const siteIds = [...new Set(inputs.map((i) => i.siteId))];
  const tzMap = new Map<string, string>();
  for (const siteId of siteIds) {
    tzMap.set(siteId, await getSiteTimezone(siteId, sharedCtx));
  }

  for (const input of inputs) {
    try {
      // biome-ignore lint/style/noNonNullAssertion: tzMap is populated for every siteId in `siteIds` (lines 396-400), and input.siteId ∈ siteIds by construction
      const timezone = tzMap.get(input.siteId)!;
      await ensureBucketsInternal(input, timezone, sharedCtx);
    } catch (err) {
      console.error(`[metrics] Failed to ensure buckets for ${input.entityType} ${input.entityId}:`, err);
    }
  }
}
