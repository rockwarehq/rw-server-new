import type { PrismaClient } from "@rw/db";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
} from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  name: string;
  isActive: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importStatusCategories(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("StatusCategory");

  const rows = await readData<SqlServerRow>("StatusCategory");

  if (rows.length === 0) {
    log.warn("No StatusCategory data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      // Use findFirst + create/update pattern for safety
      const existing = await prisma.statusCategory.findFirst({
        where: { siteId, name: { equals: row.name, mode: "insensitive" } },
      });

      let record;
      if (existing) {
        record = existing;
      } else {
        record = await prisma.statusCategory.create({
          data: {
            name: row.name,
            siteId,
          },
        });
      }

      // Store mapping by name for downstream importers (StatusReason)
      idMap.set("statusCategory", row.name, record.id);
    },
    { label: "status categories" },
  );

  log.summary(result);
}
