import prisma from "@rw/db";
import { validatePointConfig } from "../../validation.js";
import { bumpSpecVersion } from "@rw/services/device/gateway/index";

export interface CreatePointInput {
  name: string;
  description?: string;
  address: string;
  dataType: string;
  scaleFactor?: number;
  offset?: number;
  config?: Record<string, unknown>;
  groupId?: string | null;
}

export interface UpdatePointInput {
  name?: string;
  description?: string;
  address?: string;
  dataType?: string;
  scaleFactor?: number;
  offset?: number;
  config?: Record<string, unknown>;
  groupId?: string | null;
}

export interface ListPointsFilter {
  datasourceId?: string;
  groupId?: string;
  ungrouped?: boolean;
}

/**
 * Create a point for a datasource
 */
export async function create(datasourceId: string, input: CreatePointInput) {
  const { name, description, address, dataType, scaleFactor, offset, config, groupId: rawGroupId } = input;

  // Convert empty string to null
  const groupId = rawGroupId === "" ? null : rawGroupId;

  const datasource = await prisma.datasource.findUnique({ where: { id: datasourceId } });
  if (!datasource) {
    return { error: "Datasource not found", code: "DATASOURCE_NOT_FOUND" };
  }

  // Verify group exists and belongs to same datasource if provided
  if (groupId) {
    const group = await prisma.pointGroup.findUnique({ where: { id: groupId } });
    if (!group) {
      return { error: "Point group not found", code: "GROUP_NOT_FOUND" };
    }
    if (group.datasourceId !== datasourceId) {
      return { error: "Point group belongs to different datasource", code: "GROUP_MISMATCH" };
    }
  }

  // Validate config against driver's pointSchema (if config provided)
  if (config && Object.keys(config).length > 0) {
    const requiredConfig = { address, dataType, ...config };
    const validation = validatePointConfig(datasource.driver, requiredConfig, datasource.driverVersion);
    if (!validation.valid) {
      return {
        error: "Point config validation failed",
        code: "VALIDATION_FAILED",
        details: validation.errors,
      };
    }
  }

  const point = await prisma.point.create({
    data: {
      name,
      description,
      address,
      dataType,
      scaleFactor: scaleFactor ?? 1.0,
      offset: offset ?? 0.0,
      config: config || {},
      datasourceId,
      groupId,
    },
  });

  // Update gateway spec
  if (datasource.gatewayId) {
    await bumpSpecVersion(datasource.gatewayId);
  }

  return { data: point };
}

/**
 * List points for a datasource with optional filtering
 */
export async function list(datasourceId: string, filter: Omit<ListPointsFilter, "datasourceId"> = {}) {
  const { groupId, ungrouped } = filter;

  const datasource = await prisma.datasource.findUnique({ where: { id: datasourceId } });
  if (!datasource) {
    return { error: "Datasource not found", code: "DATASOURCE_NOT_FOUND" };
  }

  const where: Record<string, unknown> = { datasourceId };
  if (groupId) {
    where.groupId = groupId;
  } else if (ungrouped) {
    where.groupId = null;
  }

  const points = await prisma.point.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });

  return { data: points };
}

/**
 * Get point by ID
 */
export async function getById(id: string) {
  return prisma.point.findUnique({
    where: { id },
    include: {
      datasource: {
        select: { id: true, name: true, driver: true, gatewayId: true },
      },
      group: {
        select: { id: true, name: true },
      },
    },
  });
}

/**
 * Update point
 */
