import type { PrismaClient } from "@rw/db";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
  nullable,
} from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  name: string;
  Description: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importProcessTypes(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("ProcessType");

  const rows = await readData<SqlServerRow>("ProcessType");

  if (rows.length === 0) {
    log.warn("No ProcessType data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      // Case-insensitive existence check (treats "MOLD" / "Mold" as the same).
      // Can't use the siteId_name upsert because that's case-sensitive.
      const existing = await prisma.processType.findFirst({
        where: { siteId, name: { equals: row.name, mode: "insensitive" } },
      });
      const description = nullable(row.Description);

      const record = existing
        ? await prisma.processType.update({
            where: { id: existing.id },
            data: { description },
          })
        : await prisma.processType.create({
            data: { name: row.name, description, siteId },
          });

      // Store mapping by name since SQL Server source has no UUID
      idMap.set("processType", row.name, record.id);
    },
    { label: "process types" },
  );

  log.summary(result);
}
