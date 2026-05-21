import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

type TransactionClient = Prisma.TransactionClient;

// ============================================================================
// Inventory → Order allocation
// ============================================================================

/**
 * Allocate a newly created InventoryItem to the highest-priority open order
 * for the given product. Called inside the cycle-completion transaction.
 *
 * Side effects:
 * - Creates an OrderInventoryAllocation record
 * - Increments OrderLineItem.completedQuantity
 * - Transitions OPEN orders to IN_PROGRESS on first allocation
 * - Demotes lower-priority IN_PROGRESS orders with the same product to OPEN
 * - Auto-completes the order if all line items are fulfilled (when enabled)
 */
export async function allocateInventory(
  tx: TransactionClient,
  siteId: string,
  productId: string,
  inventoryItemId: string,
) {
  const txRaw = tx as unknown as { $queryRaw: typeof prisma.$queryRaw; $executeRaw: typeof prisma.$executeRaw };

  // Bring any stale line-item statuses into agreement with their quantities.
  // Always-on: status is a denormalized view of quantities and should match.
  await txRaw.$executeRaw`
    UPDATE "OrderLineItem"
    SET status = 'COMPLETED', "updatedAt" = NOW()
    WHERE status <> 'COMPLETED'
      AND "completedQuantity" > 0
      AND ("completedQuantity" - "scrapQuantity") >= "targetQuantity"
      AND "orderId" IN (SELECT id FROM "Order" WHERE "siteId" = ${siteId}::uuid)
  `;

  // When orderAutoComplete is on, heal any OPEN/IN_PROGRESS orders whose line
  // items are all fulfilled. Covers orders that were over-allocated before the
  // flag was flipped on.
  await txRaw.$executeRaw`
    UPDATE "Order" SET status = 'COMPLETED', "updatedAt" = NOW()
    WHERE "siteId" = ${siteId}::uuid
      AND status IN ('OPEN', 'IN_PROGRESS')
      AND "deletedAt" IS NULL
      AND (SELECT COALESCE((attrs->>'orderAutoComplete')::boolean, false)
           FROM "Site" WHERE id = ${siteId}::uuid)
      AND EXISTS (SELECT 1 FROM "OrderLineItem" oli WHERE oli."orderId" = "Order".id)
      AND NOT EXISTS (
        SELECT 1 FROM "OrderLineItem" oli
        WHERE oli."orderId" = "Order".id
          AND (oli."completedQuantity" - oli."scrapQuantity") < oli."targetQuantity"
      )
  `;

  // Check site config for auto-complete + find eligible order in one query
  const rows = await txRaw.$queryRaw<
    Array<{
      autoComplete: boolean;
      orderId: string | null;
      orderStatus: string | null;
      orderSequence: number | null;
      lineItemId: string | null;
      completedQuantity: number;
      targetQuantity: number;
      scrapQuantity: number;
    }>
  >`
    WITH site_config AS (
      SELECT COALESCE((attrs->>'orderAutoComplete')::boolean, false) AS "autoComplete"
      FROM "Site" WHERE id = ${siteId}::uuid
    ),
    eligible AS (
      SELECT o.id AS "orderId", o.status AS "orderStatus", o.sequence AS "orderSequence",
             oli.id AS "lineItemId", oli."completedQuantity", oli."targetQuantity", oli."scrapQuantity"
      FROM "Order" o
      JOIN "OrderLineItem" oli ON oli."orderId" = o.id AND oli."productId" = ${productId}::uuid
      WHERE o."siteId" = ${siteId}::uuid
        AND o.status IN ('OPEN', 'IN_PROGRESS')
        AND o."deletedAt" IS NULL
      ORDER BY o.sequence ASC NULLS LAST
    )
    SELECT sc."autoComplete",
           e."orderId", e."orderStatus", e."orderSequence",
           e."lineItemId", e."completedQuantity", e."targetQuantity", e."scrapQuantity"
    FROM site_config sc
    LEFT JOIN eligible e ON true
    WHERE e."lineItemId" IS NULL
       OR NOT (sc."autoComplete" AND (e."completedQuantity" - e."scrapQuantity") >= e."targetQuantity")
    LIMIT 1
  `;

  if (rows.length === 0 || !rows[0].orderId) return;

  const {
    autoComplete,
    orderId,
    orderStatus,
    orderSequence,
    lineItemId,
    completedQuantity,
    targetQuantity,
    scrapQuantity,
  } = rows[0];
  if (!lineItemId) return;

  const newCompleted = completedQuantity + 1;
  const newStatus = newCompleted - scrapQuantity >= targetQuantity ? "COMPLETED" : "IN_PROGRESS";

  // Create allocation + increment completed + transition order in parallel-safe sequential raw SQL
  await txRaw.$executeRaw`
    INSERT INTO "OrderInventoryAllocation" (id, "inventoryItemId", "orderLineItemId", quantity, "createdAt")
    VALUES (gen_random_uuid(), ${inventoryItemId}::uuid, ${lineItemId}::uuid, 1, NOW())
  `;

  await txRaw.$executeRaw`
    UPDATE "OrderLineItem"
    SET "completedQuantity" = "completedQuantity" + 1,
        status = ${newStatus}::"LineItemStatus",
        "updatedAt" = NOW()
    WHERE id = ${lineItemId}::uuid
  `;

  if (orderStatus === "OPEN") {
    await txRaw.$executeRaw`
      UPDATE "Order" SET status = 'IN_PROGRESS', "previousStatus" = 'OPEN', "updatedAt" = NOW()
      WHERE id = ${orderId}::uuid
    `;
  }

  // Demote lower-priority orders
  if (orderSequence != null) {
    await txRaw.$executeRaw`
      UPDATE "Order" SET status = 'OPEN', "previousStatus" = 'IN_PROGRESS', "updatedAt" = NOW()
      WHERE "siteId" = ${siteId}::uuid
        AND status = 'IN_PROGRESS'
        AND "deletedAt" IS NULL
        AND sequence > ${orderSequence}
        AND id != ${orderId}::uuid
        AND EXISTS (SELECT 1 FROM "OrderLineItem" oli WHERE oli."orderId" = "Order".id AND oli."productId" = ${productId}::uuid)
    `;
  }

  // Auto-complete check
  if (autoComplete) {
    const unfulfilled = await txRaw.$queryRaw<Array<{ cnt: number }>>`
      SELECT COUNT(*)::int AS cnt FROM "OrderLineItem"
      WHERE "orderId" = ${orderId}::uuid
        AND ("completedQuantity" - "scrapQuantity") < "targetQuantity"
    `;
    if (unfulfilled[0].cnt === 0) {
      await txRaw.$executeRaw`
        UPDATE "Order" SET status = 'COMPLETED', "updatedAt" = NOW() WHERE id = ${orderId}::uuid
      `;
    }
  }
}