export async function update(id: string, input: UpdatePointInput) {
  const { name, description, address, dataType, scaleFactor, offset, config, groupId: rawGroupId } = input;

  // Convert empty string to null
  const groupId = rawGroupId === "" ? null : rawGroupId;

  const existing = await prisma.point.findUnique({
    where: { id },
    include: {
      datasource: {
        select: { id: true, driver: true, driverVersion: true, gatewayId: true },
      },
    },
  });

  if (!existing) {
    return { error: "Point not found", code: "NOT_FOUND" };
  }

  // Verify group exists and belongs to same datasource if provided
  if (groupId) {
    const group = await prisma.pointGroup.findUnique({ where: { id: groupId } });
    if (!group) {
      return { error: "Point group not found", code: "GROUP_NOT_FOUND" };
    }
    if (group.datasourceId !== existing.datasourceId) {
      return { error: "Point group belongs to different datasource", code: "GROUP_MISMATCH" };
    }
  }

  // Validate config against driver's pointSchema (if config provided)
  if (config && Object.keys(config).length > 0) {
    const requiredConfig = { address, dataType, ...config };
    const validation = validatePointConfig(
      existing.datasource.driver,
      requiredConfig,
      existing.datasource.driverVersion,
    );
    if (!validation.valid) {
      return {
        error: "Point config validation failed",
        code: "VALIDATION_FAILED",
        details: validation.errors,
      };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (address !== undefined) updateData.address = address;
  if (dataType !== undefined) updateData.dataType = dataType;
  if (scaleFactor !== undefined) updateData.scaleFactor = scaleFactor;
  if (offset !== undefined) updateData.offset = offset;
  if (config !== undefined) updateData.config = config;
  if (groupId !== undefined) updateData.groupId = groupId;

  const point = await prisma.point.update({
    where: { id },
    data: updateData,
  });

  // Update gateway spec
  if (existing.datasource.gatewayId) {
    await bumpSpecVersion(existing.datasource.gatewayId);
  }

  return { data: point };
}

/**
 * Delete point
 */
export async function remove(id: string) {
  const existing = await prisma.point.findUnique({
    where: { id },
    include: {
      datasource: {
        select: { gatewayId: true },
      },
    },
  });

  if (!existing) {
    return { error: "Point not found", code: "NOT_FOUND" };
  }

  await prisma.point.delete({ where: { id } });

  // Update gateway spec
  if (existing.datasource.gatewayId) {
    await bumpSpecVersion(existing.datasource.gatewayId);
  }

  return { success: true };
}

/**
 * Bulk create points for a datasource
 */
export async function bulkCreate(datasourceId: string, pointsInput: CreatePointInput[]) {
  const datasource = await prisma.datasource.findUnique({ where: { id: datasourceId } });
  if (!datasource) {
    return { error: "Datasource not found", code: "DATASOURCE_NOT_FOUND" };
  }

  // Convert empty string groupIds to null
  const pointsData = pointsInput.map((p) => ({
    ...p,
    groupId: p.groupId === "" ? null : p.groupId,
  }));

  // Validate all point configs before creating any
  for (let i = 0; i < pointsData.length; i++) {
    const p = pointsData[i];
    if (p.config && Object.keys(p.config).length > 0) {
      const validation = validatePointConfig(datasource.driver, p.config, datasource.driverVersion);
      if (!validation.valid) {
        return {
          error: `Point config validation failed for point at index ${i} ("${p.name}")`,
          code: "VALIDATION_FAILED",
          details: validation.errors,
        };
      }
    }
  }

  // Create all points in a transaction
  const createdPoints = await prisma.$transaction(
    pointsData.map((p) =>
      prisma.point.create({
        data: {
          name: p.name,
          description: p.description,
          address: p.address,
          dataType: p.dataType,
          scaleFactor: p.scaleFactor ?? 1.0,
          offset: p.offset ?? 0.0,
          config: p.config || {},
          datasourceId,
          groupId: p.groupId,
        },
      }),
    ),
  );

  // Update gateway spec once after all points created
  if (datasource.gatewayId) {
    await bumpSpecVersion(datasource.gatewayId);
  }

  return {
    data: {
      created: createdPoints.length,
      points: createdPoints,
    },
  };
}

/**
 * Check if point exists
 */
export async function exists(id: string) {
  const point = await prisma.point.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!point;
}
