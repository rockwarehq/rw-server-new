import prisma from "@rw/db";
import { Prisma, type WeightUnit } from "@rw/db";
import { convertWeight } from "../../lib/units/index.js";

type TransactionClient = Prisma.TransactionClient;

// ============================================================================
// Types
// ============================================================================

export interface ListInventoryFilter {
  siteId?: string;
  cycleId?: string;
  productBlobId?: string;
  jobProductBlobId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Create inventory items for a completed cycle.
 *
 * Resolves current blob IDs at close time and creates InventoryItems for each
 * active JobProduct on the given job.  The quantity field on the current
 * JobProductBlob determines how many identical items are created per JobProduct.
 * Accepts a transaction client so the caller can wrap cycle-close + inventory
 * creation in a single atomic operation.
 */
export async function createFromCycle(tx: TransactionClient, cycleId: string, jobId: string) {
  // Fetch active JobProducts with blob refs in a single raw query
  const jobProducts = await (tx as unknown as { $queryRaw: typeof prisma.$queryRaw }).$queryRaw<
    Array<{
      productId: string;
      currentBlobId: string;
      quantity: number;
      productBlobId: string;
      toolBlobId: string | null;
      toolCavityBlobId: string | null;
      materialBlobIds: string[];
    }>
  >`
    SELECT
      jp."productId",
      jp."currentBlobId",
      COALESCE(jpb.quantity, 1)::int AS quantity,
      p."currentBlobId" AS "productBlobId",
      t."currentBlobId" AS "toolBlobId",
      tc."currentBlobId" AS "toolCavityBlobId",
      COALESCE(
        (SELECT array_agg(pm."currentBlobId") FILTER (WHERE pm."currentBlobId" IS NOT NULL)
         FROM "ProductMaterial" pm
         JOIN "Material" m ON m.id = pm."materialId"
         LEFT JOIN "ProductMaterialAltGroup" mag ON mag.id = pm."altGroupId"
         WHERE pm."productId" = jp."productId"
           AND pm."archivedAt" IS NULL
           AND m."archivedAt" IS NULL
           AND m."deletedAt" IS NULL
           AND (pm."altGroupId" IS NULL OR mag."activeProductMaterialId" = pm.id)),
        '{}'
      ) AS "materialBlobIds"
    FROM "JobProduct" jp
    JOIN "JobProductBlob" jpb ON jpb.id = jp."currentBlobId"
    JOIN "Product" p ON p.id = jp."productId"
    LEFT JOIN "Tool" t ON t.id = jp."toolId"
    LEFT JOIN "ToolCavity" tc ON tc.id = jp."toolCavityId"
    WHERE jp."jobId" = ${jobId}
      AND jp."deletedAt" IS NULL
      AND jpb."isActive" = true
      AND jp."currentBlobId" IS NOT NULL
      AND p."currentBlobId" IS NOT NULL
  `;

  if (jobProducts.length === 0) {
    return [];
  }

  const txRaw = tx as unknown as { $queryRaw: typeof prisma.$queryRaw; $executeRaw: typeof prisma.$executeRaw };

  // Build flat list of items to insert
  const itemSpecs: Array<{
    productId: string;
    currentBlobId: string;
    productBlobId: string;
    toolBlobId: string | null;
    toolCavityBlobId: string | null;
    materialBlobIds: string[];
  }> = [];
  for (const jp of jobProducts) {
    for (let i = 0; i < jp.quantity; i++) {
      itemSpecs.push(jp);
    }
  }

  // Batch INSERT all inventory items in one query
  const insertValues = Prisma.join(
    itemSpecs.map(
      (s) =>
        Prisma.sql`(gen_random_uuid(), ${cycleId}::uuid, ${s.currentBlobId}::uuid, ${s.productBlobId}::uuid, ${s.toolBlobId}::uuid, ${s.toolCavityBlobId}::uuid, NOW(), NOW())`,
    ),
  );
  const itemRows = await txRaw.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "InventoryItem" (id, "cycleId", "jobProductBlobId", "productBlobId", "toolBlobId", "toolCavityBlobId", "createdAt", "updatedAt")
    VALUES ${insertValues}
    RETURNING id
  `;

  // Batch INSERT all material blob M2M relations in one query
  const matValues: Prisma.Sql[] = [];
  for (let i = 0; i < itemRows.length; i++) {
    for (const matBlobId of itemSpecs[i].materialBlobIds) {
      matValues.push(Prisma.sql`(${itemRows[i].id}::uuid, ${matBlobId}::uuid)`);
    }
  }
  if (matValues.length > 0) {
    await txRaw.$executeRaw`INSERT INTO "_InventoryItemToProductMaterialBlob" ("A", "B") VALUES ${Prisma.join(matValues)} ON CONFLICT DO NOTHING`;

    // Roll this cycle's material consumption into the staging table.
    //
    // The ledger is append-only and immutable. Active-shift consumption
    // accumulates here in `MaterialShiftUsage`; at shift close,
    // `flushShiftUsage` converts each staging row into one immutable
    // PRODUCTION ledger entry.
    //
    // Cycles without a resolved shift are silently skipped.
    const itemIds = itemRows.map((r) => r.id);

    type UsageRow = {
      siteId: string;
      shiftInstanceId: string;
      stationId: string;
      productId: string;
      materialId: string;
      qty: Prisma.Decimal;
      itemCount: number;
      // Unit declared on the ProductMaterialBlob (how the operator entered weight
      // for this product). May differ from the material's canonical unit.
      pmUnit: WeightUnit | null;
      // Material's canonical/storage unit (from currentBlob). All staging and
      // ledger writes are normalized to this unit.
      materialUnit: WeightUnit | null;
    };
    const want = await txRaw.$queryRaw<UsageRow[]>`
      WITH cycle_shift AS (
        SELECT
          c."siteId"    AS "siteId",
          c."stationId" AS "stationId",
          si.id         AS "shiftInstanceId"
        FROM "Cycle" c
        JOIN "Station" s ON s.id = c."stationId"
        LEFT JOIN "ShiftInstance" si
          ON si."siteId" = c."siteId"
         AND si."startTime" <= COALESCE(c."end", c."start")
         AND si."endTime"   >  COALESCE(c."end", c."start")
         AND (si."workCenterId" IS NULL OR si."workCenterId" = s."workcenterId")
        WHERE c.id = ${cycleId}::uuid
        ORDER BY (si."workCenterId" IS NOT NULL) DESC, si."startTime" DESC
        LIMIT 1
      )
      SELECT
        cs."siteId"            AS "siteId",
        cs."shiftInstanceId"   AS "shiftInstanceId",
        cs."stationId"         AS "stationId",
        pb."productId"         AS "productId",
        mb."materialId"        AS "materialId",
        SUM(pmb.weight)        AS "qty",
        COUNT(DISTINCT ii.id)::int AS "itemCount",
        pmb."weightUnits"      AS "pmUnit",
        mbc."weightUnits"      AS "materialUnit"
      FROM "_InventoryItemToProductMaterialBlob" x
      JOIN "InventoryItem"        ii  ON ii.id = x."A"
      JOIN "ProductBlob"          pb  ON pb.id = ii."productBlobId"
      JOIN "ProductMaterialBlob"  pmb ON pmb.id = x."B"
      JOIN "MaterialBlob"         mb  ON mb.id = pmb."materialBlobId"
      JOIN "Material"             m   ON m.id  = mb."materialId"
      LEFT JOIN "MaterialBlob"    mbc ON mbc.id = m."currentBlobId"
      CROSS JOIN cycle_shift cs
      WHERE x."A" = ANY(${itemIds}::uuid[])
        AND pmb.weight IS NOT NULL
        AND cs."shiftInstanceId" IS NOT NULL
      GROUP BY cs."siteId", cs."shiftInstanceId", cs."stationId", pb."productId", mb."materialId", pmb."weightUnits", mbc."weightUnits"
    `;

    if (want.length === 0) return itemRows.map((row, i) => ({ id: row.id, productId: itemSpecs[i].productId }));

    // For each (shift, station, job, product, material) scope: get-or-create
    // the staging row and bump its quantity + itemCount. Ledger is untouched.
    for (const w of want) {
      const bindingKey = {
        shiftInstanceId_stationId_jobId_productId_materialId: {
          shiftInstanceId: w.shiftInstanceId,
          stationId: w.stationId,
          jobId,
          productId: w.productId,
          materialId: w.materialId,
        },
      };

      // Normalize to the material's canonical unit. PM weight may be entered
      // in a different unit (e.g. material stocked in KG, product consumes G);
      // staging and downstream ledger entries are always in the material unit.
      // If the material has no canonical unit, discard the usage — assuming a
      // default would silently mis-stamp ledger entries.
      if (w.materialUnit === null) {
        console.warn(
          `[cycle ${cycleId}] material ${w.materialId} has no weightUnit set; discarding usage qty=${w.qty} for product ${w.productId}`,
        );
        continue;
      }
      const canonicalUnit: WeightUnit = w.materialUnit;
      const pmUnit: WeightUnit = w.pmUnit ?? canonicalUnit;
      const qtyDelta = convertWeight(w.qty, pmUnit, canonicalUnit);

      const existing = await tx.materialShiftUsage.findUnique({
        where: bindingKey,
        select: { id: true, flushedAt: true },
      });

      if (existing) {
        if (existing.flushedAt) {
          // The staging row is already flushed — don't mutate a frozen audit
          // record. This indicates a cycle close happened on a closed shift,
          // which shouldn't occur in normal flow but might via replay/import.
          // Loud, not silent — surface it.
          console.warn(
            `[cycle ${cycleId}] staging row ${existing.id} for shift=${w.shiftInstanceId} already flushed; skipping increment`,
          );
          continue;
        }
        await tx.materialShiftUsage.update({
          where: { id: existing.id },
          data: {
            quantity: { increment: qtyDelta },
            itemCount: { increment: w.itemCount },
          },
        });
      } else {
        await tx.materialShiftUsage.create({
          data: {
            siteId: w.siteId,
            shiftInstanceId: w.shiftInstanceId,
            stationId: w.stationId,
            jobId,
            productId: w.productId,
            materialId: w.materialId,
            quantity: qtyDelta,
            unit: canonicalUnit,
            itemCount: w.itemCount,
          },
        });
      }
    }
  }

  return itemRows.map((row, i) => ({ id: row.id, productId: itemSpecs[i].productId }));
}

// ============================================================================
// Query Operations
// ============================================================================

/**
 * List inventory items with optional filtering
 */
export async function list(filter: ListInventoryFilter = {}) {
  const { siteId, cycleId, productBlobId, jobProductBlobId, dateFrom, dateTo, limit = 50, offset = 0 } = filter;

  const where: Prisma.InventoryItemWhereInput = {
    deletedAt: null,
  };

  if (cycleId) {
    where.cycleId = cycleId;
  }

  if (productBlobId) {
    where.productBlobId = productBlobId;
  }

  if (jobProductBlobId) {
    where.jobProductBlobId = jobProductBlobId;
  }

  // Filter by site through the cycle -> site relation
  if (siteId) {
    where.cycle = {
      siteId,
    };
  }

  // Date range filter
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) {
      where.createdAt.gte = dateFrom;
    }
    if (dateTo) {
      where.createdAt.lte = dateTo;
    }
  }

  const [items, total] = await Promise.all([
    prisma.inventoryItem.findMany({
      where,
      include: {
        cycle: {
          select: {
            id: true,
            cycleStatus: true,
            start: true,
            end: true,
            order: {
              select: {
                id: true,
                orderNumber: true,
              },
            },
          },
        },
        productBlob: {
          select: {
            id: true,
            version: true,
            sku: true,
            name: true,
          },
        },
        jobProductBlob: {
          select: {
            id: true,
            version: true,
            isActive: true,
          },
        },
        toolBlob: {
          select: {
            id: true,
            version: true,
            name: true,
          },
        },
        toolCavityBlob: {
          select: {
            id: true,
            version: true,
            name: true,
            position: true,
          },
        },
        productMaterialBlobs: {
          select: {
            id: true,
            version: true,
            weight: true,
            weightUnits: true,
            itemCost: true,
            materialBlob: {
              select: {
                id: true,
                version: true,
                name: true,
                materialNumber: true,
                shortCode: true,
              },
            },
          },
        },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.inventoryItem.count({ where }),
  ]);

  return {
    data: items,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get inventory item by ID with full blob details
 */
export async function getById(id: string) {
  const item = await prisma.inventoryItem.findUnique({
    where: { id },
    include: {
      cycle: {
        select: {
          id: true,
          cycleStatus: true,
          start: true,
          end: true,
          site: {
            select: { id: true, name: true },
          },
          order: {
            select: {
              id: true,
              orderNumber: true,
              job: {
                select: {
                  id: true,
                },
              },
            },
          },
        },
      },
      productBlob: true,
      jobProductBlob: true,
      toolBlob: true,
      toolCavityBlob: true,
      productMaterialBlobs: {
        include: {
          materialBlob: true,
        },
      },
    },
  });

  if (!item) {
    return null;
  }

  if (item.deletedAt) {
    return { error: "Inventory item has been deleted", code: "INVENTORY_ITEM_DELETED" };
  }

  return { data: item };
}

/**
 * Get all inventory items from a specific cycle
 */
export async function getByCycle(cycleId: string) {
  // Verify cycle exists
  const cycle = await prisma.cycle.findUnique({
    where: { id: cycleId },
    select: {
      id: true,
      cycleStatus: true,
      start: true,
      end: true,
      site: {
        select: { id: true, name: true },
      },
      order: {
        select: {
          id: true,
          orderNumber: true,
          job: {
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  if (!cycle) {
    return { error: "Cycle not found", code: "CYCLE_NOT_FOUND" };
  }

  const items = await prisma.inventoryItem.findMany({
    where: {
      cycleId,
      deletedAt: null,
    },
    include: {
      productBlob: {
        select: {
          id: true,
          version: true,
          sku: true,
          name: true,
        },
      },
      jobProductBlob: {
        select: {
          id: true,
          version: true,
          isActive: true,
        },
      },
      toolBlob: {
        select: {
          id: true,
          version: true,
          name: true,
        },
      },
      toolCavityBlob: {
        select: {
          id: true,
          version: true,
          name: true,
          position: true,
        },
      },
      productMaterialBlobs: {
        select: {
          id: true,
          version: true,
          weight: true,
          weightUnits: true,
          itemCost: true,
          materialBlob: {
            select: {
              id: true,
              version: true,
              name: true,
              materialNumber: true,
              shortCode: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    data: {
      cycle,
      items,
      count: items.length,
    },
  };
}
