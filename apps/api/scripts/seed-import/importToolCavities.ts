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
  ToolId: string;
  CavityID: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importToolCavities(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("ToolCavity");
  void siteId;

  const rows = await readData<SqlServerRow>("ToolCavities");

  if (rows.length === 0) {
    log.warn("No ToolCavities data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      const toolName = row.ToolId.trim();
      const cavityName = row.CavityID.trim();
      const position = parseInt(cavityName, 10);

      const toolId = idMap.get("tool", toolName);
      if (!toolId) {
        log.warn(`Tool "${toolName}" not found in IdMap — skipping cavity ${cavityName}`);
        return;
      }

      // Composite key for IdMap: "TOOLNAME:CAVITYID"
      const compositeKey = `${toolName}:${cavityName}`;

      // Look up existing cavity by toolId + current blob name (case-insensitive)
      const existing = await prisma.toolCavity.findFirst({
        where: { toolId, currentBlob: { name: { equals: cavityName, mode: "insensitive" } } },
        include: { currentBlob: true },
      });

      if (existing) {
        // Check if data changed
        const blob = existing.currentBlob;
        const changed = blob?.position !== position;

        if (changed && blob) {
          await prisma.toolCavityBlob.update({
            where: { id: blob.id },
            data: { name: cavityName, position },
          });
        }

        idMap.set("toolCavity", compositeKey, existing.id);
        return;
      }

      // Create new tool cavity + blob v1
      const toolCavity = await prisma.toolCavity.create({
        data: { toolId },
      });

      const blob = await prisma.toolCavityBlob.create({
        data: {
          version: 1,
          name: cavityName,
          position,
          toolCavityId: toolCavity.id,
        },
      });

      await prisma.toolCavity.update({
        where: { id: toolCavity.id },
        data: { currentBlobId: blob.id },
      });

      idMap.set("toolCavity", compositeKey, toolCavity.id);
    },
    { label: "tool-cavities" },
  );

  log.summary(result);
}
