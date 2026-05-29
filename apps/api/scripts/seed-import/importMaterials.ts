import type { PrismaClient } from "@rw/db";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
  nullable,
  mapWeightUnit,
  parseDecimalCommaNumber,
} from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  name: string;
  shortCode: string;
  materialNumber: string;
  description: string;
  Unit: string;
  UnitCost: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importMaterials(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("Material");

  const rows = await readData<SqlServerRow>("Material");

  if (rows.length === 0) {
    log.warn("No Material data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      const name = nullable(row.name);
      const shortCode = nullable(row.shortCode);
      const materialNumber = row.materialNumber || row.shortCode;
      const description = nullable(row.description);
      const weightUnits = mapWeightUnit(row.Unit);
      const unitCost = parseDecimalCommaNumber(row.UnitCost);

      // Look up existing material by matching current blob shortCode + siteId.
      // shortCode is nullable; only apply case-insensitive matching when it's
      // a real string (a NULL shortCode just matches NULL — there's no case).
      const existing = await prisma.material.findFirst({
        where: {
          siteId,
          currentBlob:
            shortCode === null
              ? { shortCode: null }
              : { shortCode: { equals: shortCode, mode: "insensitive" } },
        },
        include: { currentBlob: true },
      });

      if (existing) {
        // Check if data changed
        const blob = existing.currentBlob;
        const changed =
          blob?.name !== name ||
          blob?.materialNumber !== materialNumber ||
          blob?.description !== description ||
          blob?.weightUnits !== weightUnits ||
          (blob?.unitCost !== null && blob?.unitCost !== undefined
            ? Number(blob.unitCost)
            : null) !== unitCost;

        if (changed && blob) {
          await prisma.materialBlob.update({
            where: { id: blob.id },
            data: { name, shortCode, materialNumber, description, weightUnits, unitCost },
          });
        }

        idMap.set("material", row.shortCode, existing.id);
        return;
      }

      // Create new material + blob v1
      const material = await prisma.material.create({
        data: { siteId },
      });

      const blob = await prisma.materialBlob.create({
        data: {
          version: 1,
          name,
          shortCode,
          materialNumber,
          description,
          weightUnits,
          unitCost,
          materialId: material.id,
        },
      });

      await prisma.material.update({
        where: { id: material.id },
        data: { currentBlobId: blob.id },
      });

      idMap.set("material", row.shortCode, material.id);
    },
    { label: "materials" },
  );

  log.summary(result);
}
