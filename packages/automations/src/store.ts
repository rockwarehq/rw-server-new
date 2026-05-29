import type { Automation } from "./types.js";

/**
 * The minimum the engine needs from a automation store. The consuming app supplies the concrete
 * implementation (a file-backed mock, Prisma + Postgres, etc.).
 *
 * IMPORTANT: this store only persists automation *definitions* — it does not drive evaluation. The
 * engine evaluates against an in-memory compiled copy (`AutomationEngine.engines`), so after ANY
 * mutation (`upsert` / `remove`) the caller MUST call `engine.reload()` to rebuild that copy from
 * the store. The store does not do this itself.
 *
 * MULTI-INSTANCE PLAN: the compiled engines live in one process's memory, so a reload on the
 * instance that handled the write does not reach the others. Plan: on each mutation, publish the
 * changed automation id to a Redis pub/sub channel; every server instance subscribes and reloads on
 * receipt, keeping all in-memory caches in sync with the store. (The id lets us move to a targeted
 * reload later; a full `reload()` works for now.)
 */
export interface AutomationStore {
  /** Synchronous read: list every automation in scope. Cache-served so the engine's hot path stays sync. */
  list(): Automation[];
  /** Synchronous read: look up one automation by id. Cache-served. */
  get(id: string): Automation | undefined;
  /** Persist (insert or update). Returns the canonical row after write. */
  upsert(automation: Automation): Promise<Automation>;
  /** Delete by id. Returns true if a row was removed, false if it didn't exist. */
  remove(id: string): Promise<boolean>;
  /** Mint a new id (e.g. a UUID). Synchronous — no I/O. */
  newId(): string;
}
