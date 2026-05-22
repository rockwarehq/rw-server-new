import prisma from "@rw/db";
import { getDriverInfo, validateConnection } from "../../validation.js";
import { bumpSpecVersion } from "@rw/services/device/gateway/index";

export interface CreateDatasourceInput {
  name: string;
  type?: "DEVICE" | "KIOSK" | "SERVICE" | "VIRTUAL";
  attrs?: Record<string, unknown>;
  driver: string;
  driverVersion?: string;
  connection?: Record<string, unknown>;
  gatewayId?: string;
  siteId: string;
  workspaceId: string;
}

export interface UpdateDatasourceInput {
  name?: string;
  type?: "DEVICE" | "KIOSK" | "SERVICE" | "VIRTUAL";
  attrs?: Record<string, unknown>;
  connection?: Record<string, unknown>;
}

export interface ListDatasourcesFilter {
  gatewayId?: string;
  siteId?: string;
  workspaceId?: string;
  driver?: string;
  type?: string;
  name?: string;
  status?: "DRAFT" | "ACTIVE";
  unassigned?: boolean;
  limit?: number;
  offset?: number;
}

export interface ValidationError {
  [x: string]: unknown;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

/**
 * Create a new datasource (always creates as DRAFT)
 */
export async function create(input: CreateDatasourceInput) {
  const { name, type, attrs, driver, driverVersion, connection, gatewayId, siteId, workspaceId } = input;

  // Verify site exists and belongs to workspace
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  if (site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  // Get driver info from registry (returns latest if no version specified)
  const driverInfo = getDriverInfo(driver, driverVersion);
  if (!driverInfo) {
    const versionMsg = driverVersion ? `@${driverVersion}` : "";
    return {
      error: `Driver "${driver}${versionMsg}" not found`,
      code: "DRIVER_NOT_FOUND",
    };
  }

  // No connection validation at create time - datasource is DRAFT
  // Connection will be validated on publish

  // Verify gateway exists if provided
  if (gatewayId) {
    const gateway = await prisma.gateway.findUnique({
      where: { id: gatewayId },
    });
    if (!gateway) {
      return { error: "Gateway not found", code: "GATEWAY_NOT_FOUND" };
    }
  }

  const datasource = await prisma.datasource.create({
    data: {
      name,
      type: type || "DEVICE",
      status: "DRAFT",
      attrs: attrs || {},
      driver: driverInfo.name,
      driverVersion: driverInfo.version,
      connection: connection || {},
      gatewayId,
      siteId,
    },
    include: {
      gateway: {
        select: { id: true, name: true },
      },
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
    },
  });

  // Note: Don't bump gateway spec for DRAFT datasources - they're excluded from sync

  return { data: datasource };
}

/**
 * List datasources with optional filtering and pagination
 */
export async function list(filter: ListDatasourcesFilter = {}) {
  const { gatewayId, siteId, workspaceId, driver, type, name, status, unassigned, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = {};

  if (gatewayId) {
    where.gatewayId = gatewayId;
  } else if (unassigned) {
    where.gatewayId = null;
  }

  if (siteId) {
    where.siteId = siteId;
  }

  // Filter by workspace (via site relationship)
  if (workspaceId) {
    where.site = {
      workspaceId: workspaceId,
    };
  }

  if (driver) {
    where.driver = driver;
  }

  if (type) {
    where.type = type;
  }

  if (status) {
    where.status = status;
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  const [datasources, total] = await Promise.all([
    prisma.datasource.findMany({
      where,
      include: {
        gateway: {
          select: { id: true, name: true },
        },
        site: {
          select: { id: true, name: true, workspaceId: true },
        },
        _count: {
          select: {
            points: true,
            pointGroups: true,
          },
        },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.datasource.count({ where }),
  ]);

  return {
    data: datasources,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get datasource by ID with related data
 */
export async function getById(id: string) {
  return prisma.datasource.findUnique({
    where: { id },
    include: {
      gateway: {
        select: { id: true, name: true },
      },
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
      pointGroups: {
        include: {
          _count: { select: { points: true } },
        },
      },
      points: {
        where: { groupId: null }, // Ungrouped points
      },
    },
  });
}

/**
 * Update datasource
 * - DRAFT: No connection validation (free editing)
 * - ACTIVE: Validates connection changes against driver schema
 */
export async function update(id: string, input: UpdateDatasourceInput, workspaceId?: string) {
  const { name, type, attrs, connection } = input;

  const existing = await prisma.datasource.findUnique({
    where: { id },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!existing) {
    return { error: "Datasource not found", code: "NOT_FOUND" };
  }

  // Validate workspace access if workspaceId provided
  if (workspaceId && existing.site?.workspaceId && existing.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  // If datasource is ACTIVE and connection is being updated, validate against driver schema
  if (existing.status === "ACTIVE" && connection) {
    const validation = validateConnection(existing.driver, connection, existing.driverVersion);

    if (!validation.valid) {
      return {
        error: "Connection validation failed",
        code: "VALIDATION_FAILED",
        details: validation.errors,
      };
    }
  }
  // If DRAFT, no connection validation - free editing

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (type !== undefined) updateData.type = type;
  if (attrs !== undefined) updateData.attrs = attrs;
  if (connection !== undefined) updateData.connection = connection;

  const datasource = await prisma.datasource.update({
    where: { id },
    data: updateData,
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
    },
  });

  // Update gateway spec if ACTIVE and associated with a gateway
  if (datasource.status === "ACTIVE" && datasource.gatewayId) {
    await bumpSpecVersion(datasource.gatewayId);
  }

  return { data: datasource };
}

/**
 * Delete datasource
 */
export async function remove(id: string, workspaceId?: string) {
  const existing = await prisma.datasource.findUnique({
    where: { id },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!existing) {
    return { error: "Datasource not found", code: "NOT_FOUND" };
  }

  // Validate workspace access if workspaceId provided
  if (workspaceId && existing.site?.workspaceId && existing.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  const gatewayId = existing.gatewayId;
  const wasActive = existing.status === "ACTIVE";

  await prisma.datasource.delete({ where: { id } });

  // Update gateway spec if was ACTIVE and associated with a gateway
  if (wasActive && gatewayId) {
    await bumpSpecVersion(gatewayId);
  }

  return { success: true };
}

/**
 * Publish datasource (DRAFT -> ACTIVE)
 * Validates connection info exists and is valid against driver schema
 */
export async function publish(id: string, workspaceId?: string) {
  const existing = await prisma.datasource.findUnique({
    where: { id },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!existing) {
    return { error: "Datasource not found", code: "NOT_FOUND" };
  }

  // Validate workspace access if workspaceId provided
  if (workspaceId && existing.site?.workspaceId && existing.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  if (existing.status !== "DRAFT") {
    return {
      error: "Only DRAFT datasources can be published",
      code: "INVALID_STATUS",
    };
  }

  // Check connection exists and is not empty
  const connection = existing.connection as Record<string, unknown>;
  if (!connection || Object.keys(connection).length === 0) {
    return {
      error: "Connection info required to publish",
      code: "CONNECTION_REQUIRED",
    };
  }

  // Validate connection against driver schema
  const validation = validateConnection(existing.driver, connection, existing.driverVersion);
  if (!validation.valid) {
    return {
      error: "Connection validation failed",
      code: "VALIDATION_FAILED",
      details: validation.errors,
    };
  }

  const datasource = await prisma.datasource.update({
    where: { id },
    data: { status: "ACTIVE" },
    include: {
      gateway: {
        select: { id: true, name: true },
      },
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
    },
  });

  // Bump gateway spec if assigned (datasource now included in sync)
  if (datasource.gatewayId) {
    await bumpSpecVersion(datasource.gatewayId);
  }

  return { data: datasource };
}

/**
 * Unpublish datasource (ACTIVE -> DRAFT)
 * Removes datasource from gateway sync
 */
export async function unpublish(id: string, workspaceId?: string) {
  const existing = await prisma.datasource.findUnique({
    where: { id },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!existing) {
    return { error: "Datasource not found", code: "NOT_FOUND" };
  }

  // Validate workspace access if workspaceId provided
  if (workspaceId && existing.site?.workspaceId && existing.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  if (existing.status !== "ACTIVE") {
    return {
      error: "Only ACTIVE datasources can be unpublished",
      code: "INVALID_STATUS",
    };
  }

  const datasource = await prisma.datasource.update({
    where: { id },
    data: { status: "DRAFT" },
    include: {
      gateway: {
        select: { id: true, name: true },
      },
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
    },
  });

  // Bump gateway spec if assigned (datasource now excluded from sync)
  if (datasource.gatewayId) {
    await bumpSpecVersion(datasource.gatewayId);
  }

  return { data: datasource };
}

/**
 * Assign or unassign datasource to a gateway
 */
export async function assign(id: string, gatewayId: string | null) {
  const existing = await prisma.datasource.findUnique({ where: { id } });
  if (!existing) {
    return { error: "Datasource not found", code: "NOT_FOUND" };
  }

  // Verify new gateway exists if provided
  if (gatewayId) {
    const gateway = await prisma.gateway.findUnique({
      where: { id: gatewayId },
    });
    if (!gateway) {
      return { error: "Gateway not found", code: "GATEWAY_NOT_FOUND" };
    }
  }

  const oldGatewayId = existing.gatewayId;
  const isActive = existing.status === "ACTIVE";

  const datasource = await prisma.datasource.update({
    where: { id },
    data: { gatewayId },
  });

  // Only bump gateway specs if datasource is ACTIVE (DRAFT excluded from sync)
  if (isActive) {
    // Update old gateway spec (remove datasource)
    if (oldGatewayId && oldGatewayId !== gatewayId) {
      await bumpSpecVersion(oldGatewayId);
    }

    // Update new gateway spec (add datasource)
    if (gatewayId) {
      await bumpSpecVersion(gatewayId);
    }
  }

  return { data: datasource };
}

/**
 * Check if datasource exists
 */
export async function exists(id: string) {
  const datasource = await prisma.datasource.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!datasource;
}

/**
 * Get datasource with driver info (for validation)
 */
export async function getWithDriver(id: string) {
  return prisma.datasource.findUnique({
    where: { id },
    select: {
      id: true,
      driver: true,
      driverVersion: true,
      gatewayId: true,
      status: true,
    },
  });
}
