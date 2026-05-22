import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { workspace } from "../services/account/index.js";
import { errorSchema, idParamsSchema, successResponseSchema } from "./schemas.js";
import { requirePermission } from "../plugins/require-permission.js";
import { hasPermission } from "@rw/services/iam/index";

const workspaceSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    slug: { type: "string" },
    description: { type: "string", nullable: true },
    isDefault: { type: "boolean" },
    settings: { type: "object", additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    _count: {
      type: "object",
      properties: {
        members: { type: "number" },
      },
    },
  },
} as const satisfies JSONSchema;

const roleRefSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    isSystem: { type: "boolean" },
  },
} as const satisfies JSONSchema;

const employeeProfileSchema = {
  type: ["object", "null"],
  properties: {
    id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
    version: {
      type: ["object", "null"],
      properties: {
        id: { type: "string", format: "uuid" },
        version: { type: "number" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        employeeNumber: { type: ["string", "null"] },
        badgeNumber: { type: ["string", "null"] },
      },
    },
  },
} as const satisfies JSONSchema;

const roleAssignmentSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    siteId: { type: ["string", "null"], format: "uuid" },
    site: {
      type: ["object", "null"],
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string" },
      },
    },
    role: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string" },
        isSystem: { type: "boolean" },
        scope: { type: "string", enum: ["WORKSPACE", "SITE"] },
        permissions: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const satisfies JSONSchema;

const accessSchema = {
  type: "object",
  properties: {
    workspacePermissions: { type: "array", items: { type: "string" } },
    sitePermissions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          siteId: { type: "string", format: "uuid" },
          site: {
            type: ["object", "null"],
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
            },
          },
          permissions: { type: "array", items: { type: "string" } },
        },
      },
    },
    sites: {
      type: "object",
      properties: {
        all: { type: "boolean" },
        siteIds: { type: "array", items: { type: "string", format: "uuid" } },
      },
    },
  },
} as const satisfies JSONSchema;

const memberSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    joinedAt: { type: "string", format: "date-time" },
    user: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        email: { type: "string" },
        firstName: { type: "string", nullable: true },
        lastName: { type: "string", nullable: true },
        status: { type: "string", enum: ["PENDING", "ACTIVE", "DISABLED"] },
        lastLoginAt: { type: ["string", "null"], format: "date-time" },
      },
    },
    roles: { type: "array", items: roleRefSchema },
    roleAssignments: { type: "array", items: roleAssignmentSchema },
  },
} as const satisfies JSONSchema;

const createBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    slug: { type: "string" },
    description: { type: "string" },
    isDefault: { type: "boolean" },
    settings: { type: "object", additionalProperties: true },
  },
  required: ["name"],
} as const satisfies JSONSchema;

const updateBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    slug: { type: "string" },
    description: { type: "string" },
    settings: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

const addMemberBodySchema = {
  type: "object",
  properties: {
    userId: { type: "string", format: "uuid" },
    roleId: { type: "string", format: "uuid" },
  },
  required: ["userId", "roleId"],
} as const satisfies JSONSchema;

const memberParamsSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    userId: { type: "string", format: "uuid" },
  },
  required: ["id", "userId"],
} as const satisfies JSONSchema;

const updateRoleBodySchema = {
  type: "object",
  properties: {
    roleId: { type: "string", format: "uuid" },
  },
  required: ["roleId"],
} as const satisfies JSONSchema;

const listWorkspacesResponseSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      slug: { type: "string" },
      description: { type: "string", nullable: true },
      joinedAt: { type: "string", format: "date-time" },
      employee: employeeProfileSchema,
      roles: { type: "array", items: roleRefSchema },
      roleAssignments: { type: "array", items: roleAssignmentSchema },
      access: accessSchema,
    },
  },
} as const satisfies JSONSchema;

const listMembersResponseSchema = {
  type: "array",
  items: memberSchema,
} as const satisfies JSONSchema;

