import type { PrismaClient } from "@rw/db";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
  nullable,
  parseNumber,
  parseDecimalCommaNumber,
} from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  sku: string;
  Name: string;
  weight: string;
  itemCost?: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importProducts(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("Product");

  const rows = await readData<SqlServerRow>("Product");

  if (rows.length === 0) {
    log.warn("No Product data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const result = await batchUpsert(
    rows,
    async (row) => {
      const sku = row.sku.trim();
      const name = nullable(row.Name);
      const weight = parseNumber(row.weight);
      const itemCost = parseDecimalCommaNumber(row.itemCost);

      // Look up existing product by matching current blob SKU + siteId
      // (case-insensitive so re-imports don't duplicate on casing changes).
      const existing = await prisma.product.findFirst({
        where: { siteId, currentBlob: { sku: { equals: sku, mode: "insensitive" } } },
        include: { currentBlob: true },
      });

      if (existing) {
        // Check if data changed — compare against current blob
        const blob = existing.currentBlob;
        const changed =
          blob?.name !== name ||
          (blob?.weight !== null ? Number(blob.weight) : null) !== weight ||
          (blob?.itemCost !== null ? Number(blob.itemCost) : null) !== itemCost;

        if (changed && blob) {
          await prisma.productBlob.update({
            where: { id: blob.id },
            data: { sku, name, weight, itemCost },
          });
        }

        idMap.set("product", row.Name, existing.id);
        return;
      }

      // Create new product + blob v1
      const product = await prisma.product.create({
        data: { siteId },
      });

      const blob = await prisma.productBlob.create({
        data: {
          version: 1,
          sku,
          name,
          weight,
          itemCost,
          productId: product.id,
        },
      });

      await prisma.product.update({
        where: { id: product.id },
        data: { currentBlobId: blob.id },
      });

      idMap.set("product", row.Name, product.id);
    },
    { label: "products" },
  );

  log.summary(result);
}
