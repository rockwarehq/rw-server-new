import { Prisma, type WeightUnit } from "@rw/db";
import type { WeightValue } from "./types.js";

// Conversion factors expressed in grams (the base unit). All values are
// exact rationals — keep the strings as written so Prisma.Decimal preserves
// precision through multiply/divide (no float intermediates).
const WEIGHT_TO_GRAMS: Record<WeightUnit, Prisma.Decimal> = {
  G: new Prisma.Decimal("1"),
  KG: new Prisma.Decimal("1000"),
  MT: new Prisma.Decimal("1000000"),
  OZ: new Prisma.Decimal("28.349523125"),
  LB: new Prisma.Decimal("453.59237"),
  TON: new Prisma.Decimal("907184.74"),
};

export function convertWeight(value: WeightValue, from: WeightUnit, to: WeightUnit): Prisma.Decimal {
  const v = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  if (from === to) return v;
  return v.mul(WEIGHT_TO_GRAMS[from]).div(WEIGHT_TO_GRAMS[to]);
}

export function weightFactorsInGrams(): Readonly<Record<WeightUnit, Prisma.Decimal>> {
  return WEIGHT_TO_GRAMS;
}