export default async function workspaceRoutes(fastify: FastifyTypedInstance) {
  // List user's workspaces
  fastify.route({
    method: "GET",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      response: {
        200: listWorkspacesResponseSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = (request.iam as { id?: string } | undefined)?.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      return workspace.getUserWorkspaces(userId);
    },
  });

  // Create workspace (admin only in current workspace)
  fastify.route({
    method: "POST",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      body: createBodySchema,
      response: {
        201: workspaceSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = (request.iam as { workspaceId?: string } | undefined)?.workspaceId;
      const userId = (request.iam as { id?: string } | undefined)?.id;

      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      // If the caller already has a workspace context, require settings:admin
      // in it — spinning up another workspace is an org-level privilege.
      if (workspaceId) {
        const ok = await hasPermission(userId, "settings:admin", { workspaceId });
        if (!ok) {
          return reply.status(403).send({ error: "forbidden", required: "settings:admin" });
        }
      }

      if (request.body.slug && (await workspace.slugExists(request.body.slug))) {
        return reply.status(400).send({ error: "Workspace slug already exists" });
      }

      const newWorkspace = await workspace.create(request.body);

      return reply.status(201).send(newWorkspace);
    },
  });

  // Get workspace by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: workspaceSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = (request.iam as { id?: string } | undefined)?.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const isMember = await workspace.isMember(request.params.id, userId);
      if (!isMember) {
        return reply.status(403).send({ error: "Not a member of this workspace" });
      }

      const result = await workspace.getById(request.params.id);
      if (!result) {
        return reply.status(404).send({ error: "Workspace not found" });
      }

      return result;
    },
  });

  // Update workspace (requires settings:write)
  fastify.route({
    method: "PUT",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken, requirePermission("settings:write", { workspaceParam: "id" })],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: updateBodySchema,
      response: {
        200: workspaceSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!(await workspace.exists(request.params.id))) {
        return reply.status(404).send({ error: "Workspace not found" });
      }
      return workspace.update(request.params.id, request.body);
    },
  });

  // Delete workspace (requires settings:admin — ownership-level destructive op)
  fastify.route({
    method: "DELETE",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken, requirePermission("settings:admin", { workspaceParam: "id" })],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: successResponseSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!(await workspace.exists(request.params.id))) {
        return reply.status(404).send({ error: "Workspace not found" });
      }
      await workspace.remove(request.params.id);
      return { success: true };
    },
  });

  // List workspace members
  fastify.route({
    method: "GET",
    url: "/:id/members",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: listMembersResponseSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = (request.iam as { id?: string } | undefined)?.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const isMember = await workspace.isMember(request.params.id, userId);
      if (!isMember) {
        return reply.status(403).send({ error: "Not a member of this workspace" });
      }

      return workspace.listMembers(request.params.id);
    },
  });

  // Add workspace member (requires user:write)
  fastify.route({
    method: "POST",
    url: "/:id/members",
    preHandler: [fastify.verifyAccessToken, requirePermission("user:write", { workspaceParam: "id" })],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: addMemberBodySchema,
      response: {
        201: memberSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const existingMember = await workspace.getUserAccess(request.params.id, request.body.userId);
      if (existingMember) {
        return reply.status(400).send({ error: "User is already a member" });
      }

      try {
        const member = await workspace.addMember(request.params.id, request.body.userId, request.body.roleId);
        return reply.status(201).send(member);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid role";
        return reply.status(400).send({ error: message });
      }
    },
  });

  // Update member role (requires user:write or user:admin)
  fastify.route({
    method: "PUT",
    url: "/:id/members/:userId",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: memberParamsSchema,
      body: updateRoleBodySchema,
      response: {
        200: memberSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const currentUserId = request.iam?.id;
      const workspaceId = request.iam?.workspaceId;
      if (!currentUserId || !workspaceId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      if (request.params.id !== workspaceId) {
        return reply.status(403).send({ error: "Not in requested workspace context" });
      }

      const result = await workspace.updateRole({
        actorUserId: currentUserId,
        targetUserId: request.params.userId,
        workspaceId,
        siteId: request.iam?.siteId,
        roleId: request.body.roleId,
      });

      if (result.success) {
        return result.data;
      }

      switch (result.code) {
        case "FORBIDDEN":
        case "OWNER_PERMISSION_REQUIRED":
          return reply.status(403).send({ error: result.error });
        case "MEMBER_NOT_FOUND":
        case "ROLE_NOT_FOUND":
        case "SITE_NOT_FOUND":
          return reply.status(404).send({ error: result.error });
        default:
          return reply.status(400).send({ error: result.error });
      }
    },
  });

  // Remove member (requires user:admin)
  fastify.route({
    method: "DELETE",
    url: "/:id/members/:userId",
    preHandler: [fastify.verifyAccessToken, requirePermission("user:admin", { workspaceParam: "id" })],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: memberParamsSchema,
      response: {
        200: successResponseSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const currentUserId = (request.iam as { id?: string } | undefined)?.id;
      if (!currentUserId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const existingMember = await workspace.getUserAccess(request.params.id, request.params.userId);
      if (!existingMember) {
        return reply.status(404).send({ error: "Member not found" });
      }

      if (request.params.userId === currentUserId) {
        return reply.status(400).send({ error: "Cannot remove yourself" });
      }

      await workspace.removeMember(request.params.id, request.params.userId);
      return { success: true };
    },
  });
}
