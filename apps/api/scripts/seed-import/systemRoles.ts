import prisma from "@rw/db";
import type { RoleScope } from "@rw/db";
import { ACTIONS, ALL_PERMISSIONS, RESOURCES } from "@rw/services/iam/permissions";
import type { Permission } from "@rw/services/iam/permissions";

const all = (resource: (typeof RESOURCES)[number]): Permission[] =>
  ACTIONS.map((action) => `${resource}:${action}` as Permission);

const COMPANY_ADMINISTRATOR_PERMISSIONS: readonly Permission[] = [...ALL_PERMISSIONS];

const FACTORY_ADMINISTRATOR_PERMISSIONS: readonly Permission[] = [
  ...all("facility"),
  ...all("schedule"),
  ...all("job"),
  ...all("status"),
  ...all("tool"),
  ...all("product"),
  ...all("dashboard"),
  ...all("employee"),
  "user:read",
  "user:write",
];

const OFFICE_USER_PERMISSIONS: readonly Permission[] = [
  "schedule:read",
  "schedule:write",
  "job:read",
  "job:write",
  "status:read",
  "status:write",
  "facility:read",
  "tool:read",
  "tool:write",
  "product:read",
  "product:write",
  "dashboard:read",
  "employee:read",
];

const READ_ONLY_USER_PERMISSIONS: readonly Permission[] = [
  "facility:read",
  "product:read",
  "job:read",
  "status:read",
  "tool:read",
  "schedule:read",
  "dashboard:read",
  "employee:read",
];

interface SystemRoleSpec {
  name: string;
  description: string;
  scope: RoleScope;
  permissions: readonly Permission[];
}

export const SYSTEM_ROLE_SPECS: readonly SystemRoleSpec[] = [
  {
    name: "Company Administrator",
    description: "Company-level administrator with billing visibility and full operational access across all sites.",
    scope: "WORKSPACE",
    permissions: COMPANY_ADMINISTRATOR_PERMISSIONS,
  },
  {
    name: "Factory Administrator",
    description: "Local factory administrator with full access to production data and site configuration.",
    scope: "SITE",
    permissions: FACTORY_ADMINISTRATOR_PERMISSIONS,
  },
  {
    name: "Office User",
    description: "Production office user who can work with schedules, jobs, products, tools, and facility data for the site.",
    scope: "SITE",
    permissions: OFFICE_USER_PERMISSIONS,
  },
  {
    name: "Read-only User",
    description: "Analytics and reporting user with read-only access to production data for the site.",
    scope: "SITE",
    permissions: READ_ONLY_USER_PERMISSIONS,
  },
];

export async function seedSystemRoles(workspaceId: string): Promise<void> {
  for (const spec of SYSTEM_ROLE_SPECS) {
    await prisma.role.upsert({
      where: { workspaceId_name_scope: { workspaceId, name: spec.name, scope: spec.scope } },
      create: {
        workspaceId,
        name: spec.name,
        description: spec.description,
        scope: spec.scope,
        permissions: [...spec.permissions],
        isSystem: true,
      },
      update: {
        description: spec.description,
        permissions: [...spec.permissions],
        isSystem: true,
      },
    });
  }
}
