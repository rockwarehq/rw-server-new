import prisma from "@rw/db";
import type { UserStatus } from "@rw/db";
import { getEffectivePermissions, listAccessibleSites, type Permission } from "@rw/services/iam/index";
import { logEvent } from "@rw/services/audit/index";
import { getWorkspaceAccessSummaries } from "../workspace/members.js";

export interface CreateUserInput {
  email: string;
  firstName?: string;
  lastName?: string;
  status?: UserStatus;
  passwordHash?: string;
}

export interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  email?: string;
}

export interface UserAdminContext {
  actorId?: string;
  workspaceId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface ListUsersFilter {
  status?: UserStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

function sortPermissions(permissions: Iterable<Permission>): Permission[] {
  return [...permissions].sort();
}

export async function create(input: CreateUserInput) {
  const { email, firstName, lastName, status, passwordHash } = input;

  return prisma.user.create({
    data: {
      email: email.toLowerCase(),
      firstName,
      lastName,
      status: status || "PENDING",
      passwordHash,
    },
  });
}

export async function list(filter: ListUsersFilter = {}) {
  const { status, search, limit = 50, offset = 0 } = filter;

  // Customer-facing listings never include internal Rockware staff. The
  // RBAC invariant keeps them out of WorkspaceMembership rows;
  // this filter is defense in depth against bypass paths.
  const where: Record<string, unknown> = { systemRole: null };

  if (status) {
    where.status = status;
  }

  if (search) {
    where.OR = [
      { email: { contains: search, mode: "insensitive" } },
      { firstName: { contains: search, mode: "insensitive" } },
      { lastName: { contains: search, mode: "insensitive" } },
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      ...(limit > 0 ? { take: limit } : {}),
      skip: offset,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        status: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.user.count({ where }),
  ]);

  return { users, total, limit, offset };
}

export async function getMe(userId: string, workspaceId?: string, siteId?: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, status: true },
  });
  if (!user) return null;

  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId, ...(workspaceId ? { workspaceId } : {}) },
    include: {
      workspace: { select: { id: true, name: true, slug: true } },
      employee: {
        select: {
          id: true,
          status: true,
          version: {
            select: {
              firstName: true,
              lastName: true,
              employeeNumber: true,
              badgeNumber: true,
            },
          },
        },
      },
      roleAssignments: {
        include: {
          role: { select: { id: true, name: true, scope: true, permissions: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  if (!membership) {
    return {
      user,
      employee: null,
      workspace: null,
      site: null,
      sites: [],
      access: { roles: [], permissions: [] },
    };
  }

  const sites = await listAccessibleSites(userId, membership.workspaceId);
  const site = siteId ? (sites.find((item) => item.id === siteId) ?? null) : null;
  const permissions = await getEffectivePermissions(userId, {
    workspaceId: membership.workspaceId,
    ...(site ? { siteId: site.id } : {}),
  });

  const roles = membership.roleAssignments
    .filter((assignment) => assignment.siteId === null || (site !== null && assignment.siteId === site.id))
    .map((assignment) => ({
      id: assignment.role.id,
      name: assignment.role.name,
      scope: assignment.role.scope,
    }));

  return {
    user,
    employee: membership.employee?.version
      ? {
          id: membership.employee.id,
          status: membership.employee.status,
          firstName: membership.employee.version.firstName,
          lastName: membership.employee.version.lastName,
          employeeNumber: membership.employee.version.employeeNumber,
          badgeNumber: membership.employee.version.badgeNumber,
        }
      : null,
    workspace: membership.workspace,
    site,
    sites,
    access: {
      roles,
      permissions: sortPermissions(permissions),
    },
  };
}

export async function getById(id: string) {
  const record = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
      memberships: {
        include: {
          workspace: {
            select: { id: true, name: true, slug: true },
          },
          employee: {
            select: {
              id: true,
              status: true,
              version: {
                select: {
                  id: true,
                  version: true,
                  firstName: true,
                  lastName: true,
                  employeeNumber: true,
                  badgeNumber: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!record) return null;

  const workspaceIds = record.memberships.map((m) => m.workspaceId);
  const accessByWorkspace = await getWorkspaceAccessSummaries(id, workspaceIds);
  const emptyAccess = {
    roles: [],
    roleAssignments: [],
    access: {
      workspacePermissions: [],
      sitePermissions: [],
      sites: { all: false, siteIds: [] },
    },
  };

  return {
    ...record,
    memberships: record.memberships.map((m) => ({
      ...m,
      ...(accessByWorkspace.get(m.workspaceId) ?? emptyAccess),
    })),
  };
}

export async function getByEmail(email: string) {
  return prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      passwordHash: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function update(id: string, input: UpdateUserInput) {
  const { firstName, lastName, email } = input;

  const updateData: Record<string, unknown> = {};
  if (firstName !== undefined) updateData.firstName = firstName;
  if (lastName !== undefined) updateData.lastName = lastName;
  if (email !== undefined) updateData.email = email.toLowerCase();

  return prisma.user.update({
    where: { id },
    data: updateData,
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function disable(id: string, context?: UserAdminContext) {
  const user = await prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id },
      data: { status: "DISABLED" },
    });

    await tx.refreshToken.updateMany({
      where: {
        userId: id,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    return updatedUser;
  });

  await logEvent({
    action: "USER_DISABLED",
    userId: id,
    actorId: context?.actorId,
    workspaceId: context?.workspaceId,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
  });

  return user;
}

export async function enable(id: string, context?: UserAdminContext) {
  const user = await prisma.user.update({
    where: { id },
    data: {
      status: "ACTIVE",
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  await logEvent({
    action: "USER_ENABLED",
    userId: id,
    actorId: context?.actorId,
    workspaceId: context?.workspaceId,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
  });

  return user;
}

export async function exists(id: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!user;
}

export async function emailExists(email: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true },
  });
  return !!user;
}

export interface UnlockContext {
  actorId?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Unlock a user account that was locked due to too many failed login attempts
 */
export async function unlockAccount(
  id: string,
  context?: UnlockContext,
): Promise<{ success: true } | { success: false; error: string }> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, lockedUntil: true, failedLoginAttempts: true },
  });

  if (!user) {
    return { success: false, error: "User not found" };
  }

  if (!user.lockedUntil && user.failedLoginAttempts === 0) {
    return { success: false, error: "Account is not locked" };
  }

  await prisma.user.update({
    where: { id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  await logEvent({
    action: "ACCOUNT_UNLOCKED",
    userId: id,
    actorId: context?.actorId,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
  });

  return { success: true };
}

/**
 * Get user's lock status
 */
export async function getLockStatus(id: string): Promise<{
  isLocked: boolean;
  failedAttempts: number;
  lockedUntil: Date | null;
} | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { lockedUntil: true, failedLoginAttempts: true },
  });

  if (!user) {
    return null;
  }

  return {
    isLocked: user.lockedUntil ? user.lockedUntil > new Date() : false,
    failedAttempts: user.failedLoginAttempts,
    lockedUntil: user.lockedUntil,
  };
}
