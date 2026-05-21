import prisma from "@rw/db";
import type { MetricsContext } from "./context.js";

type EntityType = "STATION" | "WORKCENTER" | "SITE" | "JOB";

export interface IncrementTarget {
  entityType: EntityType;
  entityId: string;
  /** Human-readable name of the entity. */
  entityName: string;
  /** Hierarchical dotted path for the entity (e.g. "site.{id}.workcenter.{id}.station.{id}"). */
  path: string;
}

/**
 * Resolve the full list of entities whose metric buckets should be
 * incremented when a cycle completes on a given station.
 *
 * Returns (in order):
 *   1. The station itself
 *   2. The station's workcenter (if any)
 *   3. All ancestor workcenters up the parentId chain
 *   4. The site
 *
 * Each target includes a `path` encoding its full ancestry.
 * This ensures that totals at every level of the hierarchy match the
 * sum of their children. Each entity is incremented in parallel.
 */
export async function getIncrementTargets(
  stationId: string,
  siteId: string,
  ctx?: MetricsContext,
): Promise<IncrementTarget[]> {
  // Check cache
  if (ctx) {
    const cached = ctx.getIncrementTargetsCached(stationId, siteId);
    if (cached) return cached;
  }

  // Look up station name + workcenter, site name, and full workcenter chain in one query
  const rows = await prisma.$queryRaw<
    Array<{
      stationName: string;
      siteName: string;
      workcenterId: string | null;
    }>
  >`
    SELECT s.name AS "stationName", si.name AS "siteName", s."workcenterId"
    FROM "Station" s
    JOIN "Site" si ON si.id = ${siteId}::uuid
    WHERE s.id = ${stationId}::uuid
  `;

  const stationName = rows[0]?.stationName ?? "";
  const siteName = rows[0]?.siteName ?? "";

  // Walk ancestor chain via recursive CTE
  const wcChain: Array<{ id: string; name: string }> = [];
  const firstWcId = rows[0]?.workcenterId ?? null;

  if (firstWcId) {
    const wcRows = await prisma.$queryRaw<Array<{ id: string; name: string; depth: number }>>`
      WITH RECURSIVE chain AS (
        SELECT id, name, "parentId", 0 AS depth FROM "Workcenter" WHERE id = ${firstWcId}::uuid
        UNION ALL
        SELECT w.id, w.name, w."parentId", c.depth + 1
        FROM "Workcenter" w JOIN chain c ON w.id = c."parentId"
      )
      SELECT id, name, depth FROM chain ORDER BY depth ASC
    `;
    for (const wc of wcRows) {
      wcChain.push({ id: wc.id, name: wc.name });
    }
  }

  // Build paths. The workcenter chain is [direct, parent, grandparent, ...]
  // so reversed it becomes [root, ..., direct] for path construction.
  const sitePath = `site.${siteId}`;
  const wcChainReversed = [...wcChain].reverse(); // root-first

  // Build path prefix up to each workcenter level
  const wcPaths = new Map<string, string>();
  let prefix = sitePath;
  for (const { id } of wcChainReversed) {
    prefix = `${prefix}.workcenter.${id}`;
    wcPaths.set(id, prefix);
  }

  // Station path = full prefix + station segment
  const stationPath = `${prefix}.station.${stationId}`;

  // Assemble targets
  const targets: IncrementTarget[] = [
    { entityType: "STATION", entityId: stationId, entityName: stationName, path: stationPath },
  ];

  for (const { id, name } of wcChain) {
    // biome-ignore lint/style/noNonNullAssertion: wcPaths is populated above (line 84-87) by iterating the same wc chain, so every id has a path
    targets.push({ entityType: "WORKCENTER", entityId: id, entityName: name, path: wcPaths.get(id)! });
  }

  targets.push({ entityType: "SITE", entityId: siteId, entityName: siteName, path: sitePath });

  console.log(
    `[metrics:hierarchy] Targets for station ${stationId}:`,
    targets.map((t) => `${t.entityType}:${t.entityId} (${t.path})`).join(", "),
  );

  // Populate entity name/path caches from resolved targets
  if (ctx) {
    ctx.setIncrementTargetsCached(stationId, siteId, targets);
    for (const t of targets) {
      ctx.setEntityPathCached(t.entityType, t.entityId, siteId, t.path);
      ctx.setEntityNameCached(t.entityType, t.entityId, t.entityName);
    }
    // Cache the workcenter ID mapping for the station
    ctx.setWorkCenterIdCached("STATION", stationId, firstWcId);
  }

  return targets;
}

// ── Path resolution ──────────────────────────────────────────────

/**
 * Resolve the hierarchical dotted path for an entity.
 *
 * When `knownPath` is provided the DB queries are skipped entirely.
 *
 * Path format:
 *   SITE:       "site.{siteId}"
 *   WORKCENTER: "site.{siteId}.workcenter.{parentId}...workcenter.{wcId}"
 *   STATION:    "site.{siteId}[.workcenter.{...}].station.{stationId}"
 */
