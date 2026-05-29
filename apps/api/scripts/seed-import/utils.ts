import fs from "node:fs/promises";
import config from "./config.js";
import { WeightUnit } from "@rw/db";

// ---------------------------------------------------------------------------
// Blob versioning convention for importers
// ---------------------------------------------------------------------------
// Importers update the current blob *in place* when source data changes — they
// do NOT bump `version`. Only the application's own write paths (e.g.
// src/services/inventory/product.ts) create new blob versions on edit. This
// keeps audit history meaningful (every version row corresponds to a real user
// action) and avoids the "fields the importer doesn't carry get nulled on
// re-import" bug. Importers still create v1 blobs for newly-created records.

// ---------------------------------------------------------------------------
// Fixed-width text parser (SSMS "Results to Text" / sqlcmd output)
// ---------------------------------------------------------------------------

const DEFAULT_DATA_FILE = "sqlLegacyData.txt";
const SECTION_MARKER = /^===\s*(.+?)\s*===$/;

/** Cached parsed data per filename — loaded once per file on first call to readData(). */
const dataCache = new Map<string, Record<string, Record<string, string>[]>>();

/** Override the data filename for all subsequent readData() calls. */
let activeDataFile = DEFAULT_DATA_FILE;

export function setDataFile(filename: string): void {
  activeDataFile = filename;
}

/**
 * Dev-seed mode flag. When true, importers may fabricate entities or
 * relationships that aren't in the source data so dev scenarios are
 * runnable end-to-end (e.g. auto-creating a Tool + cavity for every
 * production Job, picking arbitrary current jobs for stations, assigning
 * simple products to cavity 1). The real `db:import` path leaves it false
 * so source NULLs are preserved.
 */
let devSeedEnabled = false;

export function setDevSeed(enabled: boolean): void {
  devSeedEnabled = enabled;
}

export function isDevSeed(): boolean {
  return devSeedEnabled;
}

/**
 * Load and parse a data file. Sections are delimited by
 * `=== SectionName ===` markers. Each section contains SSMS fixed-width
 * text output: header row, dash separator, data rows, optional footer.
 */
async function loadDataFile(): Promise<Record<string, Record<string, string>[]>> {
  const cached = dataCache.get(activeDataFile);
  if (cached) return cached;

  const filePath = new URL(`./data/${activeDataFile}`, import.meta.url);
  const raw = await fs.readFile(filePath, "utf-8");

  const parsed = parseFixedWidthSections(raw);
  dataCache.set(activeDataFile, parsed);
  return parsed;
}

/**
 * Parse the full file content into named sections of row objects.
 */
export function parseFixedWidthSections(
  text: string,
): Record<string, Record<string, string>[]> {
  const result: Record<string, Record<string, string>[]> = {};
  const lines = text.split(/\r?\n/);

  let currentSection: string | null = null;
  let sectionLines: string[] = [];

  const flushSection = () => {
    if (currentSection && sectionLines.length > 0) {
      result[currentSection] = parseFixedWidthTable(sectionLines);
    }
    sectionLines = [];
  };

  for (const line of lines) {
    const match = line.match(SECTION_MARKER);
    if (match) {
      flushSection();
      currentSection = match[1];
      continue;
    }

    if (currentSection) {
      // Skip comment lines (// or #) — useful for notes about mappings
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("#")) continue;

      sectionLines.push(line);
    }
  }

  // Flush last section
  flushSection();

  return result;
}

/**
 * Parse a single section's lines (header, dashes, data rows) into objects.
 *
 * The dash separator line defines column boundaries:
 *   name       Description
 *   ---------- --------------------
 *   ALL        All
 *
 * Columns are extracted by position based on dash groups.
 */
