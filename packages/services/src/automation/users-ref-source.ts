import type { RefSource } from "@rw/automations";
import prisma from "@rw/db";

/**
 * Resolved user shape used by automation handlers. Narrow on purpose — just the fields the picker
 * label and the alert message need today; widen as actions grow.
 */
export interface ResolvedUser {
  id: string;
  name: string;
  email: string;
}

/**
 * `users` ref source backed by Postgres. Lists every user with a membership in the given
 * workspace, ordered by display name for stable picker output. Format mirrors what the in-memory
 * fixture produced (`{ id, label, meta: { email } }`) so the editor renders unchanged.
 */
export function createDbUsersRefSource(workspaceId: string): RefSource {
  return {
    key: "users",
    async list(_ctx) {
      const users = await usersInWorkspace(workspaceId);
      return users.map((u) => ({ id: u.id, label: u.name, meta: { email: u.email } }));
    },
  };
}

/**
 * Resolve a single user by id, scoped to the workspace. Returns undefined if the user doesn't
 * exist OR isn't a member of this workspace — the membership check makes this safe to call from a
 * handler with attacker-controlled ids.
 */
export async function getUserById(workspaceId: string, id: string): Promise<ResolvedUser | undefined> {
  const user = await prisma.user.findFirst({
    where: { id, memberships: { some: { workspaceId } } },
    select: { id: true, email: true, firstName: true, lastName: true },
  });
  return user ? mapUser(user) : undefined;
}

/** Every user with a membership in this workspace. Stable name-ordered for picker UX. */
async function usersInWorkspace(workspaceId: string): Promise<ResolvedUser[]> {
  const users = await prisma.user.findMany({
    where: { memberships: { some: { workspaceId } } },
    select: { id: true, email: true, firstName: true, lastName: true },
  });
  const out = users.map(mapUser);
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}

/** Render name: `firstName lastName` when set, else email (deprecated User name fields are the source). */
function mapUser(input: {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}): ResolvedUser {
  const composed = [input.firstName, input.lastName].filter(Boolean).join(" ").trim();
  return { id: input.id, name: composed || input.email, email: input.email };
}
