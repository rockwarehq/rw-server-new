import type { PrismaClient } from "@rw/db";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
  mapWeightUnit,
  parseDecimalCommaNumber,
} from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  product: string;
  material: string;
  weight: string;
  weightUnits: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importProductMaterials(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("ProductMaterial");
  void siteId; // not needed directly — FKs are resolved via IdMap

  const rows = await readData<SqlServerRow>("ProductMaterial");

  if (rows.length === 0) {
    log.warn("No ProductMaterial data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      const productId = idMap.get("product", row.product);
      if (!productId) {
        log.warn(`Product "${row.product}" not found in IdMap — skipping`);
        return;
      }

      const materialId = idMap.get("material", row.material);
      if (!materialId) {
        log.warn(`Material "${row.material}" not found in IdMap — skipping`);
        return;
      }

      const weight = parseDecimalCommaNumber(row.weight);
      const weightUnits = mapWeightUnit(row.weightUnits);

      const pm = await prisma.productMaterial.upsert({
        where: {
          productId_materialId: { productId, materialId },
        },
        update: {},
        create: {
          productId,
          materialId,
        },
        include: { currentBlob: true },
      });

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { currentBlobId: true },
      });
      const material = await prisma.material.findUnique({
        where: { id: materialId },
        select: { currentBlobId: true },
      });

      if (!product?.currentBlobId || !material?.currentBlobId) return;

      const current = pm.currentBlob;

      if (!current) {
        // First time we've seen this ProductMaterial — create v1 blob and link it.
        const newBlob = await prisma.productMaterialBlob.create({
          data: {
            productMaterialId: pm.id,
            version: 1,
            weight,
            weightUnits,
            materialBlobId: material.currentBlobId,
            productBlobId: product.currentBlobId,
          },
        });
        await prisma.productMaterial.update({
          where: { id: pm.id },
          data: { currentBlobId: newBlob.id },
        });
        return;
      }

      const changed =
        (current.weight !== null ? Number(current.weight) : null) !== weight ||
        current.weightUnits !== weightUnits ||
        current.materialBlobId !== material.currentBlobId ||
        current.productBlobId !== product.currentBlobId;

      if (!changed) return;

      await prisma.productMaterialBlob.update({
        where: { id: current.id },
        data: {
          weight,
          weightUnits,
          materialBlobId: material.currentBlobId,
          productBlobId: product.currentBlobId,
        },
      });
    },
    { label: "product-materials" },
  );

  log.summary(result);
}