function parseFixedWidthTable(lines: string[]): Record<string, string>[] {
  // Find the dash separator line — it's the first line that is only dashes and spaces
  const dashIndex = lines.findIndex((l) => /^[-\s]+$/.test(l) && l.includes("-"));
  if (dashIndex < 1) return []; // need at least a header before the dashes

  const headerLine = lines[dashIndex - 1];
  const dashLine = lines[dashIndex];

  // Determine column boundaries from dash groups
  const columns: Array<{ name: string; start: number; end: number }> = [];
  const dashRegex = /-+/g;
  let dashMatch: RegExpExecArray | null;

  while ((dashMatch = dashRegex.exec(dashLine)) !== null) {
    const start = dashMatch.index;
    const end = start + dashMatch[0].length;
    const name = headerLine.substring(start, end).trim();
    columns.push({ name, start, end });
  }

  if (columns.length === 0) return [];

  // Parse data rows (everything after the dash line, ignoring empty lines and footer)
  const rows: Record<string, string>[] = [];

  for (let i = dashIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines and SSMS footer noise:
    //   "(N row(s) affected)"        — emitted after every result set
    //   "Completion time: <ISO ts>"  — emitted at the end of script execution
    const trimmed = line.trim();
    if (
      !trimmed ||
      /^\(\d+ rows? affected\)/.test(trimmed) ||
      /^Completion time:/i.test(trimmed)
    ) {
      continue;
    }

    const row: Record<string, string> = {};
    for (const col of columns) {
      const raw = line.substring(col.start, col.end).trim();
      row[col.name] = raw === "NULL" ? "" : raw;
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Read a named section from the data file. Returns typed rows.
 * Returns an empty array if the section doesn't exist (allows skipping).
 */
export async function readData<T>(
  section: string,
): Promise<T[]> {
  const data = await loadDataFile();
  const rows = data[section];
  if (!rows || rows.length === 0) return [];
  return rows as T[];
}

// ---------------------------------------------------------------------------
// ID mapping (old SQL Server IDs -> new Postgres UUIDs)
// ---------------------------------------------------------------------------

/**
 * Stores mappings from old source IDs to new Postgres IDs, keyed by table name.
 *
 * Usage:
 *   idMap.set("products", oldSqlServerId, newPostgresId);
 *   const pgId = idMap.require("products", oldSqlServerId);
 */
export class IdMap {
  private maps = new Map<string, Map<string, string>>();

  /** Store a mapping from an old ID to a new ID for a given table. Keys are case-insensitive. */
  set(table: string, oldId: string, newId: string): void {
    let tableMap = this.maps.get(table);
    if (!tableMap) {
      tableMap = new Map();
      this.maps.set(table, tableMap);
    }
    tableMap.set(oldId.toUpperCase(), newId);
  }

  /** Get a mapped ID, returning undefined if not found. Keys are case-insensitive. */
  get(table: string, oldId: string): string | undefined {
    return this.maps.get(table)?.get(oldId.toUpperCase());
  }

  /** Get a mapped ID, throwing if not found. Use for required foreign keys. Keys are case-insensitive. */
  require(table: string, oldId: string): string {
    const newId = this.get(table, oldId);
    if (!newId) {
      throw new Error(
        `IdMap: no mapping found for ${table}[${oldId}]. ` +
          `Was the parent table imported first?`,
      );
    }
    return newId;
  }

  /** Get the count of mappings for a table. */
  count(table: string): number {
    return this.maps.get(table)?.size ?? 0;
  }

  /** Get all mapped IDs (new IDs) for a table. */
  values(table: string): string[] {
    const tableMap = this.maps.get(table);
    if (!tableMap) return [];
    return [...tableMap.values()];
  }

  /** List all tables that have mappings. */
  tables(): string[] {
    return [...this.maps.keys()];
  }
}

// ---------------------------------------------------------------------------
// Batch upsert helper
// ---------------------------------------------------------------------------

export interface BatchResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: Array<{ index: number; error: unknown }>;
}

/**
 * Process rows through an upsert function in batches.
 *
 * - Calls `upsertFn` for each row individually (Prisma upsert is per-record)
 * - Logs progress every `batchSize` rows
 * - Continues on individual row failures, collecting errors
 */
export async function batchUpsert<T>(
  rows: T[],
  upsertFn: (row: T, index: number) => Promise<void>,
  options?: { batchSize?: number; label?: string },
): Promise<BatchResult> {
  const batchSize = options?.batchSize ?? config.batchSize;
  const label = options?.label ?? "rows";
  const result: BatchResult = { total: rows.length, succeeded: 0, failed: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    try {
      await upsertFn(rows[i], i);
      result.succeeded++;
    } catch (error) {
      result.failed++;
      result.errors.push({ index: i, error });
      console.error(`  [!] Failed row ${i}: ${error instanceof Error ? error.message : error}`);
    }

    // Progress log at batch boundaries
    if ((i + 1) % batchSize === 0) {
      console.log(`  ... processed ${i + 1}/${rows.length} ${label}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface ImportLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  summary: (result: BatchResult) => void;
}

/** Create a prefixed logger for an import step. */
export function logger(tableName: string): ImportLogger {
  const prefix = `[${tableName}]`;
  return {
    info: (msg) => console.log(`${prefix} ${msg}`),
    warn: (msg) => console.warn(`${prefix} WARNING: ${msg}`),
    error: (msg) => console.error(`${prefix} ERROR: ${msg}`),
    summary: (result) => {
      const status = result.failed > 0 ? "PARTIAL" : "OK";
      console.log(
        `${prefix} ${status} — ${result.succeeded}/${result.total} succeeded` +
          (result.failed > 0 ? `, ${result.failed} failed` : ""),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Value transform helpers
// ---------------------------------------------------------------------------

/** Parse a value that may be null/empty into a JS null. Empty strings from the text parser represent SQL NULL. */
export function nullable(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return value;
}

/** Parse a SQL Server date string into a JS Date, or null. */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Parse a SQL Server date string into a JS Date. Throws if invalid. */
export function requireDate(value: string | null | undefined): Date {
  const d = parseDate(value);
  if (!d) throw new Error(`Required date value is missing or invalid: ${value}`);
  return d;
}

/** Coerce a value to number, returning null if not parseable. */
export function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/**
 * Parse a numeric string that may use European comma as the decimal separator
 * (e.g. "12,37" -> 12.37). Returns null for missing/unparseable values.
 */
export function parseDecimalCommaNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  return parseNumber(value.replace(",", "."));
}

/**
 * Map a SQL Server unit string to a Prisma `WeightUnit` enum, or null if
 * unrecognised. Accepts the variants seen across `tblConfigMaterial.Unit` and
 * `tblConfigPN_Material.unit`: `gm`/`g` -> G, `kg` -> KG, `lb`/`lbs` -> LB,
 * `oz` -> OZ.
 */
export function mapWeightUnit(raw: string | null | undefined): WeightUnit | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "gm":
    case "g":
      return WeightUnit.G;
    case "kg":
      return WeightUnit.KG;
    case "lb":
    case "lbs":
      return WeightUnit.LB;
    case "oz":
      return WeightUnit.OZ;
    default:
      return null;
  }
}
