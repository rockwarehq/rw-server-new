import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { hashPassword } from "../auth/session.js";
import { publishStationCurrentLogonsMetric } from "./logon.js";

type DbClient = typeof prisma | Prisma.TransactionClient;

export interface CreateEmployeeInput {
  workspaceId?: string;
  siteId?: string;
  employeeNumber?: string | null;
  firstName: string;
  lastName: string;
  roleId?: string;
  pin?: string;
  badgeNumber?: string | null;
}

export interface UpdateEmployeeInput {
  employeeNumber?: string | null;
  firstName?: string;
  lastName?: string;
  status?: "ACTIVE" | "INACTIVE";
  roleId?: string;
  pin?: string | null;
  badgeNumber?: string | null;
}

export interface ListEmployeesFilter {
  siteId: string;
  status?: "ACTIVE" | "INACTIVE";
  roleId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

const versionSelectPublic = {
  id: true,
  version: true,
  firstName: true,
  lastName: true,
  employeeNumber: true,
  badgeNumber: true,
  createdAt: true,
} as const;

const employeeInclude = {
  version: { select: versionSelectPublic },
  siteAccess: {
    include: {
      site: { select: { id: true, name: true, workspaceId: true } },
      role: { select: { id: true, name: true, permissions: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

function employeeIncludeForSite(siteId: string) {
  return {
    version: { select: versionSelectPublic },
    siteAccess: {
      where: { siteId },
      include: {
        site: { select: { id: true, name: true, workspaceId: true } },
        role: { select: { id: true, name: true, permissions: true } },
      },
    },
  } as const;
}

async function resolveWorkspaceId(input: { workspaceId?: string; siteId?: string }, db: DbClient = prisma) {
  if (input.workspaceId) return input.workspaceId;
  if (!input.siteId) throw new Error("workspaceId or siteId is required");

  const site = await db.site.findUnique({
    where: { id: input.siteId },
    select: { workspaceId: true },
  });
  if (!site) throw new Error("Site not found");
  return site.workspaceId;
}

async function resolveSiteRoleId(siteId: string, roleId?: string, db: DbClient = prisma) {
  if (roleId) {
    const role = await db.employeeRole.findUnique({
      where: { id: roleId },
      select: { id: true, siteId: true },
    });
    if (!role) throw new Error("Employee role not found");
    if (role.siteId !== siteId) throw new Error("Employee role does not belong to this site");
    return role.id;
  }

  const defaultRole = await db.employeeRole.findUnique({
    where: { siteId_name: { siteId, name: "Operator" } },
    select: { id: true },
  });
  if (!defaultRole) throw new Error("Default 'Operator' role not found for site");
  return defaultRole.id;
}

async function ensureIdentityAvailable(
  input: {
    workspaceId: string;
    employeeId?: string;
    employeeNumber?: string | null;
    badgeNumber?: string | null;
  },
  db: DbClient = prisma,
) {
  const filters = [];
  if (input.employeeNumber) filters.push({ employeeNumber: input.employeeNumber });
  if (input.badgeNumber) filters.push({ badgeNumber: input.badgeNumber });
  if (!filters.length) return;

  const existing = await db.employeeVersion.findFirst({
    where: {
      OR: filters,
      currentOf: {
        is: {
          workspaceId: input.workspaceId,
          ...(input.employeeId ? { id: { not: input.employeeId } } : {}),
        },
      },
    },
    select: { employeeNumber: true, badgeNumber: true },
  });

  if (!existing) return;
  if (input.employeeNumber && existing.employeeNumber === input.employeeNumber) {
    throw new Error("Employee number already exists in this workspace");
  }
  if (input.badgeNumber && existing.badgeNumber === input.badgeNumber) {
    throw new Error("Badge number already exists in this workspace");
  }
}

async function createWithClient(input: CreateEmployeeInput, db: DbClient) {
  const workspaceId = await resolveWorkspaceId(input, db);
  await ensureIdentityAvailable(
    {
      workspaceId,
      employeeNumber: input.employeeNumber,
      badgeNumber: input.badgeNumber,
    },
    db,
  );

  const pinHash = input.pin ? await hashPassword(input.pin) : null;
  const roleId = input.siteId ? await resolveSiteRoleId(input.siteId, input.roleId, db) : null;

  const created = await db.employee.create({
    data: {
      workspaceId,
      status: "ACTIVE",
    },
  });

  const version = await db.employeeVersion.create({
    data: {
      employeeId: created.id,
      version: 1,
      firstName: input.firstName,
      lastName: input.lastName,
      employeeNumber: input.employeeNumber || null,
      badgeNumber: input.badgeNumber || null,
      pinHash,
    },
  });

  await db.employee.update({
    where: { id: created.id },
    data: { versionId: version.id },
  });

  if (input.siteId && roleId) {
    await db.employeeSiteAccess.create({
      data: {
        employeeId: created.id,
        siteId: input.siteId,
        roleId,
        status: "ACTIVE",
      },
    });
  }

  const employee = await db.employee.findUnique({
    where: { id: created.id },
    include: employeeInclude,
  });

  if (!employee) throw new Error("Employee was not created");
  return { data: employee };
}

export async function create(input: CreateEmployeeInput, db?: Prisma.TransactionClient) {
  if (db) {
    return createWithClient(input, db);
  }

  return prisma.$transaction((tx) => createWithClient(input, tx));
}

export async function list(filter: ListEmployeesFilter) {
  const { siteId, status, roleId, search, limit = 50, offset = 0 } = filter;

  const where: NonNullable<Parameters<typeof prisma.employee.findMany>[0]>["where"] = {
    ...(status && { status }),
    siteAccess: {
      some: {
        siteId,
        ...(roleId && { roleId }),
      },
    },
    ...(search && {
      version: {
        is: {
          OR: [
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            {
              employeeNumber: {
                contains: search,
                mode: "insensitive" as const,
              },
            },
          ],
        },
      },
    }),
  };

  const [data, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      include: employeeInclude,
      orderBy: { createdAt: "desc" },
      take: limit || undefined,
      skip: offset,
    }),
    prisma.employee.count({ where }),
  ]);

  return { data, total };
}

export async function getById(id: string) {
  const employee = await prisma.employee.findUnique({
    where: { id },
    include: employeeInclude,
  });

  if (!employee) return null;
  return { data: employee };
}

export async function getByEmployeeNumber(siteId: string, employeeNumber: string) {
  const employee = await prisma.employee.findFirst({
    where: {
      status: "ACTIVE",
      version: { is: { employeeNumber } },
      siteAccess: { some: { siteId, status: "ACTIVE" } },
    },
    include: employeeIncludeForSite(siteId),
  });

  if (!employee) return null;
  return { data: employee };
}

export async function getByBadgeNumber(siteId: string, badgeNumber: string) {
  const employee = await prisma.employee.findFirst({
    where: {
      status: "ACTIVE",
      version: { is: { badgeNumber } },
      siteAccess: { some: { siteId, status: "ACTIVE" } },
    },
    include: employeeIncludeForSite(siteId),
  });

  if (!employee) return null;
  return { data: employee };
}

export async function update(id: string, input: UpdateEmployeeInput) {
  const employee = await prisma.employee.findUnique({
    where: { id },
    include: { version: true },
  });

  if (!employee?.version) return { error: "Employee not found", code: "NOT_FOUND" as const };
  const currentVersion = employee.version;

  const nextEmployeeNumber =
    input.employeeNumber !== undefined ? input.employeeNumber || null : currentVersion.employeeNumber;
  const nextBadgeNumber = input.badgeNumber !== undefined ? input.badgeNumber || null : currentVersion.badgeNumber;

  await ensureIdentityAvailable({
    workspaceId: employee.workspaceId,
    employeeId: employee.id,
    employeeNumber: nextEmployeeNumber,
    badgeNumber: nextBadgeNumber,
  });

  let roleUpdate: { siteId: string; roleId: string } | null = null;
  if (input.roleId) {
    const role = await prisma.employeeRole.findUnique({
      where: { id: input.roleId },
      select: {
        id: true,
        siteId: true,
        site: { select: { workspaceId: true } },
      },
    });
    if (!role)
      return {
        error: "Employee role not found",
        code: "ROLE_NOT_FOUND" as const,
      };
    if (role.site.workspaceId !== employee.workspaceId) {
      return {
        error: "Employee role does not belong to this workspace",
        code: "WORKSPACE_MISMATCH" as const,
      };
    }
    roleUpdate = { siteId: role.siteId, roleId: role.id };
  }

  const needsNewVersion =
    input.firstName !== undefined ||
    input.lastName !== undefined ||
    input.employeeNumber !== undefined ||
    input.pin !== undefined ||
    input.badgeNumber !== undefined;

  const result = await prisma.$transaction(async (tx) => {
    if (input.status) {
      await tx.employee.update({
        where: { id },
        data: { status: input.status },
      });
    }

    if (roleUpdate) {
      await tx.employeeSiteAccess.upsert({
        where: {
          employeeId_siteId: { employeeId: id, siteId: roleUpdate.siteId },
        },
        create: {
          employeeId: id,
          siteId: roleUpdate.siteId,
          roleId: roleUpdate.roleId,
          status: "ACTIVE",
        },
        update: { roleId: roleUpdate.roleId, status: "ACTIVE" },
      });
    }

    if (needsNewVersion) {
      const pinHash =
        input.pin === undefined ? currentVersion.pinHash : input.pin ? await hashPassword(input.pin) : null;

      const version = await tx.employeeVersion.create({
        data: {
          employeeId: id,
          version: currentVersion.version + 1,
          firstName: input.firstName ?? currentVersion.firstName,
          lastName: input.lastName ?? currentVersion.lastName,
          employeeNumber: nextEmployeeNumber,
          badgeNumber: nextBadgeNumber,
          pinHash,
        },
      });

      await tx.employee.update({
        where: { id },
        data: { versionId: version.id },
      });
    }

    return tx.employee.findUnique({ where: { id }, include: employeeInclude });
  });

  if (!result) throw new Error("Employee was not found after update");
  return { data: result };
}

export async function remove(id: string) {
  const employee = await prisma.employee.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!employee) return { error: "Employee not found", code: "NOT_FOUND" as const };

  // End all active logon sessions first
  const now = new Date();
  const affected = await prisma.stationLogonSession.findMany({
    where: { employeeId: id, logoffTime: null },
    select: { stationId: true },
    distinct: ["stationId"],
  });
  await prisma.stationLogonSession.updateMany({
    where: { employeeId: id, logoffTime: null },
    data: { logoffTime: now },
  });

  await prisma.employee.delete({ where: { id } });

  await Promise.all(affected.map((row) => publishStationCurrentLogonsMetric(row.stationId, now)));

  return { data: { success: true } };
}
