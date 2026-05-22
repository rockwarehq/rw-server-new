import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { workcenter } from "@rw/services/facility/index";
import { errorSchema, idParamsSchema, successResponseSchema } from "./schemas.js";
import { getAccessibleSites, hasPermission } from "@rw/services/iam/index";

// ============================================================================
// Schemas
// ============================================================================

const siteSummarySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    workspaceId: { type: "string", format: "uuid" },
  },
} as const satisfies JSONSchema;

const parentSummarySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
  },
  nullable: true,
} as const satisfies JSONSchema;

const workcenterCountsSchema = {
  type: "object",
  properties: {
    children: { type: "number" },
    stations: { type: "number" },
  },
} as const satisfies JSONSchema;

const workcenterProperties = {
  id: { type: "string", format: "uuid" },
  name: { type: "string" },
  description: { type: "string", nullable: true },
  attrs: { type: "object", additionalProperties: true },
  siteId: { type: "string", format: "uuid" },
  parentId: { type: ["string", "null"], format: "uuid" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const workcenterSchema = {
  type: "object",
  properties: {
    ...workcenterProperties,
    site: siteSummarySchema,
    parent: parentSummarySchema,
    _count: workcenterCountsSchema,
  },
} as const satisfies JSONSchema;

const createBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    attrs: { type: "object", additionalProperties: true },
    siteId: { type: "string", format: "uuid" },
    parentId: { type: "string", format: "uuid" },
  },
  required: ["name", "siteId"],
} as const satisfies JSONSchema;

const updateBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    attrs: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

const moveBodySchema = {
  type: "object",
  properties: {
    parentId: { type: ["string", "null"], format: "uuid" },
  },
  required: ["parentId"],
} as const satisfies JSONSchema;

const listQuerySchema = {
  type: "object",
  properties: {
    siteId: { type: "string", format: "uuid" },
    parentId: { type: "string", format: "uuid" },
    name: { type: "string" },
    limit: { type: "number", default: 50 },
    offset: { type: "number", default: 0 },
  },
} as const satisfies JSONSchema;

const listResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: workcenterSchema },
    total: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" },
  },
} as const satisfies JSONSchema;

const getWorkcenterResponseSchema = {
  type: "object",
  properties: {
    ...workcenterProperties,
    site: siteSummarySchema,
    parent: parentSummarySchema,
    children: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string", nullable: true },
          _count: workcenterCountsSchema,
        },
      },
    },
    stations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string", nullable: true },
        },
      },
    },
    _count: workcenterCountsSchema,
  },
} as const satisfies JSONSchema;

// ============================================================================
// Helper
// ============================================================================

function getStatusForCode(code: string): 400 | 401 | 404 | 409 {
  switch (code) {
    case "WORKSPACE_MISMATCH":
      return 401;
    case "SITE_NOT_FOUND":
    case "WORKCENTER_NOT_FOUND":
    case "PARENT_NOT_FOUND":
      return 404;
    case "SITE_MISMATCH":
    case "CIRCULAR_REFERENCE":
    case "HAS_CHILDREN":
    case "HAS_STATIONS":
      return 409;
    default:
      return 400;
  }
}

// ============================================================================
// Routes
// ============================================================================

export default async function workcenters(fastify: FastifyTypedInstance) {
  // Create workcenter
  fastify.route({
    method: "POST",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
      security: [{ bearerAuth: [] }],
      body: createBodySchema,
      response: {
        201: workcenterSchema,
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
      if (!userId || !(await hasPermission(userId, "facility:write", { workspaceId, siteId: request.body.siteId }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:write" });
      }

      const result = await workcenter.create(request.body);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return reply.status(201).send(result.data);
    },
  });

  // List workcenters
  fastify.route({
    method: "GET",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
      security: [{ bearerAuth: [] }],
      querystring: listQuerySchema,
      response: {
        200: listResponseSchema,
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

      if (!userId) return reply.status(401).send({ error: "Unauthorized" });
      const access = await getAccessibleSites(userId, "facility:read", workspaceId);
      if (request.query.siteId && !access.all && !access.siteIds.includes(request.query.siteId)) {
        return reply.status(403).send({ error: "forbidden", required: "facility:read" });
      }
      return workcenter.list({
        ...request.query,
        siteIds: request.query.siteId || access.all ? undefined : access.siteIds,
      });
    },
  });

  // Get workcenter by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: getWorkcenterResponseSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = request.iam?.workspaceId;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }

      const result = await workcenter.getById(request.params.id, workspaceId);
      if (!result) {
        return reply.status(404).send({ error: "Workcenter not found" });
      }
      if ("error" in result) {
        return reply.status(401).send({ error: result.error });
      }
      const userId = request.iam?.id;
      if (!userId || !(await hasPermission(userId, "facility:read", { workspaceId, siteId: result.data.siteId }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:read" });
      }
      return result.data;
    },
  });

  // Update workcenter
  fastify.route({
    method: "PUT",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: updateBodySchema,
      response: {
        200: workcenterSchema,
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

      const existing = await workcenter.getById(request.params.id, workspaceId);
      if (!existing || "error" in existing) return reply.status(404).send({ error: "Workcenter not found" });
      if (!userId || !(await hasPermission(userId, "facility:write", { workspaceId, siteId: existing.data.siteId }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:write" });
      }

      const result = await workcenter.update(request.params.id, request.body, workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Move workcenter (change parent)
  fastify.route({
    method: "POST",
    url: "/:id/move",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: moveBodySchema,
      response: {
        200: workcenterSchema,
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

      const existing = await workcenter.getById(request.params.id, workspaceId);
      if (!existing || "error" in existing) return reply.status(404).send({ error: "Workcenter not found" });
      if (!userId || !(await hasPermission(userId, "facility:write", { workspaceId, siteId: existing.data.siteId }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:write" });
      }

      const result = await workcenter.move(request.params.id, request.body.parentId, workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Delete workcenter
  fastify.route({
    method: "DELETE",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
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

      const existing = await workcenter.getById(request.params.id, workspaceId);
      if (!existing || "error" in existing) return reply.status(404).send({ error: "Workcenter not found" });
      if (!userId || !(await hasPermission(userId, "facility:admin", { workspaceId, siteId: existing.data.siteId }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:admin" });
      }

      const result = await workcenter.remove(request.params.id, workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return { success: true };
    },
  });
}
