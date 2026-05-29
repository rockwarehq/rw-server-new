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
  PXID?: string;
  name: string;
  GroupID?: string;
  Process?: string;
  Description: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importWorkcenters(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("Workcenter");

  const rows = await readData<SqlServerRow>("Workcenter");

  if (rows.length === 0) {
    log.warn("No Workcenter data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      // Resolve processTypeId from the IdMap (populated by importProcessTypes).
      // New dumps expose `GroupID`; older dumps used `Process` for the same
      // value — accept either so legacy dumps still import.
      const processGroup = row.GroupID || row.Process;
      let processTypeId: string | null = null;
      if (processGroup) {
        processTypeId = idMap.get("processType", processGroup) ?? null;
        if (!processTypeId) {
          log.warn(
            `Process group "${processGroup}" not found in IdMap for workcenter "${row.name}" — setting to null`,
          );
        }
      }

      // Can't use upsert with the composite unique (siteId, parentId, name)
      // because parentId is nullable and Prisma requires a string value.
      // Use findFirst + create/update instead, with a case-insensitive name
      // match so re-imports treat "Mold"/"MOLD" as the same workcenter.
      const existing = await prisma.workcenter.findFirst({
        where: { siteId, parentId: null, name: { equals: row.name, mode: "insensitive" } },
      });

      let record;
      if (existing) {
        record = await prisma.workcenter.update({
          where: { id: existing.id },
          data: {
            description: nullable(row.Description),
            processTypeId,
          },
        });
      } else {
        record = await prisma.workcenter.create({
          data: {
            name: row.name,
            description: nullable(row.Description),
            processTypeId,
            siteId,
          },
        });
      }

      // Store mapping by PXID when present — Station rows reference the
      // workcenter via tblConfigSN1.PXID (a foreign key to tblConfigLine.PXID).
      // Older dumps without PXID fall back to keying by name.
      idMap.set("workcenter", row.PXID || row.name, record.id);
    },
    { label: "workcenters" },
  );

  log.summary(result);
}
