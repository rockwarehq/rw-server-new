import type { PrismaClient } from "@rw/db";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
  nullable,
  parseNumber,
  isDevSeed,
} from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  name: string;
  description: string;
  standardCycle: string;
  standardCycleUnit: string;
}

// Non-production jobs — no matching tool, skip JobTool creation
const NON_PRODUCTION_JOBS = new Set(["MAINT", "OPEN", "SCHED DOWN", "TOOLING"]);

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importJobs(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("Job");

  const rows = await readData<SqlServerRow>("Job");

  if (rows.length === 0) {
    log.warn("No Job data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  // All jobs get processTypeId = MOLD
  const processTypeId = idMap.get("processType", "MOLD") ?? null;
  if (!processTypeId) {
    log.warn("ProcessType 'MOLD' not found in IdMap — jobs will have no processType");
  }

  const result = await batchUpsert(
    rows,
    async (row) => {
      const name = row.name.trim();
      const description = nullable(row.description);
      const standardCycle = parseNumber(row.standardCycle);

      // Look up existing job by matching current blob name + siteId
      // (case-insensitive so "ARB35" / "arb35" match as the same job).
      const existing = await prisma.job.findFirst({
        where: {
          siteId,
          currentBlob: { name: { equals: name, mode: "insensitive" } },
          deletedAt: null,
        },
        include: { currentBlob: true },
      });

      let jobId: string;

      if (existing) {
        // Check if data changed
        const blob = existing.currentBlob;
        const attrs = (blob?.attrs as Record<string, unknown>) ?? {};
        const changed =
          blob?.description !== description ||
          (blob?.standardCycle !== null ? Number(blob.standardCycle) : null) !== standardCycle ||
          attrs.cavityTrackingEnabled !== true;

        if (changed && blob) {
          await prisma.jobBlob.update({
            where: { id: blob.id },
            data: {
              name,
              description,
              standardCycle,
              attrs: { cavityTrackingEnabled: true },
            },
          });
        }
        if (existing.processTypeId !== processTypeId) {
          await prisma.job.update({
            where: { id: existing.id },
            data: { processTypeId },
          });
        }

        jobId = existing.id;
      } else {
        // Create new job + blob v1
        const job = await prisma.job.create({
          data: { siteId, processTypeId },
        });

        const blob = await prisma.jobBlob.create({
          data: {
            version: 1,
            name,
            description,
            standardCycle,
            attrs: { cavityTrackingEnabled: true },
            jobId: job.id,
          },
        });

        await prisma.job.update({
          where: { id: job.id },
          data: { currentBlobId: blob.id },
        });

        jobId = job.id;
      }

      idMap.set("job", name, jobId);

      // Dev-seed only: ensure every production job has a tool linked with at
      // least 1 cavity, fabricating Tool/JobTool/ToolCavity entities when the
      // source data doesn't already supply them. Skipped in real `db:import`
      // — production data is expected to carry its own tool linkage.
      if (isDevSeed() && !NON_PRODUCTION_JOBS.has(name.toUpperCase())) {
        let toolId = idMap.get("tool", name) ?? null;

        // Create a tool if none exists with this name
        if (!toolId) {
          const tool = await prisma.tool.create({
            data: { siteId },
          });
          const toolBlob = await prisma.toolBlob.create({
            data: { version: 1, name, toolId: tool.id },
          });
          await prisma.tool.update({
            where: { id: tool.id },
            data: { currentBlobId: toolBlob.id },
          });
          toolId = tool.id;
          idMap.set("tool", name, toolId);
        }

        // Link tool to job
        await prisma.jobTool.upsert({
          where: { jobId_toolId: { jobId, toolId } },
          update: { isActive: true },
          create: { jobId, toolId, isActive: true },
        });

        // Ensure tool has at least 1 cavity
        const existingCavity = await prisma.toolCavity.findFirst({
          where: { toolId, deletedAt: null },
        });
        if (!existingCavity) {
          const cavity = await prisma.toolCavity.create({
            data: { toolId },
          });
          const cavityBlob = await prisma.toolCavityBlob.create({
            data: { version: 1, name: "1", position: 1, toolCavityId: cavity.id },
          });
          await prisma.toolCavity.update({
            where: { id: cavity.id },
            data: { currentBlobId: cavityBlob.id },
          });
          idMap.set("toolCavity", `${name}:1`, cavity.id);
        }
      }
    },
    { label: "jobs" },
  );

  log.summary(result);
}
