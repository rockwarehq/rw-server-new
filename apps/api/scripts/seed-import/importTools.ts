import type { PrismaClient } from "@rw/db";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
  parseNumber,
} from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  Name: string;
  pmLimit: string;
  pmWarn: string;
  pmCount: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importTools(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("Tool");

  const rows = await readData<SqlServerRow>("Tool");

  if (rows.length === 0) {
    log.warn("No Tool data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      const name = row.Name.trim();
      const pmLimit = parseNumber(row.pmLimit) as number | null;
      const pmWarn = parseNumber(row.pmWarn) as number | null;
      const pmCount = parseNumber(row.pmCount) as number | null;

      // Look up existing tool by matching current blob name + siteId
      // (case-insensitive so re-imports treat "ABC123" / "abc123" as same tool).
      const existing = await prisma.tool.findFirst({
        where: { siteId, currentBlob: { name: { equals: name, mode: "insensitive" } } },
        include: { currentBlob: true },
      });

      if (existing) {
        // Check if data changed
        const blob = existing.currentBlob;
        const changed =
          blob?.pmLimit !== pmLimit ||
          blob?.pmWarn !== pmWarn;

        if (changed && blob) {
          await prisma.toolBlob.update({
            where: { id: blob.id },
            data: { name, pmLimit, pmWarn },
          });
        }
        if (existing.pmCount !== pmCount) {
          await prisma.tool.update({
            where: { id: existing.id },
            data: { pmCount: pmCount ?? 0 },
          });
        }

        idMap.set("tool", row.Name, existing.id);
        return;
      }

      // Create new tool + blob v1
      const tool = await prisma.tool.create({
        data: {
          siteId,
          pmCount: pmCount ?? 0,
        },
      });

      const blob = await prisma.toolBlob.create({
        data: {
          version: 1,
          name,
          pmLimit,
          pmWarn,
          toolId: tool.id,
        },
      });

      await prisma.tool.update({
        where: { id: tool.id },
        data: { currentBlobId: blob.id },
      });

      idMap.set("tool", row.Name, tool.id);
    },
    { label: "tools" },
  );

  log.summary(result);
}
