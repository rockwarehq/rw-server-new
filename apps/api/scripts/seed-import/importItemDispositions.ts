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
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importItemDispositions(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("ItemDisposition");

  const rows = await readData<SqlServerRow>("ItemDisposition");

  if (rows.length === 0) {
    log.warn("No ItemDisposition data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      // Use findFirst + create/update pattern for safety
      const existing = await prisma.itemDisposition.findFirst({
        where: { siteId, name: { equals: row.name, mode: "insensitive" } },
      });

      let record;
      if (existing) {
        record = existing;
      } else {
        record = await prisma.itemDisposition.create({
          data: {
            name: row.name,
            siteId,
          },
        });
      }

      // Store mapping by name for downstream importers (ItemDispositionReason)
      idMap.set("itemDisposition", row.name, record.id);
    },
    { label: "item dispositions" },
  );

  log.summary(result);
}
