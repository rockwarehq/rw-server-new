import prisma from "@rw/db";
import { Prisma, type WeightUnit } from "@rw/db";

export interface MaterialBalance {
  materialId: string;
  /** Canonical weight unit of the material (from its current MaterialBlob). */
  unit: WeightUnit | null;
  /** Sum of RECEIPT + TRANSFER_IN + OPENING_BALANCE ledger entries. */
  received: Prisma.Decimal;
  /** Net signed sum of ADJUSTMENT entries. */
  adjusted: Prisma.Decimal;
  /** Total consumed: WRITE_OFF + TRANSFER_OUT + PRODUCTION (all ledger-sourced). */
  consumed: Prisma.Decimal;
  /** received + adjusted − consumed. */
  balance: Prisma.Decimal;
  /** If the caller passed `asOf`, echoed here; otherwise null. */
  asOf: Date | null;
}

/**
 * Compute a material's on-hand balance.
 *
 * Balance has two sources:
 *   1. `MaterialLedgerEntry` — append-only immutable rows for receipts,
 *      adjustments, write-offs, transfers, and (post-flush) PRODUCTION.
 *   2. `MaterialShiftUsage` (unflushed) — mid-shift accumulating consumption
 *      that hasn't been flushed to the ledger yet.
 *
 * Active-shift staging counts as consumption-in-progress, so we subtract
 * unflushed staging quantity from the ledger sum. After a shift flushes,
 * its rows move into the ledger as PRODUCTION entries and the staging side
 * stops contributing.
 *
 * `asOf` filters the ledger side on `createdAt` (immutable, so this is the
 * actual transaction time). The staging side is "right now" by definition.
 */
export async function balance(materialId: string, asOf?: Date): Promise<MaterialBalance> {
  const asOfParam = asOf ?? null;

  const rows = await prisma.$queryRaw<
    Array<{
      received: Prisma.Decimal;
      adjusted: Prisma.Decimal;
      consumed: Prisma.Decimal;
      balance: Prisma.Decimal;
    }>
  >`
    WITH ledger_agg AS (
      SELECT
        COALESCE(SUM(quantity) FILTER (WHERE kind IN ('RECEIPT','TRANSFER_IN','OPENING_BALANCE')), 0) AS received,
        COALESCE(SUM(quantity) FILTER (WHERE kind = 'ADJUSTMENT'), 0) AS adjusted,
        COALESCE(SUM(quantity) FILTER (WHERE kind IN ('WRITE_OFF','TRANSFER_OUT','PRODUCTION')), 0) AS consumed_signed
      FROM "MaterialLedgerEntry"
      WHERE "materialId" = ${materialId}::uuid
        AND (${asOfParam}::timestamptz IS NULL OR "createdAt" <= ${asOfParam}::timestamptz)
    ),
    staging_agg AS (
      SELECT COALESCE(SUM(quantity), 0) AS pending
      FROM "MaterialShiftUsage"
      WHERE "materialId" = ${materialId}::uuid
        AND "flushedAt" IS NULL
    )
    SELECT
      l.received,
      l.adjusted,
      (-l.consumed_signed + s.pending) AS consumed,
      (l.received + l.adjusted + l.consumed_signed - s.pending) AS balance
    FROM ledger_agg l, staging_agg s
  `;

  const material = await prisma.material.findUnique({
    where: { id: materialId },
    select: { currentBlob: { select: { weightUnits: true } } },
  });

  const row = rows[0];
  const zero = new Prisma.Decimal(0);

  return {
    materialId,
    unit: material?.currentBlob?.weightUnits ?? null,
    received: row?.received ?? zero,
    adjusted: row?.adjusted ?? zero,
    consumed: row?.consumed ?? zero,
    balance: row?.balance ?? zero,
    asOf: asOf ?? null,
  };
}
