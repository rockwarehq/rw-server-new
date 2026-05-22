import prisma from "@rw/db";
import { seedDefaults as seedDefaultRoles } from "../../employee/role.js";

export interface CreateSiteInput {
  name: string;
  description?: string;
  attrs?: Record<string, unknown>;
  workspaceId: string;
}

export interface UpdateSiteInput {
  name?: string;
  description?: string;
  timezone?: string;
  attrs?: Record<string, unknown>;
}

export interface ListSitesFilter {
  workspaceId?: string;
  siteIds?: string[];
  name?: string;
  limit?: number;
  offset?: number;
}

/**
 * Create a new site
 */
export async function create(input: CreateSiteInput) {
  const { name, description, attrs, workspaceId } = input;

  const site = await prisma.site.create({
    data: {
      name,
      description,
      attrs: attrs ?? {},
      workspaceId,
    },
    include: {
      _count: {
        select: { workcenters: true, gateways: true, datasources: true },
      },
    },
  });

  // Seed default employee roles for the new site
  await seedDefaultRoles(site.id);

  return { data: site };
}

/**
 * List sites with optional filtering
 */
export async function list(filter: ListSitesFilter = {}) {
  const { workspaceId, siteIds, name, limit = 50, offset = 0 } = filter;

  if (siteIds && siteIds.length === 0) {
    return { data: [], total: 0, limit: Number(limit), offset: Number(offset) };
  }

  const where: Record<string, unknown> = {};

  if (workspaceId) {
    where.workspaceId = workspaceId;
  }

  if (siteIds) {
    where.id = { in: siteIds };
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  const [sites, total] = await Promise.all([
    prisma.site.findMany({
      where,
      include: {
        _count: {
          select: { workcenters: true, gateways: true, datasources: true },
        },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.site.count({ where }),
  ]);

  return {
    data: sites,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get site by ID with related entities
 */
export async function getById(id: string, workspaceId?: string) {
  const site = await prisma.site.findUnique({
    where: { id },
    include: {
      workcenters: {
        where: { parentId: null }, // Only top-level workcenters
        select: {
          id: true,
          name: true,
          description: true,
          _count: { select: { children: true, stations: true } },
        },
        orderBy: { name: "asc" },
      },
      gateways: {
        select: {
          id: true,
          name: true,
          serialNumber: true,
          status: true,
        },
        orderBy: { name: "asc" },
      },
      datasources: {
        select: {
          id: true,
          name: true,
          type: true,
          driver: true,
        },
        orderBy: { name: "asc" },
      },
      _count: {
        select: { workcenters: true, gateways: true, datasources: true },
      },
    },
  });

  if (!site) {
    return null;
  }

  // Validate workspace access
  if (workspaceId && site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  return { data: site };
}

/**
 * Update site
 */
export async function update(id: string, input: UpdateSiteInput, workspaceId?: string) {
  const { name, description, timezone, attrs } = input;

  // Get current site
  const current = await prisma.site.findUnique({
    where: { id },
    select: { id: true, workspaceId: true },
  });

  if (!current) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && current.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (timezone !== undefined) updateData.timezone = timezone;
  if (attrs !== undefined) updateData.attrs = attrs;

  const site = await prisma.site.update({
    where: { id },
    data: updateData,
    include: {
      _count: {
        select: { workcenters: true, gateways: true, datasources: true },
      },
    },
  });

  return { data: site };
}

/**
 * Delete site (fails if has workcenters, gateways, or datasources)
 */
export async function remove(id: string, workspaceId?: string) {
  const site = await prisma.site.findUnique({
    where: { id },
    include: {
      _count: { select: { workcenters: true, gateways: true, datasources: true } },
    },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  if (site._count.workcenters > 0) {
    return {
      error: "Cannot delete site with workcenters. Delete workcenters first.",
      code: "HAS_WORKCENTERS",
    };
  }

  if (site._count.gateways > 0) {
    return {
      error: "Cannot delete site with gateways. Move or delete gateways first.",
      code: "HAS_GATEWAYS",
    };
  }

  if (site._count.datasources > 0) {
    return {
      error: "Cannot delete site with datasources. Move or delete datasources first.",
      code: "HAS_DATASOURCES",
    };
  }

  await prisma.site.delete({ where: { id } });

  return { success: true };
}

/**
 * Build workcenter tree for a site (internal helper)
 */
async function buildSiteWorkcenterTree(siteId: string) {
  // Get all workcenters for this site
  const workcenters = await prisma.workcenter.findMany({
    where: { siteId },
    select: {
      id: true,
      name: true,
      description: true,
      attrs: true,
      parentId: true,
      stations: {
        select: {
          id: true,
          name: true,
          description: true,
          attrs: true,
        },
        orderBy: { name: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  // Build nested workcenter hierarchy
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workcenterMap = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rootWorkcenters: any[] = [];

  // First pass: create map entries
  for (const wc of workcenters) {
    workcenterMap.set(wc.id, {
      id: wc.id,
      name: wc.name,
      description: wc.description,
      attrs: wc.attrs,
      children: [],
      stations: wc.stations,
    });
  }

  // Second pass: build hierarchy
  for (const wc of workcenters) {
    const node = workcenterMap.get(wc.id);
    if (wc.parentId) {
      const parent = workcenterMap.get(wc.parentId);
      if (parent) {
        parent.children.push(node);
      }
    } else {
      rootWorkcenters.push(node);
    }
  }

  return rootWorkcenters;
}

/**
 * Get tree for a single site (Site -> Workcenter -> Station)
 */
export async function getSiteTree(siteId: string, workspaceId?: string) {
  // Get site and validate access
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      name: true,
      description: true,
      attrs: true,
      workspaceId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  const workcenters = await buildSiteWorkcenterTree(siteId);

  // Get ungrouped stations (directly under site, no workcenter)
  const stations = await prisma.station.findMany({
    where: { siteId, workcenterId: null },
    select: {
      id: true,
      name: true,
      description: true,
      attrs: true,
    },
  });

  return {
    data: {
      id: site.id,
      name: site.name,
      description: site.description,
      attrs: site.attrs,
      createdAt: site.createdAt,
      updatedAt: site.updatedAt,
      stations,
      workcenters,
    },
  };
}

/**
 * Get full tree for a workspace (Site -> Workcenter -> Station)
 */
export async function getTree(workspaceId: string, siteIds?: string[]) {
  if (siteIds && siteIds.length === 0) {
    return [];
  }

  // Get all sites for the workspace
  const sites = await prisma.site.findMany({
    where: { workspaceId, ...(siteIds ? { id: { in: siteIds } } : {}) },
    select: {
      id: true,
      name: true,
      description: true,
      attrs: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { name: "asc" },
  });

  // Build tree for each site
  const result = [];

  for (const site of sites) {
    const workcenters = await buildSiteWorkcenterTree(site.id);

    // Get ungrouped stations (directly under site, no workcenter)
    const stations = await prisma.station.findMany({
      where: { siteId: site.id, workcenterId: null },
      select: {
        id: true,
        name: true,
        description: true,
        attrs: true,
      },
    });

    result.push({
      ...site,
      stations,
      workcenters,
    });
  }

  return result;
}

/**
 * Get device tree for a site (Gateway -> Datasources)
 * Returns all gateways with their assigned datasources (all statuses)
 */
export async function getDeviceTree(siteId: string, workspaceId?: string) {
  // Get site and validate access
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  // Get all gateways for this site with their datasources
  const gateways = await prisma.gateway.findMany({
    where: { siteId },
    select: {
      id: true,
      name: true,
      serialNumber: true,
      status: true,
      datasources: {
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          driver: true,
          driverVersion: true,
        },
        orderBy: { name: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  return { data: gateways };
}
