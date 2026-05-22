import prisma from "@rw/db";
import { validatePointGroupConfig } from "../../validation.js";
import { bumpSpecVersion } from "@rw/services/device/gateway/index";

export interface CreateGroupInput {
  name: string;
  description?: string;
  pollRateMs?: number;
  config?: Record<string, unknown>;
}

export interface UpdateGroupInput {
  name?: string;
  description?: string;
  pollRateMs?: number;
  config?: Record<string, unknown>;
}

/**
 * Create a point group for a datasource
 */
export async function create(datasourceId: string, input: CreateGroupInput) {
  const { name, description, pollRateMs, config } = input;

  const datasource = await prisma.datasource.findUnique({ where: { id: datasourceId } });
  if (!datasource) {
    return { error: "Datasource not found", code: "DATASOURCE_NOT_FOUND" };
  }

  // Validate config against driver's pointGroupSchema (if config provided)
  if (config && Object.keys(config).length > 0) {
    const validation = validatePointGroupConfig(datasource.driver, config, datasource.driverVersion);
    if (!validation.valid) {
      return {
        error: "Point group config validation failed",
        code: "VALIDATION_FAILED",
        details: validation.errors,
      };
    }
  }

  const group = await prisma.pointGroup.create({
    data: {
      name,
      description,
      pollRateMs: pollRateMs || 1000,
      config: config || {},
      datasourceId,
    },
  });

  // Update gateway spec
  if (datasource.gatewayId) {
    await bumpSpecVersion(datasource.gatewayId);
  }

  return { data: group };
}

/**
 * List point groups for a datasource
 */
export async function list(datasourceId: string) {
  const datasource = await prisma.datasource.findUnique({ where: { id: datasourceId } });
  if (!datasource) {
    return { error: "Datasource not found", code: "DATASOURCE_NOT_FOUND" };
  }

  const groups = await prisma.pointGroup.findMany({
    where: { datasourceId },
    include: {
      _count: { select: { points: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return { data: groups };
}

/**
 * Get point group by ID
 */
export async function getById(id: string) {
  return prisma.pointGroup.findUnique({
    where: { id },
    include: {
      datasource: {
        select: { id: true, name: true, driver: true, gatewayId: true },
      },
      points: true,
      _count: { select: { points: true } },
    },
  });
}

/**
 * Update point group
 */
export async function update(id: string, input: UpdateGroupInput) {
  const { name, description, pollRateMs, config } = input;

  const existing = await prisma.pointGroup.findUnique({
    where: { id },
    include: {
      datasource: {
        select: { driver: true, driverVersion: true, gatewayId: true },
      },
    },
  });

  if (!existing) {
    return { error: "Point group not found", code: "NOT_FOUND" };
  }

  // Validate config against driver's pointGroupSchema (if config provided)
  if (config && Object.keys(config).length > 0) {
    const validation = validatePointGroupConfig(existing.datasource.driver, config, existing.datasource.driverVersion);
    if (!validation.valid) {
      return {
        error: "Point group config validation failed",
        code: "VALIDATION_FAILED",
        details: validation.errors,
      };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (pollRateMs !== undefined) updateData.pollRateMs = pollRateMs;
  if (config !== undefined) updateData.config = config;

  const group = await prisma.pointGroup.update({
    where: { id },
    data: updateData,
  });

  // Update gateway spec
  if (existing.datasource.gatewayId) {
    await bumpSpecVersion(existing.datasource.gatewayId);
  }

  return { data: group };
}

/**
 * Delete point group
 */
export async function remove(id: string) {
  const existing = await prisma.pointGroup.findUnique({
    where: { id },
    include: {
      datasource: {
        select: { gatewayId: true },
      },
    },
  });

  if (!existing) {
    return { error: "Point group not found", code: "NOT_FOUND" };
  }

  await prisma.pointGroup.delete({ where: { id } });

  // Update gateway spec
  if (existing.datasource.gatewayId) {
    await bumpSpecVersion(existing.datasource.gatewayId);
  }

  return { success: true };
}

/**
 * Check if point group exists
 */
export async function exists(id: string) {
  const group = await prisma.pointGroup.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!group;
}
