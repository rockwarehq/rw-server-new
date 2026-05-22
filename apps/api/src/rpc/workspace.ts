import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { hasAnyPermission, roles, type Permission } from "@rw/services/iam/index";
import { workspace as workspaceService } from "../services/account/index.js";
import { authRequired } from "./middleware.js";

const emptyInputSchema = z.object({});

const USER_ROLE_LIST_PERMISSIONS: readonly Permission[] = ["user:read", "user:write", "user:admin"];

async function assertCanReadUserManagement(userId: string, workspaceId: string, siteId?: string) {
  const canReadUserManagement = await hasAnyPermission(userId, USER_ROLE_LIST_PERMISSIONS, {
    workspaceId,
    ...(siteId ? { siteId } : {}),
  });
  if (!canReadUserManagement) {
    throw new ORPCError("FORBIDDEN", { message: "Missing user-management permission" });
  }
}

export const listUserRoles = authRequired.input(emptyInputSchema).handler(async ({ context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  await assertCanReadUserManagement(context.iam.id, workspaceId, context.iam.siteId);

  const roleList = await roles.list(workspaceId);

  return {
    data: roleList.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      scope: role.scope,
      permissions: role.permissions,
      isSystem: role.isSystem,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    })),
  };
});

export const listMembers = authRequired.input(emptyInputSchema).handler(async ({ context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  await assertCanReadUserManagement(context.iam.id, workspaceId, context.iam.siteId);

  return { data: await workspaceService.listMembers(workspaceId) };
});
