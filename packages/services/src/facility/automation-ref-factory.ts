import type { RefSource } from "@rw/automations";

/**
 * Shared builder for the facility picker sources (stations, work centers). Both list every named
 * row, name-ordered, and map to `{ id, label }`; only the Prisma model, the ref `key`, and the
 * soft-delete filter differ. Each caller supplies a typed `findRows()` thunk — passing the thunk
 * sidesteps Prisma's cross-delegate union typing.
 */
export function createNameRef(opts: {
  key: string;
  findRows: () => Promise<Array<{ id: string; name: string }>>;
}): RefSource {
  return {
    key: opts.key,
    async list(_ctx) {
      const rows = await opts.findRows();
      return rows.map((r) => ({ id: r.id, label: r.name }));
    },
  };
}
