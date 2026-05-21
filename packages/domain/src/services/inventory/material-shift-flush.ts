import prisma from "@rw/db";
import { Prisma, MaterialLedgerKind } from "@rw/db";

type TransactionClient = Prisma.TransactionClient;

export interface FlushResult {
  /** ShiftInstance id whose staging rows were swept. */
  shiftInstanceId: string;
  /** Number of staging rows that were just flushed in this call. */
  flushedRows: number;
  /** Number of staging rows that were already flushed (idempotent skip). */
  alreadyFlushed: number;
}

/**
 * Flush all unflushed `MaterialShiftUsage` rows for a single shift to the
 * ledger.
 *
 * For every staging row with `flushedAt IS NULL`:
 *   1. Insert one immutable PRODUCTION ledger entry with `quantity = -staging.quantity`.
 *      (Stored negative so balance = SUM(quantity) over the ledger.)
 *   2. Stamp `flushedAt = NOW()` and `flushedLedgerEntryId = ledger row id`
 *      on the staging row, freezing it as an audit record.
 *
 * Idempotent: re-running on a partially-flushed shift only processes rows
 * still marked unflushed. Safe to call from a scheduler, manual trigger, or
 * a lazy cycle-close sweep.
 *
 * Runs in its own transaction unless one is supplied.
 */
export async function flushShiftUsage(shiftInstanceId: string, tx?: TransactionClient): Promise<FlushResult> {
  const run = (client: TransactionClient) => flushShiftUsageInTx(client, shiftInstanceId);
  if (tx) return run(tx);
  return prisma.$transaction(run);
}

async function flushShiftUsageInTx(tx: TransactionClient, shiftInstanceId: string): Promise<FlushResult> {
  // SELECT FOR UPDATE on the unflushed rows so a concurrent flush call sees
  // either all-flushed or none-flushed. Locks are released at end of tx.
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      siteId: string;
      materialId: string;
      quantity: Prisma.Decimal;
      unit: "KG" | "LB" | "G" | "OZ";
    }>
  >`
    SELECT id, "siteId", "materialId", quantity, unit
    FROM "MaterialShiftUsage"
    WHERE "shiftInstanceId" = ${shiftInstanceId}::uuid
      AND "flushedAt" IS NULL
    FOR UPDATE
  `;

  // Count already-flushed for the report (cheap sanity-check query).
  const alreadyFlushed = await tx.materialShiftUsage.count({
    where: { shiftInstanceId, flushedAt: { not: null } },
  });

  if (rows.length === 0) {
    return { shiftInstanceId, flushedRows: 0, alreadyFlushed };
  }

  // Group by (siteId, materialId, unit). One PRODUCTION ledger row per
  // material in this shift — even if many (station, job, product) staging
  // rows contributed. Mixed units within a material would be a data issue
  // (we assume canonical unit per material), but if it happens each unit
  // gets its own ledger row to preserve fidelity.
  type GroupKey = string;
  const groupKey = (siteId: string, materialId: string, unit: string): GroupKey => `${siteId}|${materialId}|${unit}`;

  const groups = new Map<
    GroupKey,
    { siteId: string; materialId: string; unit: "KG" | "LB" | "G" | "OZ"; total: Prisma.Decimal; rowIds: string[] }
  >();
  for (const row of rows) {
    const key = groupKey(row.siteId, row.materialId, row.unit);
    const existing = groups.get(key);
    if (existing) {
      existing.total = existing.total.add(row.quantity);
      existing.rowIds.push(row.id);
    } else {
      groups.set(key, {
        siteId: row.siteId,
        materialId: row.materialId,
        unit: row.unit,
        total: new Prisma.Decimal(row.quantity.toString()),
        rowIds: [row.id],
      });
    }
  }

  const now = new Date();
  for (const g of groups.values()) {
    const ledger = await tx.materialLedgerEntry.create({
      data: {
        siteId: g.siteId,
        materialId: g.materialId,
        kind: MaterialLedgerKind.PRODUCTION,
        // Stored negative — debit. Balance = SUM(ledger.quantity).
        quantity: g.total.negated(),
        unit: g.unit,
      },
      select: { id: true },
    });
    // Stamp every contributing staging row with the same ledger id and
    // flush timestamp. They become the audit detail behind one summary row.
    await tx.materialShiftUsage.updateMany({
      where: { id: { in: g.rowIds } },
      data: { flushedAt: now, flushedLedgerEntryId: ledger.id },
    });
  }

  return { shiftInstanceId, flushedRows: rows.length, alreadyFlushed };
}

/**
 * Sweep-flush every shift at a site whose `endTime` has already passed and
 * whose staging rows are still unflushed. Cheap when there's nothing to do
 * (one indexed lookup), so safe to call as a fire-and-forget side effect at
 * cycle close.
 */
export async function flushExpiredShiftUsage(siteId: string): Promise<FlushResult[]> {
  const expired = await prisma.$queryRaw<Array<{ shiftInstanceId: string }>>`
    SELECT DISTINCT msu."shiftInstanceId"
    FROM "MaterialShiftUsage" msu
    JOIN "ShiftInstance" si ON si.id = msu."shiftInstanceId"
    WHERE msu."siteId" = ${siteId}::uuid
      AND msu."flushedAt" IS NULL
      AND si."endTime" <= NOW()
  `;
  const results: FlushResult[] = [];
  for (const { shiftInstanceId } of expired) {
    results.push(await flushShiftUsage(shiftInstanceId));
  }
  return results;
}

/**
 * Sweep-flush every expired-shift staging row across the entire system.
 * Intended for the shift-change queue worker so idle sites still get their
 * staging flushed at the boundary even when no cycles run after.
 */
export async function flushAllExpiredShiftUsage(): Promise<FlushResult[]> {
  const expired = await prisma.$queryRaw<Array<{ shiftInstanceId: string }>>`
    SELECT DISTINCT msu."shiftInstanceId"
    FROM "MaterialShiftUsage" msu
    JOIN "ShiftInstance" si ON si.id = msu."shiftInstanceId"
    WHERE msu."flushedAt" IS NULL
      AND si."endTime" <= NOW()
  `;
  const results: FlushResult[] = [];
  for (const { shiftInstanceId } of expired) {
    results.push(await flushShiftUsage(shiftInstanceId));
  }
  return results;
}
