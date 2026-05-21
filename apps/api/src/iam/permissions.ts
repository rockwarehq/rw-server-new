import prisma from "@rw/db";
import type { SystemRole } from "@rw/db";

export const RESOURCES = [
  "facility", // sites, stations, workcenters, gateways, datasources, displays
  "schedule", // shift patterns, definitions, assignments, instances
  "job", // jobs, work orders, cycles, dispositions
  "status", // status reasons + categories (downtime taxonomy)
  "tool", // tools
  "product", // products, materials, process types
  "dashboard", // dashboards (saved views)
  "user", // workspace users + memberships
  "employee", // employee roster (shop-floor identities)
  "billing", // invoices, payment method, subscription, plan changes
  "settings", // general workspace config + ownership transfer
] as const;

export const ACTIONS = ["read", "write", "admin"] as const;
export const OWNER_PERMISSION = "owner:all" as const;
export const RESERVED_PERMISSIONS = [OWNER_PERMISSION] as const;

export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];
export type ReservedPermission = (typeof RESERVED_PERMISSIONS)[number];
export type Permission = `${Resource}:${Action}` | ReservedPermission;

export const ALL_PERMISSIONS: Permission[] = [
  ...RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}:${a}` as Permission)),
  ...RESERVED_PERMISSIONS,
];

const ALL_PERMISSIONS_SET: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return ALL_PERMISSIONS_SET.has(value as Permission);
}

export function hasOwnerPermission(permissions: readonly string[]): boolean {
  return permissions.includes(OWNER_PERMISSION);
}

/**
 * Validate a list of permission strings. Throws on any invalid entry.
 * Used when creating or updating custom roles from user input.
 */
export function validatePermissions(input: readonly string[]): Permission[] {
  const invalid = input.filter((p) => !ALL_PERMISSIONS_SET.has(p as Permission));
  if (invalid.length) {
    throw new Error(`Invalid permissions: ${invalid.join(", ")}`);
  }
  return input as Permission[];
}

// ── System-role permissions (Rockware-internal staff) ────────────────────
// Permissions for system users live in code, not in the database. Customers
// cannot influence these; Rockware cannot grant them through the product UI.

export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRole, ReadonlySet<Permission>> = {
  SUPPORT: new Set(ALL_PERMISSIONS.filter((p) => p.endsWith(":read") && !p.startsWith("billing:"))),
  ENGINEER: new Set(ALL_PERMISSIONS.filter((p) => p !== OWNER_PERMISSION)),
};

// ── Permission checks ────────────────────────────────────────────────────

export interface PermissionContext {
  workspaceId: string;
  siteId?: string;
}

export type AccessibleSites = { all: true } | { all: false; siteIds: string[] };

export interface AccessibleSiteRef {
  id: string;
  name: string;
}

/**
 * Return the full set of permissions this user holds in the given context.
 *
 * - System users (User.systemRole set) resolve from SYSTEM_ROLE_PERMISSIONS.
 * - Customer users union all membership RoleAssignment rows matching the workspace,
 *   with site-scoped assignments included only when `ctx.siteId` matches.
 */
export async function getEffectivePermissions(userId: string, ctx: PermissionContext): Promise<Set<Permission>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { systemRole: true },
  });

  if (!user) return new Set();

  if (user.systemRole) {
    return new Set(SYSTEM_ROLE_PERMISSIONS[user.systemRole]);
  }

  const assignments = await prisma.roleAssignment.findMany({
    where: {
      membership: { userId, workspaceId: ctx.workspaceId },
      OR: [{ siteId: null }, ...(ctx.siteId ? [{ siteId: ctx.siteId }] : [])],
    },
    select: { role: { select: { permissions: true } } },
  });

  const out = new Set<Permission>();
  for (const a of assignments) {
    for (const p of a.role.permissions) {
      if (ALL_PERMISSIONS_SET.has(p as Permission)) {
        out.add(p as Permission);
      }
    }
  }
  return out;
}

export async function hasPermission(userId: string, permission: Permission, ctx: PermissionContext): Promise<boolean> {
  const perms = await getEffectivePermissions(userId, ctx);
  return perms.has(permission);
}

export async function hasAnyPermission(
  userId: string,
  permissions: readonly Permission[],
  ctx: PermissionContext,
): Promise<boolean> {
  const perms = await getEffectivePermissions(userId, ctx);
  return permissions.some((p) => perms.has(p));
}

export async function getAccessibleSites(
  userId: string,
  permission: Permission,
  workspaceId: string,
): Promise<AccessibleSites> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { systemRole: true },
  });

  if (!user) return { all: false, siteIds: [] };
  if (user.systemRole) {
    return SYSTEM_ROLE_PERMISSIONS[user.systemRole].has(permission) ? { all: true } : { all: false, siteIds: [] };
  }

  const assignments = await prisma.roleAssignment.findMany({
    where: { membership: { userId, workspaceId } },
    select: {
      siteId: true,
      role: { select: { permissions: true } },
    },
  });

  const siteIds = new Set<string>();
  for (const assignment of assignments) {
    if (!assignment.role.permissions.includes(permission)) continue;
    if (assignment.siteId === null) return { all: true };
    siteIds.add(assignment.siteId);
  }

  return { all: false, siteIds: [...siteIds] };
}

export async function listAccessibleSites(
  userId: string,
  workspaceId: string,
  permission: Permission = "facility:read",
): Promise<AccessibleSiteRef[]> {
  const access = await getAccessibleSites(userId, permission, workspaceId);
  return prisma.site.findMany({
    where: {
      workspaceId,
      ...(access.all ? {} : { id: { in: access.siteIds } }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}
