import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { site } from "@rw/services/facility/index";
import { errorSchema, idParamsSchema, successResponseSchema } from "./schemas.js";
import { getAccessibleSites, hasPermission } from "@rw/services/iam/index";

// ============================================================================
// Schemas
// ============================================================================

const siteProperties = {
  id: { type: "string", format: "uuid" },
  name: { type: "string" },
  description: { type: "string", nullable: true },
  attrs: { type: "object", additionalProperties: true },
  workspaceId: { type: "string", format: "uuid" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const siteCountsSchema = {
  type: "object",
  properties: {
    workcenters: { type: "number" },
    gateways: { type: "number" },
    datasources: { type: "number" },
  },
} as const satisfies JSONSchema;

const siteSchema = {
  type: "object",
  properties: {
    ...siteProperties,
    _count: siteCountsSchema,
  },
} as const satisfies JSONSchema;

const createBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    attrs: { type: "object", additionalProperties: true },
  },
  required: ["name"],
} as const satisfies JSONSchema;

const updateBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    attrs: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

const listQuerySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    limit: { type: "number", default: 50 },
    offset: { type: "number", default: 0 },
  },
} as const satisfies JSONSchema;

const listResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: siteSchema },
    total: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" },
  },
} as const satisfies JSONSchema;

const workcenterTreeNodeSchema: JSONSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    description: { type: "string", nullable: true },
    attrs: { type: "object", additionalProperties: true },
    children: { type: "array", items: { $ref: "#" } },
    stations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string", nullable: true },
          attrs: { type: "object", additionalProperties: true },
        },
      },
    },
  },
};

const siteTreeNodeSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    description: { type: "string", nullable: true },
    attrs: { type: "object", additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    workcenters: { type: "array", items: workcenterTreeNodeSchema },
  },
} as const satisfies JSONSchema;

const treeResponseSchema = {
  type: "array",
  items: siteTreeNodeSchema,
} as const satisfies JSONSchema;

const getSiteResponseSchema = {
  type: "object",
  properties: {
    ...siteProperties,
    workcenters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string", nullable: true },
          _count: {
            type: "object",
            properties: {
              children: { type: "number" },
              stations: { type: "number" },
            },
          },
        },
      },
    },
    gateways: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          serialNumber: { type: "string" },
          status: { type: "string" },
        },
      },
    },
    datasources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          type: { type: "string" },
          driver: { type: "string" },
        },
      },
    },
    _count: siteCountsSchema,
  },
} as const satisfies JSONSchema;

// ============================================================================
// Helper
// ============================================================================

function getStatusForCode(code: string): 401 | 404 | 400 | 409 {
  switch (code) {
    case "WORKSPACE_MISMATCH":
      return 401;
    case "SITE_NOT_FOUND":
      return 404;
    case "HAS_WORKCENTERS":
    case "HAS_GATEWAYS":
    case "HAS_DATASOURCES":
      return 409;
    default:
      return 400;
  }
}

// ============================================================================
// Routes
// ============================================================================

export default async function sites(fastify: FastifyTypedInstance) {
  // Create site
  fastify.route({
    method: "POST",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["sites"],
      security: [{ bearerAuth: [] }],
      body: createBodySchema,
      response: {
        201: siteSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = request.iam?.workspaceId;
      const userId = request.iam?.id;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }
      if (!userId || !(await hasPermission(userId, "facility:write", { workspaceId }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:write" });
      }

      const result = await site.create({ ...request.body, workspaceId });
      if ("error" in result && typeof result.error === "string") {
        return reply.status(400).send({ error: result.error });
      }
      return reply.status(201).send(result.data);
    },
  });

  // List sites
  fastify.route({
    method: "GET",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["sites"],
      security: [{ bearerAuth: [] }],
      querystring: listQuerySchema,
      response: {
        200: listResponseSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = request.iam?.workspaceId;
      const userId = request.iam?.id;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }

      if (!userId) return reply.status(401).send({ error: "Unauthorized" });
      const access = await getAccessibleSites(userId, "facility:read", workspaceId);
      return site.list({
        ...request.query,
        workspaceId,
        siteIds: access.all ? undefined : access.siteIds,
      });
    },
  });

  // Get site tree (full hierarchy for workspace)
  fastify.route({
    method: "GET",
    url: "/tree",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["sites"],
      security: [{ bearerAuth: [] }],
      response: {
        200: treeResponseSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = request.iam?.workspaceId;
      const userId = request.iam?.id;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }

      if (!userId) return reply.status(401).send({ error: "Unauthorized" });
      const access = await getAccessibleSites(userId, "facility:read", workspaceId);
      return site.getTree(workspaceId, access.all ? undefined : access.siteIds);
    },
  });

  // Get site by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["sites"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: getSiteResponseSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = request.iam?.workspaceId;
      const userId = request.iam?.id;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }

      const result = await site.getById(request.params.id, workspaceId);
      if (!result) {
        return reply.status(404).send({ error: "Site not found" });
      }
      if ("error" in result) {
        return reply.status(401).send({ error: result.error });
      }
      if (!userId || !(await hasPermission(userId, "facility:read", { workspaceId, siteId: request.params.id }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:read" });
      }
      return result.data;
    },
  });

  // Update site
  fastify.route({
    method: "PUT",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["sites"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: updateBodySchema,
      response: {
        200: siteSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
        409: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = request.iam?.workspaceId;
      const userId = request.iam?.id;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }
      if (!userId || !(await hasPermission(userId, "facility:write", { workspaceId, siteId: request.params.id }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:write" });
      }

      const result = await site.update(request.params.id, request.body, workspaceId);
      if ("error" in result) {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Delete site
  fastify.route({
    method: "DELETE",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["sites"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: successResponseSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
        409: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = request.iam?.workspaceId;
      const userId = request.iam?.id;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }
      if (!userId || !(await hasPermission(userId, "facility:admin", { workspaceId, siteId: request.params.id }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:admin" });
      }

      const result = await site.remove(request.params.id, workspaceId);
      if ("error" in result) {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return { success: true };
    },
  });
}
