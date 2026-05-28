import type { RefSource } from "@rw/automations";

/**
 * MOCK users fixture + ref source. Stand-in for a real users table; swap `usersRefSource.list` for
 * a `@rw/db` query and `getUserById` for the same lookup later, no other file changes.
 *
 * Two call sites:
 *   - `usersRefSource.list(ctx)` — feeds the editor's recipient picker over the RPC layer.
 *   - `getUserById(id)` — used by action handlers to expand stored ids → User at run time
 *     (no framework hydration today, see @rw/automations README "Ref data sources").
 */

export interface User {
  id: string;
  name: string;
  email: string;
}

const FIXTURE: User[] = [
  { id: "u_supervisor", name: "Sam Supervisor", email: "supervisor@example.com" },
  { id: "u_shift_lead", name: "Riley Shift-Lead", email: "shift-lead@example.com" },
  { id: "u_ops", name: "Ops Pager", email: "ops@example.com" },
];

const BY_ID = new Map(FIXTURE.map((u) => [u.id, u]));

/** Resolve a stored user id against the in-memory fixture. Used by the file-mock branch only. */
export function getFixtureUserById(id: string): User | undefined {
  return BY_ID.get(id);
}

export const usersRefSource: RefSource = {
  key: "users",
  async list(_ctx) {
    return FIXTURE.map((u) => ({ id: u.id, label: u.name, meta: { email: u.email } }));
  },
};
