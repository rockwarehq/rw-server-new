import type { RefSource } from "@rw/automations";
import prisma from "@rw/db";

/**
 * User picker hook for the automation framework. Recipients are picked as users because only
 * `User` carries an `email` — an employee's contact email lives on its linked user, not on the
 * employee/version profile. The picker label is the email itself, so an action that sends mail can
 * resolve a stored id straight to an address.
 */

/** Resolved user shape used by automation handlers. */
export interface ResolvedUser {
  id: string;
  email: string;
}

/**
 * `users` ref source backed by Postgres. Lists every user, ordered by email. `{ id, label }` shape
 * matches the other ref sources so the editor renders uniformly.
 */
export const usersAutomationRef: RefSource = {
  key: "users",
  async list(_ctx) {
    const rows = await prisma.user.findMany({ select: { id: true, email: true } });
    return rows
      .map((u) => ({ id: u.id, label: u.email }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  },
};

/** Resolve a single user by id. Returns undefined if the user doesn't exist. */
export async function getUserById(id: string): Promise<ResolvedUser | undefined> {
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } });
  return user ?? undefined;
}
