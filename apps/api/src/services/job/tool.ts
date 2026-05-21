import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

// ============================================================================
// Types - Tool
// ============================================================================

export interface CreateToolInput {
  siteId: string;
  name: string;
  description?: string;
  cavityCount?: number;
  attrs?: Record<string, unknown>;
}

export interface UpdateToolInput {
  name?: string;
  description?: string;
  cavityCount?: number | null;
  attrs?: Record<string, unknown>;
}

export interface ListToolsFilter {
  siteId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Types - Cavity
// ============================================================================

export interface AddCavityInput {
  toolId: string;
  name: string;
  position?: number;
}

export interface UpdateCavityInput {
  name?: string;
  position?: number;
}

// ============================================================================
// Tool CRUD Operations
// ============================================================================

/**
 * Create a new tool with initial blob (version 1)
 */
export async function create(input: CreateToolInput) {
  const { siteId, name, description, cavityCount, attrs } = input;

  // Verify site exists
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Create tool and initial blob in transaction
  const tool = await prisma.$transaction(async (tx) => {
    // 1. Create Tool entity
    const t = await tx.tool.create({
      data: { siteId },
    });

    // 2. Create initial ToolBlob (version 1)
    const blob = await tx.toolBlob.create({
      data: {
        toolId: t.id,
        version: 1,
        name,
        description: description ?? null,
        cavityCount: cavityCount ?? null,
        attrs: attrs ?? {},
      },
    });

    // 3. Link blob as current and return
    return tx.tool.update({
      where: { id: t.id },
      data: { currentBlobId: blob.id },
      include: {
        currentBlob: true,
        site: { select: { id: true, name: true } },
        _count: { select: { toolCavities: true, jobs: true, blobs: true } },
      },
    });
  });

  return { data: tool };
}

/**
 * List tools with optional filtering
 */
export async function list(filter: ListToolsFilter = {}) {
  const { siteId, name, limit = 50, offset = 0 } = filter;

  const where: Prisma.ToolWhereInput = {
    deletedAt: null,
  };

  if (siteId) {
    where.siteId = siteId;
  }

  // Filter by current blob fields
  if (name) {
    where.currentBlob = {
      name: { contains: name, mode: "insensitive" },
    };
  }

  const [tools, total] = await Promise.all([
    prisma.tool.findMany({
      where,
      include: {
        currentBlob: true,
        site: { select: { id: true, name: true } },
        _count: { select: { toolCavities: true, jobs: true, blobs: true } },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.tool.count({ where }),
  ]);

  return {
    data: tools,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get tool by ID with current blob and cavities
 */
export async function getById(id: string) {
  const tool = await prisma.tool.findUnique({
    where: { id },
    include: {
      currentBlob: true,
      site: { select: { id: true, name: true } },
      toolCavities: {
        where: { deletedAt: null },
        include: {
          currentBlob: true,
        },
        orderBy: { createdAt: "asc" },
      },
      _count: { select: { toolCavities: true, jobs: true, blobs: true } },
    },
  });

  if (!tool) {
    return null;
  }

  if (tool.deletedAt) {
    return { error: "Tool has been deleted", code: "TOOL_DELETED" };
  }

  return { data: tool };
}

/**
 * Update tool (creates new blob version)
 */
export async function update(id: string, input: UpdateToolInput) {
  const { name, description, cavityCount, attrs } = input;

  // Get current tool with blob
  const current = await prisma.tool.findUnique({
    where: { id },
    include: { currentBlob: true },
  });

  if (!current) {
    return { error: "Tool not found", code: "TOOL_NOT_FOUND" };
  }

  if (current.deletedAt) {
    return { error: "Tool has been deleted", code: "TOOL_DELETED" };
  }

  if (!current.currentBlob) {
    return { error: "Tool has no current blob", code: "NO_CURRENT_BLOB" };
  }

  const currentBlob = current.currentBlob;

  // Get next version number
  const latestBlob = await prisma.toolBlob.findFirst({
    where: { toolId: id },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const nextVersion = (latestBlob?.version ?? 0) + 1;

  // Create new blob with merged data
  const tool = await prisma.$transaction(async (tx) => {
    const blob = await tx.toolBlob.create({
      data: {
        toolId: id,
        version: nextVersion,
        name: name ?? currentBlob.name,
        description: description !== undefined ? description : currentBlob.description,
        cavityCount: cavityCount !== undefined ? cavityCount : currentBlob.cavityCount,
        attrs: attrs !== undefined ? attrs : (currentBlob.attrs as Record<string, unknown>),
      },
    });

    return tx.tool.update({
      where: { id },
      data: { currentBlobId: blob.id },
      include: {
        currentBlob: true,
        site: { select: { id: true, name: true } },
        _count: { select: { toolCavities: true, jobs: true, blobs: true } },
      },
    });
  });

  return { data: tool };
}

/**
 * Soft delete tool (sets deletedAt)
 */
export async function remove(id: string) {
  const tool = await prisma.tool.findUnique({
    where: { id },
    include: {
      _count: { select: { jobs: true, jobProducts: true } },
    },
  });

  if (!tool) {
    return { error: "Tool not found", code: "TOOL_NOT_FOUND" };
  }

  if (tool.deletedAt) {
    return { error: "Tool already deleted", code: "TOOL_DELETED" };
  }

  if (tool._count.jobs > 0) {
    return {
      error: "Cannot delete tool that is linked to jobs. Remove from jobs first.",
      code: "HAS_JOBS",
    };
  }

  if (tool._count.jobProducts > 0) {
    return {
      error: "Cannot delete tool that is linked to job products. Remove from job products first.",
      code: "HAS_JOB_PRODUCTS",
    };
  }

  await prisma.tool.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}

/**
 * Check if tool exists
 */
export async function exists(id: string) {
  const tool = await prisma.tool.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  return tool !== null && tool.deletedAt === null;
}

// ============================================================================
// Cavity Operations
// ============================================================================

/**
 * Add a cavity to a tool
 */
export async function addCavity(input: AddCavityInput) {
  const { toolId, name, position } = input;

  // Verify tool exists and is not deleted
  const tool = await prisma.tool.findUnique({
    where: { id: toolId },
    select: { id: true, deletedAt: true },
  });

  if (!tool) {
    return { error: "Tool not found", code: "TOOL_NOT_FOUND" };
  }

  if (tool.deletedAt) {
    return { error: "Tool has been deleted", code: "TOOL_DELETED" };
  }

  // Create cavity and initial blob in transaction
  const cavity = await prisma.$transaction(async (tx) => {
    // 1. Create ToolCavity entity
    const c = await tx.toolCavity.create({
      data: { toolId },
    });

    // 2. Create initial ToolCavityBlob (version 1)
    const blob = await tx.toolCavityBlob.create({
      data: {
        toolCavityId: c.id,
        version: 1,
        name,
        position: position ?? null,
      },
    });

    // 3. Link blob as current and return
    return tx.toolCavity.update({
      where: { id: c.id },
      data: { currentBlobId: blob.id },
      include: {
        currentBlob: true,
      },
    });
  });

  return { data: cavity };
}

/**
 * Update a cavity (creates new blob version)
 */
export async function updateCavity(cavityId: string, input: UpdateCavityInput) {
  const { name, position } = input;

  // Get current cavity with blob
  const current = await prisma.toolCavity.findUnique({
    where: { id: cavityId },
    include: { currentBlob: true, tool: { select: { id: true, deletedAt: true } } },
  });

  if (!current) {
    return { error: "Cavity not found", code: "CAVITY_NOT_FOUND" };
  }

  if (current.deletedAt) {
    return { error: "Cavity has been deleted", code: "CAVITY_DELETED" };
  }

  if (current.tool.deletedAt) {
    return { error: "Tool has been deleted", code: "TOOL_DELETED" };
  }

  if (!current.currentBlob) {
    return { error: "Cavity has no current blob", code: "NO_CURRENT_BLOB" };
  }

  const currentBlob = current.currentBlob;

  // Get next version number
  const latestBlob = await prisma.toolCavityBlob.findFirst({
    where: { toolCavityId: cavityId },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const nextVersion = (latestBlob?.version ?? 0) + 1;

  // Create new blob with merged data
  const cavity = await prisma.$transaction(async (tx) => {
    const blob = await tx.toolCavityBlob.create({
      data: {
        toolCavityId: cavityId,
        version: nextVersion,
        name: name ?? currentBlob.name,
        position: position !== undefined ? position : currentBlob.position,
      },
    });

    return tx.toolCavity.update({
      where: { id: cavityId },
      data: { currentBlobId: blob.id },
      include: {
        currentBlob: true,
      },
    });
  });

  return { data: cavity };
}

/**
 * Soft delete a cavity
 */
export async function removeCavity(cavityId: string) {
  const cavity = await prisma.toolCavity.findUnique({
    where: { id: cavityId },
    include: {
      tool: { select: { id: true, deletedAt: true } },
      _count: { select: { jobProducts: true } },
    },
  });

  if (!cavity) {
    return { error: "Cavity not found", code: "CAVITY_NOT_FOUND" };
  }

  if (cavity.deletedAt) {
    return { error: "Cavity already deleted", code: "CAVITY_DELETED" };
  }

  if (cavity._count.jobProducts > 0) {
    return {
      error: "Cannot delete cavity that is linked to job products. Remove from job products first.",
      code: "HAS_JOB_PRODUCTS",
    };
  }

  await prisma.toolCavity.update({
    where: { id: cavityId },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}

/**
 * List cavities for a tool
 */
export async function listCavities(toolId: string) {
  // Verify tool exists
  const tool = await prisma.tool.findUnique({
    where: { id: toolId },
    select: { id: true, deletedAt: true },
  });

  if (!tool) {
    return { error: "Tool not found", code: "TOOL_NOT_FOUND" };
  }

  const cavities = await prisma.toolCavity.findMany({
    where: {
      toolId,
      deletedAt: null,
    },
    include: {
      currentBlob: true,
    },
    orderBy: [{ currentBlob: { position: "asc" } }, { createdAt: "asc" }],
  });

  return { data: cavities };
}
