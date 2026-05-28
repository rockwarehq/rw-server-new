import type { Trigger } from "./types.js";

/**
 * The minimum the engine needs from a trigger store. The consuming app supplies the concrete
 * implementation (a file-backed mock, Prisma + Postgres, etc.).
 *
 * IMPORTANT: this store only persists trigger *definitions* — it does not drive evaluation. The
 * engine evaluates against an in-memory compiled copy (`TriggerEngine.engines`), so after ANY
 * mutation (`upsert` / `remove`) the caller MUST call `engine.reload()` to rebuild that copy from
 * the store. The store does not do this itself.
 *
 * MULTI-INSTANCE PLAN: the compiled engines live in one process's memory, so a reload on the
 * instance that handled the write does not reach the others. Plan: on each mutation, publish the
 * changed trigger id to a Redis pub/sub channel; every server instance subscribes and reloads on
 * receipt, keeping all in-memory caches in sync with the store. (The id lets us move to a targeted
 * reload later; a full `reload()` works for now.)
 */
export interface TriggerStore {
  list(): Trigger[];
  get(id: string): Trigger | undefined;
  upsert(t: Trigger): Trigger;
  remove(id: string): boolean;
  newId(): string;
}
