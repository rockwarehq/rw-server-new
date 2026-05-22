import prisma from "@rw/db";

// ============================================================================
// Types
// ============================================================================

export interface CreateDashboardInput {
  siteId: string;
  name: string;
  description?: string;
  spec?: Record<string, unknown>;
  state?: Record<string, unknown>;
  attrs?: Record<string, unknown>;
}

export interface UpdateDashboardInput {
  name?: string;
  description?: string;
  spec?: Record<string, unknown>;
  state?: Record<string, unknown>;
  attrs?: Record<string, unknown>;
}

export interface ListDashboardsFilter {
  siteId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Create a new dashboard
 */
export async function create(input: CreateDashboardInput, workspaceId: string) {
  const { siteId, name, description, spec, state, attrs } = input;

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  if (site.workspaceId !== workspaceId) {
    return { error: "Site does not belong to this workspace", code: "WORKSPACE_MISMATCH" };
  }

  const dashboard = await prisma.dashboard.create({
    data: {
      siteId,
      name,
      description: description ?? null,
      spec: spec ?? {},
      state: state ?? {},
      attrs: attrs ?? {},
    },
    include: {
      site: { select: { id: true, name: true } },
      _count: { select: { displays: true } },
    },
  });

  return { data: dashboard };
}

/**
 * List dashboards with optional filtering
 */
export async function list(filter: ListDashboardsFilter = {}, workspaceId?: string) {
  const { siteId, name, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = {
    deletedAt: null,
  };

  if (workspaceId) {
    where.site = {
      workspaceId,
    };
  }

  if (siteId) {
    where.siteId = siteId;
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  const [dashboards, total] = await Promise.all([
    prisma.dashboard.findMany({
      where,
      include: {
        site: { select: { id: true, name: true } },
        _count: { select: { displays: true } },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.dashboard.count({ where }),
  ]);

  return {
    data: dashboards,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get dashboard by ID
 */
export async function getById(id: string, workspaceId?: string) {
  const dashboard = await prisma.dashboard.findUnique({
    where: { id },
    include: {
      site: { select: { id: true, name: true, workspaceId: true } },
      _count: { select: { displays: true } },
    },
  });

  if (!dashboard) {
    return null;
  }

  if (dashboard.deletedAt) {
    return { error: "Dashboard has been deleted", code: "DASHBOARD_DELETED" };
  }

  if (workspaceId && dashboard.site.workspaceId !== workspaceId) {
    return { error: "Dashboard does not belong to this workspace", code: "WORKSPACE_MISMATCH" };
  }

  return {
    data: {
      ...dashboard,
      site: {
        id: dashboard.site.id,
        name: dashboard.site.name,
      },
    },
  };
}

/**
 * Update dashboard
 */
export async function update(id: string, input: UpdateDashboardInput, workspaceId: string) {
  const { name, description, spec, state, attrs } = input;

  const current = await prisma.dashboard.findUnique({
    where: { id },
    select: { id: true, deletedAt: true, siteId: true },
  });

  if (!current) {
    return { error: "Dashboard not found", code: "DASHBOARD_NOT_FOUND" };
  }

  if (current.deletedAt) {
    return { error: "Dashboard has been deleted", code: "DASHBOARD_DELETED" };
  }

  const site = await prisma.site.findUnique({
    where: { id: current.siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site || site.workspaceId !== workspaceId) {
    return { error: "Dashboard does not belong to this workspace", code: "WORKSPACE_MISMATCH" };
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (spec !== undefined) updateData.spec = spec;
  if (state !== undefined) updateData.state = state;
  if (attrs !== undefined) updateData.attrs = attrs;

  const dashboard = await prisma.dashboard.update({
    where: { id },
    data: updateData,
    include: {
      site: { select: { id: true, name: true } },
      _count: { select: { displays: true } },
    },
  });

  return { data: dashboard };
}

/**
 * Soft delete dashboard
 */
export async function remove(id: string, workspaceId: string) {
  const dashboard = await prisma.dashboard.findUnique({
    where: { id },
    include: {
      site: { select: { workspaceId: true } },
      _count: { select: { displays: true } },
    },
  });

  if (!dashboard) {
    return { error: "Dashboard not found", code: "DASHBOARD_NOT_FOUND" };
  }

  if (dashboard.deletedAt) {
    return { error: "Dashboard already deleted", code: "DASHBOARD_DELETED" };
  }

  if (dashboard.site.workspaceId !== workspaceId) {
    return { error: "Dashboard does not belong to this workspace", code: "WORKSPACE_MISMATCH" };
  }

  // Unassign any displays using this dashboard before deleting
  if (dashboard._count.displays > 0) {
    await prisma.display.updateMany({
      where: { dashboardId: id },
      data: { dashboardId: null },
    });
  }

  await prisma.dashboard.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}
