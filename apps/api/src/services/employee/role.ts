import prisma from "@rw/db";

// ============================================================================
// Types
// ============================================================================

export interface CreateRoleInput {
  siteId: string;
  name: string;
  permissions?: string[];
}

export interface UpdateRoleInput {
  name?: string;
  permissions?: string[];
}

// Default roles seeded for new sites
const DEFAULT_ROLES = ["Operator", "Supervisor", "Lead", "Quality", "Maintenance", "Contractor", "Engineer", "Manager"];

// ============================================================================
// Operations
// ============================================================================

export async function list(siteId: string) {
  const data = await prisma.employeeRole.findMany({
    where: { siteId },
    orderBy: { name: "asc" },
  });
  return { data };
}

export async function getById(id: string) {
  const role = await prisma.employeeRole.findUnique({ where: { id } });
  if (!role) return null;
  return { data: role };
}

export async function getByName(siteId: string, name: string) {
  const role = await prisma.employeeRole.findUnique({
    where: { siteId_name: { siteId, name } },
  });
  if (!role) return null;
  return { data: role };
}

export async function create(input: CreateRoleInput) {
  const role = await prisma.employeeRole.create({
    data: {
      siteId: input.siteId,
      name: input.name,
      permissions: input.permissions ?? [],
    },
  });
  return { data: role };
}

export async function update(id: string, input: UpdateRoleInput) {
  const role = await prisma.employeeRole.findUnique({ where: { id } });
  if (!role) return { error: "Role not found", code: "NOT_FOUND" as const };

  const updated = await prisma.employeeRole.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.permissions !== undefined && { permissions: input.permissions }),
    },
  });
  return { data: updated };
}

export async function remove(id: string) {
  // Check if any employee site access rows reference this role
  const count = await prisma.employeeSiteAccess.count({
    where: { roleId: id },
  });
  if (count > 0) {
    return { error: "Cannot delete role that is assigned to employees", code: "CONFLICT" as const };
  }

  await prisma.employeeRole.delete({ where: { id } });
  return { data: { success: true } };
}

/**
 * Seed default roles for a new site. Called when a site is created.
 */
export async function seedDefaults(siteId: string) {
  await prisma.employeeRole.createMany({
    data: DEFAULT_ROLES.map((name) => ({ name, siteId })),
    skipDuplicates: true,
  });
}