export async function resolveEntityPath(
  entityType: EntityType,
  entityId: string,
  siteId: string,
  knownPath?: string,
  ctx?: MetricsContext,
): Promise<string> {
  if (knownPath) return knownPath;

  // Check cache
  if (ctx) {
    const cached = ctx.getEntityPathCached(entityType, entityId, siteId);
    if (cached !== undefined) return cached;
  }

  const sitePath = `site.${siteId}`;

  let result: string;

  if (entityType === "SITE") {
    result = sitePath;
  } else if (entityType === "WORKCENTER") {
    // Walk parent chain via recursive CTE
    const wcRows = await prisma.$queryRaw<Array<{ id: string; depth: number }>>`
      WITH RECURSIVE chain AS (
        SELECT id, "parentId", 0 AS depth FROM "Workcenter" WHERE id = ${entityId}::uuid
        UNION ALL
        SELECT w.id, w."parentId", c.depth + 1
        FROM "Workcenter" w JOIN chain c ON w.id = c."parentId"
      )
      SELECT id, depth FROM chain ORDER BY depth DESC
    `;
    const chain = wcRows.map((r) => r.id);
    result = `${sitePath}.${chain.map((id) => `workcenter.${id}`).join(".")}`;
  } else if (entityType === "JOB") {
    // JOB path is scoped to the station it's running on.
    // entityId is a composite md5(stationId:job:jobId) — look up the
    // existing bucket's path first, then fall back to station queries.
    const existingPathRows = await prisma.$queryRaw<Array<{ path: string }>>`
      SELECT path FROM "MetricBucket"
      WHERE "entityType" = 'JOB' AND "entityId" = ${entityId}::uuid
      LIMIT 1
    `;
    if (existingPathRows[0]?.path) {
      result = existingPathRows[0].path;
    } else {
      // Fall back: look up station by currentJobId matching
      const stationRows = await prisma.$queryRaw<Array<{ id: string; jobId: string }>>`
        SELECT s.id, s."currentJobId" AS "jobId" FROM "Station" s
        WHERE md5(s.id::text || ':job:' || s."currentJobId"::text)::uuid = ${entityId}::uuid
          AND s."currentJobId" IS NOT NULL
        LIMIT 1
      `;
      const station: { id: string; jobId: string } | null = stationRows[0] ?? null;

      if (!station) {
        result = `${sitePath}.job.${entityId}`;
      } else {
        const stationPath = await resolveEntityPath("STATION", station.id, siteId, undefined, ctx);
        result = `${stationPath}.job.${station.jobId}`;
      }
    }
  } else {
    // STATION
    const stRows = await prisma.$queryRaw<Array<{ workcenterId: string | null }>>`
      SELECT "workcenterId" FROM "Station" WHERE id = ${entityId}::uuid
    `;
    const stationRecord = stRows[0] ?? null;

    if (!stationRecord?.workcenterId) {
      result = `${sitePath}.station.${entityId}`;
    } else {
      // Resolve the workcenter's path, then append station
      const wcPath = await resolveEntityPath("WORKCENTER", stationRecord.workcenterId, siteId, undefined, ctx);
      result = `${wcPath}.station.${entityId}`;
    }
  }

  ctx?.setEntityPathCached(entityType, entityId, siteId, result);
  return result;
}

// ── Entity name resolution ───────────────────────────────────────

/**
 * Resolve the human-readable name for an entity.
 *
 * When `knownName` is provided the DB query is skipped.
 */
export async function resolveEntityName(
  entityType: EntityType,
  entityId: string,
  knownName?: string,
  ctx?: MetricsContext,
): Promise<string> {
  if (knownName != null) return knownName;

  // Check cache
  if (ctx) {
    const cached = ctx.getEntityNameCached(entityType, entityId);
    if (cached !== undefined) return cached;
  }

  const nameRows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT CASE
      WHEN ${entityType} = 'SITE' THEN (SELECT name FROM "Site" WHERE id = ${entityId}::uuid)
      WHEN ${entityType} = 'WORKCENTER' THEN (SELECT name FROM "Workcenter" WHERE id = ${entityId}::uuid)
      WHEN ${entityType} = 'JOB' THEN COALESCE(
        (SELECT mb."entityName" FROM "MetricBucket" mb WHERE mb."entityType" = 'JOB' AND mb."entityId" = ${entityId}::uuid LIMIT 1),
        (SELECT jb.name FROM "Job" j JOIN "JobBlob" jb ON jb.id = j."currentBlobId" WHERE j.id = ${entityId}::uuid)
      )
      WHEN ${entityType} = 'STATION' THEN (SELECT name FROM "Station" WHERE id = ${entityId}::uuid)
    END AS name
  `;
  const result = nameRows[0]?.name ?? "";

  ctx?.setEntityNameCached(entityType, entityId, result);
  return result;
}
