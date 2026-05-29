import type { PrismaClient } from "@rw/db";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
  isDevSeed,
} from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  JobName: string;
  ToolName: string;
  CavityName: string;
  ProductName: string;
  Active: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importJobProducts(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("JobProduct");
  void siteId;

  const rows = await readData<SqlServerRow>("JobCavity");

  if (rows.length === 0) {
    log.warn("No JobCavity data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      const jobName = row.JobName.trim();
      const toolName = row.ToolName.trim();
      const cavityName = row.CavityName.trim();
      const productName = row.ProductName.trim();
      const isActive = true;

      // Resolve required references
      const jobId = idMap.get("job", jobName);
      if (!jobId) {
        log.warn(`Job "${jobName}" not found in IdMap — skipping`);
        return;
      }

      const productId = idMap.get("product", productName);
      if (!productId) {
        log.warn(`Product "${productName}" not found in IdMap — skipping`);
        return;
      }

      // Optional references
      const toolId = idMap.get("tool", toolName) ?? null;
      const toolCavityId = idMap.get("toolCavity", `${toolName}:${cavityName}`) ?? null;

      // The JobCavity source carries the canonical (job, tool) pairing.
      // Upsert the JobTool junction so Job.tools is populated in production
      // imports (the dev-seed fabrication block in importJobs.ts handles the
      // fallback for jobs that don't appear in JobCavity at all).
      if (toolId) {
        await prisma.jobTool.upsert({
          where: { jobId_toolId: { jobId, toolId } },
          update: { isActive: true },
          create: { jobId, toolId, isActive: true },
        });
      }

      // Look up existing by (jobId, productId, toolId, toolCavityId) for idempotency
      const existing = await prisma.jobProduct.findFirst({
        where: { jobId, productId, toolId, toolCavityId },
        include: { currentBlob: true },
      });

      if (existing) {
        const blob = existing.currentBlob;

        if (!blob) {
          // Existing JobProduct with no current blob — create v1.
          const newBlob = await prisma.jobProductBlob.create({
            data: {
              version: 1,
              isActive,
              quantity: 1,
              jobProductId: existing.id,
            },
          });
          await prisma.jobProduct.update({
            where: { id: existing.id },
            data: { currentBlobId: newBlob.id },
          });
        } else if (blob.isActive !== isActive) {
          await prisma.jobProductBlob.update({
            where: { id: blob.id },
            data: { isActive },
          });
        }
        return;
      }

      // Create new job product + blob v1
      const jobProduct = await prisma.jobProduct.create({
        data: {
          jobId,
          productId,
          toolId,
          toolCavityId,
        },
      });

      const blob = await prisma.jobProductBlob.create({
        data: {
          version: 1,
          isActive,
          quantity: 1,
          jobProductId: jobProduct.id,
        },
      });

      await prisma.jobProduct.update({
        where: { id: jobProduct.id },
        data: { currentBlobId: blob.id },
      });
    },
    { label: "job-products" },
  );

  log.summary(result);

  // Dev-seed only: assign every JobProduct that lacks a toolCavity to cavity 1
  // of the job's tool. Real `db:import` leaves toolCavityId NULL when the source
  // didn't supply it.
  if (!isDevSeed()) return;

  // Ensure every job's products are assigned to cavity 1 of the job's tool.
  // Jobs that appeared in the JobCavity seed data already have cavity assignments.
  // For the rest, find their tool's first cavity and assign all simple products to it.
  const simpleProducts = await prisma.jobProduct.findMany({
    where: { deletedAt: null, toolCavityId: null },
    select: { id: true, jobId: true, productId: true },
  });

  if (simpleProducts.length > 0) {
    log.info(`Assigning ${simpleProducts.length} simple products to cavity 1...`);

    // Build a map of jobId -> first cavity of first tool
    const jobIds = [...new Set(simpleProducts.map((p) => p.jobId))];
    const jobTools = await prisma.jobTool.findMany({
      where: { jobId: { in: jobIds }, deletedAt: null },
      include: {
        tool: {
          include: {
            toolCavities: {
              where: { deletedAt: null },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    });

    const jobCavityMap = new Map<string, { toolId: string; cavityId: string }>();
    for (const jt of jobTools) {
      if (jobCavityMap.has(jt.jobId)) continue;
      const cavity = jt.tool.toolCavities[0];
      if (cavity) {
        jobCavityMap.set(jt.jobId, { toolId: jt.toolId, cavityId: cavity.id });
      }
    }

    let assigned = 0;
    for (const sp of simpleProducts) {
      const mapping = jobCavityMap.get(sp.jobId);
      if (!mapping) continue;
      await prisma.jobProduct.update({
        where: { id: sp.id },
        data: { toolId: mapping.toolId, toolCavityId: mapping.cavityId },
      });
      assigned++;
    }

    log.info(`Assigned ${assigned}/${simpleProducts.length} products to cavity 1`);
  }
}
