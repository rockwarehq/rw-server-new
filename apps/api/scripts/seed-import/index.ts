import "dotenv/config";
import prisma from "@rw/db";
import config from "./config.js";
import { IdMap } from "./utils.js";
import { importProcessTypes } from "./importProcessTypes.js";
import { importWorkcenters } from "./importWorkcenters.js";
import { importProducts } from "./importProducts.js";
import { importMaterials } from "./importMaterials.js";
import { importProductMaterials } from "./importProductMaterials.js";
import { importTools } from "./importTools.js";
import { importToolCavities } from "./importToolCavities.js";
import { importJobs } from "./importJobs.js";
import { importStations } from "./importStations.js";
import { importJobProducts } from "./importJobProducts.js";
import { importStatusCategories } from "./importStatusCategories.js";
import { importStatusReasons } from "./importStatusReasons.js";
import { importItemDispositions } from "./importItemDispositions.js";
import { importItemDispositionReasons } from "./importItemDispositionReasons.js";
import { importEmployeeRoles } from "./importEmployeeRoles.js";
import { importEmployees } from "./importEmployees.js";

async function main() {
  const idMap = new IdMap();
  const startTime = Date.now();

  console.log("=".repeat(60));
  console.log("SQL Server -> Postgres Data Import");
  console.log("=".repeat(60));
  console.log();
  console.log(`  Workspace: ${config.workspaceName}`);
  console.log(`  Site:      ${config.siteName}`);
  console.log(`  Batch:     ${config.batchSize}`);
  console.log(`  Verbose:   ${config.verbose}`);
  console.log();

  // -------------------------------------------------------------------------
  // Resolve the target site
  // -------------------------------------------------------------------------
  const site = await prisma.site.findFirst({
    where: {
      name: config.siteName,
      workspace: { name: config.workspaceName },
    },
  });

  if (!site) {
    console.error(
      `Site "${config.siteName}" in workspace "${config.workspaceName}" not found.\n` +
        `Update apps/api/scripts/seed-import/config.ts with the correct values.`,
    );
    process.exit(1);
  }

  console.log(`Resolved site: ${site.name} (${site.id})`);
  console.log();

  // -------------------------------------------------------------------------
  // Run importers in foreign-key dependency order.
  //
  // Parent/reference tables first, then tables that depend on them.
  // The IdMap carries old->new ID mappings between importers.
  // -------------------------------------------------------------------------

  // 1. Reference / configuration data
  await importProcessTypes(prisma, idMap, site.id);

  // 2. Workcenters (depends on processTypes)
  await importWorkcenters(prisma, idMap, site.id);

  // 3. Products + Materials (independent of each other)
  await importProducts(prisma, idMap, site.id);
  await importMaterials(prisma, idMap, site.id);

  // 4. ProductMaterials (depends on products + materials)
  await importProductMaterials(prisma, idMap, site.id);

  // 5. Tools (independent)
  await importTools(prisma, idMap, site.id);

  // 6. ToolCavities (depends on tools)
  await importToolCavities(prisma, idMap, site.id);

  // 7. Jobs + JobTool (depends on processTypes + tools)
  await importJobs(prisma, idMap, site.id);

  // 8. Stations (depends on workcenters + jobs)
  await importStations(prisma, idMap, site.id);

  // 9. JobProducts (depends on jobs + products + tools + toolCavities)
  await importJobProducts(prisma, idMap, site.id);

  // 10. StatusCategories (no dependencies — reference table)
  await importStatusCategories(prisma, idMap, site.id);

  // 11. StatusReasons (depends on statusCategories + processTypes)
  await importStatusReasons(prisma, idMap, site.id);

  // 12. ItemDispositions (no dependencies — reference table)
  await importItemDispositions(prisma, idMap, site.id);

  // 13. ItemDispositionReasons (depends on processTypes)
  await importItemDispositionReasons(prisma, idMap, site.id);

  // 14. EmployeeRoles (per-site reference; also picks up any pre-seeded roles)
  await importEmployeeRoles(prisma, idMap, site.id);

  // 15. Employees (depends on EmployeeRoles; derives workspaceId from site)
  await importEmployees(prisma, idMap, site.id);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();
  console.log("=".repeat(60));
  console.log(`Import completed in ${elapsed}s`);

  if (idMap.tables().length > 0) {
    console.log("\nID mappings created:");
    for (const table of idMap.tables()) {
      console.log(`  ${table}: ${idMap.count(table)} records`);
    }
  }

  console.log("=".repeat(60));
}

main()
  .catch((e) => {
    console.error("Import failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
