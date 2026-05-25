import { publishMetricChange } from "../rpc/metrics-bus.js";

// ── Bucket change notification ───────────────────────────────────
// Called whenever MetricBucket rows are mutated. Receives a batch of
// all changes from a single operation. Flattens each change into a
// list of { path, value } entries for downstream consumers (e.g. a
// Redis key-value store).
//
// Path format:
//   {entityHierarchyPath}.{GRANULARITY}.{epochSeconds}.{columnName}
//
// Example:
//   site.abc.workcenter.def.station.ghi.HOUR.1773243000.totalCycles
//
// The flattened form remains exported for future key-value store
// integrations. Real-time subscribers are notified via the RPC
// metrics event bus.

// ── Types ────────────────────────────────────────────────────────

/** Prisma Decimal-like value (has a toString / valueOf). */
type DecimalLike = { toString(): string } | number;

/**
 * Complete snapshot of all KPI columns on a MetricBucket row.
 *
 * Includes:
 * - 18 additive KPI fields (integers)
 * - currentStandardCycle (display, nullable decimal)
 * - 4 computed OEE ratios (DB-generated, nullable decimals)
 *
 * All values are absolute (not deltas). Callers must read back the
 * full row state after writes to populate this correctly.
 */
export interface BucketSnapshot {
  // ── Counting KPIs ──────────────────────────────────────────────
  totalCycles: number;
  goodCycles: number;
  badCycles: number;
  totalItems: number;
  goodItems: number;
  badItems: number;
  expectedCycles: number;
  expectedItems: number;
  // ── Duration KPIs (integer seconds) ────────────────────────────
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
  plannedProductionSeconds: number;
  // ── Time KPIs (integer seconds) ────────────────────────────────
  idealCycleSeconds: number;
  totalCycleSeconds: number;
  // ── Elapsed KPIs ───────────────────────────────────────────────
  elapsedExpectedCycles: number;
  elapsedExpectedItems: number;
  elapsedPlannedProductionSeconds: number;
  // ── Display field ──────────────────────────────────────────────
  currentStandardCycle: number | null;
  // ── Computed OEE ratios (DB-generated) ─────────────────────────
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
  // ── Shift instance reference ───────────────────────────────────
  /** ShiftInstance ID this bucket falls within. Null for DAY, clock-aligned hours, etc. */
  shiftInstanceId: string | null;
  // ── Context fields ────────────────────────────────────────────
  /** Business date (ISO "YYYY-MM-DD"). Null when not yet resolved. */
  businessDate: string | null;
  /** Human-readable shift name (e.g. "Shift 1"). Null for DAY or when no shift. */
  businessShift: string | null;
  /** Current job ID on the station. Null for WORKCENTER/SITE or when no job assigned. */
  currentJobId: string | null;
  /** Human-readable name of the current job. Same semantics as currentJobId. */
  currentJobName: string | null;
}

/**
 * All field names in BucketSnapshot, in the order they should be
 * emitted. Exported so callers can iterate without hardcoding keys.
 */
export const SNAPSHOT_KEYS: ReadonlyArray<keyof BucketSnapshot> = [
  "totalCycles",
  "goodCycles",
  "badCycles",
  "totalItems",
  "goodItems",
  "badItems",
  "expectedCycles",
  "expectedItems",
  "runSeconds",
  "downSeconds",
  "plannedDownSeconds",
  "unplannedDownSeconds",
  "plannedProductionSeconds",
  "idealCycleSeconds",
  "totalCycleSeconds",
  "elapsedExpectedCycles",
  "elapsedExpectedItems",
  "elapsedPlannedProductionSeconds",
  "currentStandardCycle",
  "availability",
  "performance",
  "quality",
  "oee",
  "shiftInstanceId",
  "businessDate",
  "businessShift",
  "currentJobId",
  "currentJobName",
] as const;

export interface BucketChange {
  /** Which site owns this bucket */
  siteId: string;
  /** Entity type the bucket belongs to */
  entityType: "STATION" | "WORKCENTER" | "SITE" | "JOB";
  /** Entity ID the bucket belongs to */
  entityId: string;
  /** Human-readable name of the entity */
  entityName: string;
  /** Hierarchical dotted path encoding the entity's full ancestry */
  path: string;
  /** Time granularity of the bucket */
  granularity: "MINUTE" | "HOUR" | "SHIFT" | "DAY";
  /** Human-readable granularity label (e.g. "Hour", "Shift 1", "Day") */
  granularityName: string;
  /** Start of the bucket window */
  startTime: Date;
  /** Duration of the bucket window in seconds */
  durationSeconds: number;
  /** ShiftInstance ID this bucket falls within. Null for DAY, clock-aligned hours, etc. */
  shiftInstanceId: string | null;
  /** Business date this bucket belongs to. Null when not yet resolved. */
  businessDate: Date | null;
  /** Human-readable shift name (e.g. "Shift 1"). Null for DAY or when no shift. */
  businessShift: string | null;
  /** Full current state of all KPI columns */
  snapshot: BucketSnapshot;
}

