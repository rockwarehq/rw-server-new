import prisma from "@rw/db";
import type { Role, RoleScope } from "@rw/db";
import { OWNER_PERMISSION, validatePermissions } from "./permissions.js";

export interface CreateRoleInput {
  workspaceId: string;
  name: string;
  description?: string;
  scope: RoleScope;
  permissions: readonly string[];
}

export interface UpdateRoleInput {
  name?: string;
  description?: string;
  permissions?: readonly string[];
}

export async function list(workspaceId: string): Promise<Role[]> {
  return prisma.role.findMany({
    where: { workspaceId },
    orderBy: [{ scope: "asc" }, { name: "asc" }],
  });
}

export async function getById(id: string): Promise<Role | null> {
  return prisma.role.findUnique({ where: { id } });
}

export async function create(input: CreateRoleInput): Promise<Role> {
  const permissions = validatePermissions(input.permissions);
  if (permissions.includes(OWNER_PERMISSION)) {
    throw new Error(`${OWNER_PERMISSION} is reserved for system roles`);
  }
  return prisma.role.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description,
      scope: input.scope,
      permissions,
      isSystem: false,
    },
  });
}

export async function update(id: string, input: UpdateRoleInput): Promise<Role> {
  const existing = await prisma.role.findUnique({ where: { id } });
  if (!existing) throw new Error("Role not found");
  if (existing.isSystem) throw new Error("System roles cannot be modified");

  const permissions = input.permissions ? validatePermissions(input.permissions) : undefined;
  if (permissions?.includes(OWNER_PERMISSION)) {
    throw new Error(`${OWNER_PERMISSION} is reserved for system roles`);
  }

  return prisma.role.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      permissions,
    },
  });
}

export async function remove(id: string): Promise<void> {
  const existing = await prisma.role.findUnique({ where: { id } });
  if (!existing) return;
  if (existing.isSystem) throw new Error("System roles cannot be deleted");

  await prisma.role.delete({ where: { id } });
}

export async function findSystemRole(workspaceId: string, name: string, scope: RoleScope): Promise<Role | null> {
  return prisma.role.findUnique({
    where: { workspaceId_name_scope: { workspaceId, name, scope } },
  });
}