// ============================================================================
// Scrap disposition → Order deduction
// ============================================================================

/**
 * Deduct from the highest-priority IN_PROGRESS order when a disposition
 * (scrap, rework, etc.) is recorded.
 */
export async function deductScrap(siteId: string, productId: string, quantity: number) {
  await prisma.$transaction(async (tx) => {
    // Check site config
    const site = await tx.site.findUnique({
      where: { id: siteId },
      select: { attrs: true },
    });
    const attrs = (site?.attrs as Record<string, unknown>) ?? {};
    const autoComplete = attrs.orderAutoComplete === true;

    // Find the highest-priority IN_PROGRESS order with this product
    const order = await tx.order.findFirst({
      where: {
        siteId,
        status: "IN_PROGRESS",
        deletedAt: null,
        lineItems: {
          some: { productId, completedQuantity: { gt: 0 } },
        },
      },
      select: {
        id: true,
        status: true,
        lineItems: {
          where: { productId },
          select: { id: true, completedQuantity: true, targetQuantity: true, scrapQuantity: true },
        },
      },
      orderBy: { sequence: { sort: "asc", nulls: "last" } },
    });

    if (!order || order.lineItems.length === 0) return;

    const lineItem = order.lineItems[0];
    const newScrap = lineItem.scrapQuantity + quantity;
    const goodCount = lineItem.completedQuantity - newScrap;

    // Create negative allocation for audit trail
    await tx.orderInventoryAllocation.create({
      data: {
        inventoryItemId: null,
        orderLineItemId: lineItem.id,
        quantity: -quantity,
      },
    });

    // Update line item quantities — completedQuantity (total produced) stays unchanged
    let newStatus: "PENDING" | "IN_PROGRESS" | "COMPLETED" = "IN_PROGRESS";
    if (lineItem.completedQuantity === 0) newStatus = "PENDING";
    else if (goodCount >= lineItem.targetQuantity) newStatus = "COMPLETED";

    await tx.orderLineItem.update({
      where: { id: lineItem.id },
      data: {
        scrapQuantity: { increment: quantity },
        status: newStatus,
      },
    });

    // If order was auto-completed and now drops below 100%, revert to IN_PROGRESS
    if (autoComplete && order.status === "COMPLETED") {
      const allLineItems = await tx.orderLineItem.findMany({
        where: { orderId: order.id },
        select: { completedQuantity: true, targetQuantity: true, scrapQuantity: true },
      });

      const stillFulfilled = allLineItems.every((li) => li.completedQuantity - li.scrapQuantity >= li.targetQuantity);

      if (!stillFulfilled) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: "IN_PROGRESS" },
        });
      }
    }
  });
}