/** A single key-value entry for downstream consumers. */
export interface KeyValue {
  path: string;
  value: number | string | null;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Convert a Prisma Decimal (or null) to a plain number (or null). */
export function decimalToNumber(val: DecimalLike | null | undefined): number | null {
  if (val == null) return null;
  return Number(val);
}

/**
 * Build a BucketSnapshot from a Prisma MetricBucket row.
 *
 * Handles Decimal → number conversion for the 5 decimal columns.
 * Accepts any object with at least the required fields (the Prisma
 * return type has more fields, which are ignored).
 */
export function rowToSnapshot(row: {
  totalCycles: number;
  goodCycles: number | null;
  badCycles: number;
  totalItems: number;
  goodItems: number | null;
  badItems: number;
  expectedCycles: number;
  expectedItems: number;
  runSeconds: number;
  downSeconds: number;
  plannedDownSeconds: number;
  unplannedDownSeconds: number;
  plannedProductionSeconds: number | null;
  idealCycleSeconds: number;
  totalCycleSeconds: number;
  elapsedExpectedCycles: number;
  elapsedExpectedItems: number;
  elapsedPlannedProductionSeconds: number;
  currentStandardCycle: DecimalLike | null;
  availability: DecimalLike | null;
  performance: DecimalLike | null;
  quality: DecimalLike | null;
  oee: DecimalLike | null;
  shiftInstanceId?: string | null;
  businessDate?: Date | null;
  businessShift?: string | null;
  currentJobId?: string | null;
  currentJobName?: string | null;
}): BucketSnapshot {
  return {
    totalCycles: row.totalCycles,
    goodCycles: row.goodCycles ?? 0,
    badCycles: row.badCycles,
    totalItems: row.totalItems,
    goodItems: row.goodItems ?? 0,
    badItems: row.badItems,
    expectedCycles: row.expectedCycles,
    expectedItems: row.expectedItems,
    runSeconds: row.runSeconds,
    downSeconds: row.downSeconds,
    plannedDownSeconds: row.plannedDownSeconds,
    unplannedDownSeconds: row.unplannedDownSeconds,
    plannedProductionSeconds: row.plannedProductionSeconds ?? 0,
    idealCycleSeconds: row.idealCycleSeconds,
    totalCycleSeconds: row.totalCycleSeconds,
    elapsedExpectedCycles: row.elapsedExpectedCycles,
    elapsedExpectedItems: row.elapsedExpectedItems,
    elapsedPlannedProductionSeconds: row.elapsedPlannedProductionSeconds,
    currentStandardCycle: decimalToNumber(row.currentStandardCycle),
    availability: decimalToNumber(row.availability),
    performance: decimalToNumber(row.performance),
    quality: decimalToNumber(row.quality),
    oee: decimalToNumber(row.oee),
    shiftInstanceId: row.shiftInstanceId ?? null,
    businessDate: row.businessDate ? row.businessDate.toISOString().slice(0, 10) : null,
    businessShift: row.businessShift ?? null,
    currentJobId: row.currentJobId ?? null,
    currentJobName: row.currentJobName ?? null,
  };
}

/** A zero-valued snapshot for scaffolding (newly created empty buckets). */
export const ZERO_SNAPSHOT: Readonly<BucketSnapshot> = Object.freeze({
  totalCycles: 0,
  goodCycles: 0,
  badCycles: 0,
  totalItems: 0,
  goodItems: 0,
  badItems: 0,
  expectedCycles: 0,
  expectedItems: 0,
  runSeconds: 0,
  downSeconds: 0,
  plannedDownSeconds: 0,
  unplannedDownSeconds: 0,
  plannedProductionSeconds: 0,
  idealCycleSeconds: 0,
  totalCycleSeconds: 0,
  elapsedExpectedCycles: 0,
  elapsedExpectedItems: 0,
  elapsedPlannedProductionSeconds: 0,
  currentStandardCycle: null,
  availability: null,
  performance: null,
  quality: null,
  oee: null,
  shiftInstanceId: null,
  businessDate: null,
  businessShift: null,
  currentJobId: null,
  currentJobName: null,
});

// ── Flattening ───────────────────────────────────────────────────

/**
 * Flatten a batch of BucketChanges into an array of { path, value }
 * entries suitable for a key-value store.
 *
 * Path format:
 *   {entityPath}.{GRANULARITY}.{epochSeconds}.{columnName}
 */
export function flattenChanges(changes: BucketChange[]): KeyValue[] {
  const entries: KeyValue[] = [];

  for (const change of changes) {
    const epochSeconds = Math.floor(change.startTime.getTime() / 1000);
    const prefix = `${change.path}.${change.granularity}.${epochSeconds}`;

    for (const key of SNAPSHOT_KEYS) {
      entries.push({ path: `${prefix}.${key}`, value: change.snapshot[key] });
    }
  }

  return entries;
}

// ── Notification ─────────────────────────────────────────────────

/**
 * Called whenever metric buckets are mutated.
 *
 * Receives a batch of all changes from a single operation. Each
 * change carries the full current state (snapshot) of the bucket.
 *
 * Publishes each changed bucket to the in-process metrics event bus.
 * flattenChanges remains exported for future key-value store sync.
 */
export async function onBucketsChanged(changes: BucketChange[]): Promise<void> {
  if (changes.length === 0) return;

  // Publish only the bucket `change` event. The per-metric value events are
  // expanded in-process by subscribers (see metrics-bus emitLocalBucketValues),
  // so we no longer fan out ~20 value publishes per change over Redis.
  for (const change of changes) {
    publishMetricChange(change);
  }
}
