/**
 * Ref data sources — the picker half of the "store an ID, render a label" pattern.
 *
 * An action input field declares `ref: { source: "users", multi: true }` on its `SchemaProperty`.
 * The editor calls `RefRegistry.list("users", ctx)` to populate a dropdown; the automation stores the
 * picked ids verbatim. At action-run time the **handler** today does its own id → object expansion;
 * a framework-level `resolve(ids)` step may be added later without changing this seam (see README
 * "Ref data sources").
 *
 * Two pieces:
 *   - `RefSource` — one named source. The app owns the implementation.
 *   - `RefRegistry` — collection of sources, looked up by `key`. Lives on the framework.
 */

/** Per-call scope a source may need (workspace, search filter, …). Empty today; sources narrow as needed. */
export type RefContext = Record<string, unknown>;

/** One option in a picker — a stable id to store + a label to render. */
export interface RefOption {
  id: string;
  label: string;
  /** Optional per-option metadata for the UI (e.g. avatar, secondary label). Never used for storage. */
  meta?: Record<string, unknown>;
}

/**
 * One named data source. Today only the picker half (`list`) exists. A future `resolve(ids, ctx)`
 * method can be added here when the framework starts hydrating ids → objects at run time; until
 * then, handlers fetch by id themselves using app-side helpers.
 */
export interface RefSource {
  /** Stable key. Schemas reference this via `ref.source`. */
  key: string;
  /** Picker options for the editor UI. */
  list(ctx: RefContext): Promise<RefOption[]>;
}

/** Collection of refs keyed by `key`. The framework holds one; the app populates it at boot. */
export interface RefRegistry {
  /** Add a source. Returns the registry so calls can be chained. */
  register(source: RefSource): RefRegistry;
  /** Look up a source by key. Undefined if not registered. */
  get(key: string): RefSource | undefined;
  /** All registered keys (for startup validation + introspection). */
  keys(): string[];
}

export function createRefRegistry(): RefRegistry {
  const sources = new Map<string, RefSource>();
  const registry: RefRegistry = {
    register(source) {
      sources.set(source.key, source);
      return registry;
    },
    get(key) {
      return sources.get(key);
    },
    keys() {
      return [...sources.keys()];
    },
  };
  return registry;
}
