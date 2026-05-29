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
  DTGroupID: string;
  name: string;
  statusCategoryName: string;
  isPlannedDown: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importStatusReasons(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("StatusReason");

  const rows = await readData<SqlServerRow>("StatusReason");

  if (rows.length === 0) {
    log.warn("No StatusReason data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      // Resolve categoryId from the IdMap (populated by importStatusCategories)
      let categoryId: string | null = null;
      if (row.statusCategoryName) {
        categoryId = idMap.get("statusCategory", row.statusCategoryName) ?? null;
        if (!categoryId) {
          log.warn(
            `StatusCategory "${row.statusCategoryName}" not found in IdMap for reason "${row.name}" — setting to null`,
          );
        }
      }

      // Resolve processType for the m2m link (DTGroupID = process type name)
      const processTypeId = row.DTGroupID
        ? idMap.get("processType", row.DTGroupID) ?? null
        : null;

      const isPlannedDown = row.isPlannedDown === "1";

      // Case-insensitive existence check; can't use the siteId_name upsert
      // because that's case-sensitive at the DB level.
      const existing = await prisma.statusReason.findFirst({
        where: { siteId, name: { equals: row.name, mode: "insensitive" } },
      });

      const record = existing
        ? await prisma.statusReason.update({
            where: { id: existing.id },
            data: {
              isPlannedDown,
              categoryId,
              processTypes: processTypeId
                ? { set: [{ id: processTypeId }] }
                : undefined,
            },
          })
        : await prisma.statusReason.create({
            data: {
              name: row.name,
              isPlannedDown,
              categoryId,
              siteId,
              processTypes: processTypeId
                ? { connect: [{ id: processTypeId }] }
                : undefined,
            },
          });

      // Store mapping by name for downstream importers
      idMap.set("statusReason", row.name, record.id);
    },
    { label: "status reasons" },
  );

  log.summary(result);
}
