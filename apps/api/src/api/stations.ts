import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { station } from "@rw/services/facility/index";
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

const workcenterSummarySchema = {
  type: "object",
  nullable: true,
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
  },
} as const satisfies JSONSchema;

const stationProperties = {
  id: { type: "string", format: "uuid" },
  name: { type: "string" },
  description: { type: "string", nullable: true },
  attrs: { type: "object", additionalProperties: true },
  siteId: { type: "string", format: "uuid" },
  workcenterId: { type: "string", format: "uuid", nullable: true },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const stationSchema = {
  type: "object",
  properties: {
    ...stationProperties,
    site: siteSummarySchema,
    workcenter: workcenterSummarySchema,
  },
} as const satisfies JSONSchema;

const createBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    attrs: { type: "object", additionalProperties: true },
    siteId: { type: "string", format: "uuid" },
    workcenterId: { type: "string", format: "uuid" },
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
    workcenterId: { type: ["string", "null"], format: "uuid" },
  },
  required: ["workcenterId"],
} as const satisfies JSONSchema;

const listQuerySchema = {
  type: "object",
  properties: {
    siteId: { type: "string", format: "uuid" },
    workcenterId: { type: "string", format: "uuid" },
    name: { type: "string" },
    limit: { type: "number", default: 50 },
    offset: { type: "number", default: 0 },
  },
} as const satisfies JSONSchema;

const listResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: stationSchema },
    total: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" },
  },
} as const satisfies JSONSchema;

// ============================================================================
// Helper
// ============================================================================

function getStatusForCode(code: string): 400 | 401 | 404 | 409 {
  switch (code) {
    case "WORKSPACE_MISMATCH":
      return 401;
    case "STATION_NOT_FOUND":
    case "WORKCENTER_NOT_FOUND":
    case "SITE_NOT_FOUND":
      return 404;
    case "SITE_MISMATCH":
      return 409;
    default:
      return 400;
  }
}

// ============================================================================
// Routes
// ============================================================================

export default async function stations(fastify: FastifyTypedInstance) {
  // Create station
  fastify.route({
    method: "POST",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
      security: [{ bearerAuth: [] }],
      body: createBodySchema,
      response: {
        201: stationSchema,
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

      const result = await station.create(request.body);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return reply.status(201).send(result.data);
    },
  });

  // List stations
  fastify.route({
    method: "GET",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
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

      return station.list({
        ...request.query,
        workspaceId,
        siteIds: request.query.siteId || access.all ? undefined : access.siteIds,
      });
    },
  });

  // Get station by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: stationSchema,
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

      const result = await station.getById(request.params.id, workspaceId);
      if (!result) {
        return reply.status(404).send({ error: "Station not found" });
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

  // Update station
  fastify.route({
    method: "PUT",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: updateBodySchema,
      response: {
        200: stationSchema,
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

      const existing = await station.getById(request.params.id, workspaceId);
      if (!existing || "error" in existing) return reply.status(404).send({ error: "Station not found" });
      if (!userId || !(await hasPermission(userId, "facility:write", { workspaceId, siteId: existing.data.siteId }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:write" });
      }

      const result = await station.update(request.params.id, request.body, workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Move station (change workcenter)
  fastify.route({
    method: "POST",
    url: "/:id/move",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: moveBodySchema,
      response: {
        200: stationSchema,
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

      const existing = await station.getById(request.params.id, workspaceId);
      if (!existing || "error" in existing) return reply.status(404).send({ error: "Station not found" });
      if (!userId || !(await hasPermission(userId, "facility:write", { workspaceId, siteId: existing.data.siteId }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:write" });
      }

      const result = await station.move(request.params.id, request.body.workcenterId, workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Delete station
  fastify.route({
    method: "DELETE",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
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

      const existing = await station.getById(request.params.id, workspaceId);
      if (!existing || "error" in existing) return reply.status(404).send({ error: "Station not found" });
      if (!userId || !(await hasPermission(userId, "facility:admin", { workspaceId, siteId: existing.data.siteId }))) {
        return reply.status(403).send({ error: "forbidden", required: "facility:admin" });
      }

      const result = await station.remove(request.params.id, workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return { success: true };
    },
  });
}
