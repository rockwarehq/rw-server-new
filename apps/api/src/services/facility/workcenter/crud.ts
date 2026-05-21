import prisma from "@rw/db";

export interface CreateWorkcenterInput {
  name: string;
  description?: string;
  attrs?: Record<string, unknown>;
  siteId: string;
  parentId?: string;
}

export interface UpdateWorkcenterInput {
  name?: string;
  description?: string;
  attrs?: Record<string, unknown>;
}

export interface ListWorkcentersFilter {
  siteId?: string;
  siteIds?: string[];
  parentId?: string | null;
  name?: string;
  limit?: number;
  offset?: number;
}

/**
 * Create a new workcenter
 */
export async function create(input: CreateWorkcenterInput) {
  const { name, description, attrs, siteId, parentId } = input;

  // Validate site exists
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Validate parent exists and belongs to same site
  if (parentId) {
    const parent = await prisma.workcenter.findUnique({
      where: { id: parentId },
      select: { id: true, siteId: true },
    });

    if (!parent) {
      return { error: "Parent workcenter not found", code: "PARENT_NOT_FOUND" };
    }

    if (parent.siteId !== siteId) {
      return {
        error: "Parent workcenter must belong to the same site",
        code: "SITE_MISMATCH",
      };
    }
  }

  const workcenter = await prisma.workcenter.create({
    data: {
      name,
      description,
      attrs: attrs ?? {},
      siteId,
      parentId,
    },
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
      parent: {
        select: { id: true, name: true },
      },
      _count: {
        select: { children: true, stations: true },
      },
    },
  });

  return { data: workcenter };
}

/**
 * List workcenters with optional filtering
 */
export async function list(filter: ListWorkcentersFilter = {}) {
  const { siteId, siteIds, parentId, name, limit = 50, offset = 0 } = filter;

  if (siteIds && siteIds.length === 0) {
    return { data: [], total: 0, limit: Number(limit), offset: Number(offset) };
  }

  const where: Record<string, unknown> = {};

  if (siteId) {
    where.siteId = siteId;
  } else if (siteIds) {
    where.siteId = { in: siteIds };
  }

  // Filter by parent (null = top-level workcenters only)
  if (parentId === null) {
    where.parentId = null;
  } else if (parentId) {
    where.parentId = parentId;
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  const [workcenters, total] = await Promise.all([
    prisma.workcenter.findMany({
      where,
      include: {
        site: {
          select: { id: true, name: true, workspaceId: true },
        },
        parent: {
          select: { id: true, name: true },
        },
        _count: {
          select: { children: true, stations: true },
        },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.workcenter.count({ where }),
  ]);

  return {
    data: workcenters,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get workcenter by ID with related entities
 */
export async function getById(id: string, workspaceId?: string) {
  const workcenter = await prisma.workcenter.findUnique({
    where: { id },
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
      parent: {
        select: { id: true, name: true },
      },
      children: {
        select: {
          id: true,
          name: true,
          description: true,
          _count: { select: { children: true, stations: true } },
        },
        orderBy: { name: "asc" },
      },
      stations: {
        select: {
          id: true,
          name: true,
          description: true,
        },
        orderBy: { name: "asc" },
      },
      _count: {
        select: { children: true, stations: true },
      },
    },
  });

  if (!workcenter) {
    return null;
  }

  // Validate workspace access
  if (workspaceId && workcenter.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  return { data: workcenter };
}

/**
 * Update workcenter
 */
export async function update(id: string, input: UpdateWorkcenterInput, workspaceId?: string) {
  const { name, description, attrs } = input;

  // Get current workcenter with site info
  const current = await prisma.workcenter.findUnique({
    where: { id },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!current) {
    return { error: "Workcenter not found", code: "WORKCENTER_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && current.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (attrs !== undefined) updateData.attrs = attrs;

  const workcenter = await prisma.workcenter.update({
    where: { id },
    data: updateData,
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
      parent: {
        select: { id: true, name: true },
      },
      _count: {
        select: { children: true, stations: true },
      },
    },
  });

  return { data: workcenter };
}

/**
 * Move workcenter to a new parent (within same site)
 */
export async function move(id: string, newParentId: string | null, workspaceId?: string) {
  const current = await prisma.workcenter.findUnique({
    where: { id },
    include: {
      site: {
        select: { id: true, workspaceId: true },
      },
    },
  });

  if (!current) {
    return { error: "Workcenter not found", code: "WORKCENTER_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && current.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  // Validate new parent if provided
  if (newParentId) {
    // Cannot move to itself
    if (newParentId === id) {
      return {
        error: "Cannot move workcenter to itself",
        code: "CIRCULAR_REFERENCE",
      };
    }

    const newParent = await prisma.workcenter.findUnique({
      where: { id: newParentId },
      select: { id: true, siteId: true, parentId: true },
    });

    if (!newParent) {
      return {
        error: "New parent workcenter not found",
        code: "PARENT_NOT_FOUND",
      };
    }

    // Must be in same site
    if (newParent.siteId !== current.siteId) {
      return {
        error: "Cannot move workcenter to a different site",
        code: "SITE_MISMATCH",
      };
    }

    // Check for circular reference - ensure new parent is not a descendant
    let checkId: string | null = newParentId;
    while (checkId) {
      const ancestor: { parentId: string | null } | null = await prisma.workcenter.findUnique({
        where: { id: checkId },
        select: { parentId: true },
      });

      if (!ancestor) break;

      if (ancestor.parentId === id) {
        return {
          error: "Cannot move workcenter to its own descendant",
          code: "CIRCULAR_REFERENCE",
        };
      }

      checkId = ancestor.parentId;
    }
  }

  const workcenter = await prisma.workcenter.update({
    where: { id },
    data: { parentId: newParentId },
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
      parent: {
        select: { id: true, name: true },
      },
      _count: {
        select: { children: true, stations: true },
      },
    },
  });

  return { data: workcenter };
}

/**
 * Delete workcenter (fails if has children or stations due to onDelete: Restrict)
 */
export async function remove(id: string, workspaceId?: string) {
  const workcenter = await prisma.workcenter.findUnique({
    where: { id },
    include: {
      site: {
        select: { workspaceId: true },
      },
      _count: { select: { children: true, stations: true } },
    },
  });

  if (!workcenter) {
    return { error: "Workcenter not found", code: "WORKCENTER_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && workcenter.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  if (workcenter._count.children > 0) {
    return {
      error: "Cannot delete workcenter with children. Delete or move children first.",
      code: "HAS_CHILDREN",
    };
  }

  if (workcenter._count.stations > 0) {
    return {
      error: "Cannot delete workcenter with stations. Delete or move stations first.",
      code: "HAS_STATIONS",
    };
  }

  await prisma.workcenter.delete({ where: { id } });

  return { success: true };
}

/**
 * Check if workcenter exists
 */
export async function exists(id: string) {
  const workcenter = await prisma.workcenter.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!workcenter;
}
