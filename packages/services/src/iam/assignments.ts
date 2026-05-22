import prisma from "@rw/db";
import type { RoleAssignment } from "@rw/db";

export interface CreateAssignmentInput {
  userId: string;
  roleId: string;
  siteId?: string | null;
}

export class ScopeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeMismatchError";
  }
}

export class SystemUserAssignmentError extends Error {
  constructor(message = "System users cannot hold role assignments") {
    super(message);
    this.name = "SystemUserAssignmentError";
  }
}

/**
 * Assign a role to a user's workspace membership, optionally narrowed to a site.
 *
 * Enforces:
 *  - scope invariant: WORKSPACE roles must have siteId === null;
 *    SITE roles must have siteId !== null.
 *  - membership invariant: the user must be a member of the role's workspace.
 *  - site ownership: the site (if provided) must belong to the role's workspace.
 *  - system-user invariant: internal staff (User.systemRole set) cannot hold
 *    role assignments — their permissions come from code, not the database.
 */
export async function assign(input: CreateAssignmentInput): Promise<RoleAssignment> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, systemRole: true },
  });
  if (!user) throw new Error("User not found");
  if (user.systemRole) throw new SystemUserAssignmentError();

  const role = await prisma.role.findUnique({
    where: { id: input.roleId },
    select: { id: true, workspaceId: true, scope: true },
  });
  if (!role) throw new Error("Role not found");

  const siteId = input.siteId ?? null;

  if (role.scope === "WORKSPACE" && siteId !== null) {
    throw new ScopeMismatchError("Workspace-scoped role cannot be assigned with a siteId");
  }
  if (role.scope === "SITE" && siteId === null) {
    throw new ScopeMismatchError("Site-scoped role requires a siteId");
  }

  if (siteId !== null) {
    const site = await prisma.site.findUnique({
      where: { id: siteId },
      select: { workspaceId: true },
    });
    if (!site) throw new Error("Site not found");
    if (site.workspaceId !== role.workspaceId) {
      throw new ScopeMismatchError("Site does not belong to the role's workspace");
    }
  }

  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: input.userId, workspaceId: role.workspaceId } },
    select: { id: true },
  });
  if (!membership) throw new Error("Workspace membership not found");

  return prisma.roleAssignment.create({
    data: {
      membershipId: membership.id,
      roleId: input.roleId,
      siteId,
    },
  });
}

export async function unassign(id: string): Promise<void> {
  await prisma.roleAssignment.delete({ where: { id } });
}

export async function listForUser(userId: string, workspaceId?: string): Promise<RoleAssignment[]> {
  return prisma.roleAssignment.findMany({
    where: { membership: { userId, ...(workspaceId ? { workspaceId } : {}) } },
    orderBy: { createdAt: "asc" },
  });
}

export async function listForWorkspace(workspaceId: string, siteId?: string | null): Promise<RoleAssignment[]> {
  return prisma.roleAssignment.findMany({
    where: {
      membership: { workspaceId },
      ...(siteId === undefined ? {} : { siteId }),
    },
    orderBy: { createdAt: "asc" },
  });
}
