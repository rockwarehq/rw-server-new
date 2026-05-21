import prisma from "@rw/db";

export interface CreateStatusCategoryInput {
  name: string;
  siteId: string;
}

export interface UpdateStatusCategoryInput {
  name?: string;
}

export interface ListStatusCategoriesFilter {
  siteId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

/**
 * Create a new status category
 */
export async function create(input: CreateStatusCategoryInput) {
  const { name, siteId } = input;

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Check unique constraint
  const existing = await prisma.statusCategory.findUnique({
    where: { siteId_name: { siteId, name } },
    select: { id: true, deletedAt: true },
  });

  if (existing && !existing.deletedAt) {
    return { error: "A status category with this name already exists for this site", code: "DUPLICATE_NAME" };
  }

  const category = await prisma.statusCategory.create({
    data: { name, siteId },
    include: {
      _count: { select: { statusReasons: true } },
    },
  });

  return { data: category };
}

/**
 * List status categories with optional filtering
 */
export async function list(filter: ListStatusCategoriesFilter = {}) {
  const { siteId, name, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = { deletedAt: null };

  if (siteId) {
    where.siteId = siteId;
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  const [categories, total] = await Promise.all([
    prisma.statusCategory.findMany({
      where,
      include: {
        _count: { select: { statusReasons: true } },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.statusCategory.count({ where }),
  ]);

  return {
    data: categories,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get status category by ID
 */
export async function getById(id: string) {
  const category = await prisma.statusCategory.findUnique({
    where: { id },
    include: {
      statusReasons: {
        where: { archivedAt: null },
        select: { id: true, name: true, isPlannedDown: true },
        orderBy: { name: "asc" },
      },
      _count: { select: { statusReasons: true } },
    },
  });

  if (!category || category.deletedAt) {
    return null;
  }

  return { data: category };
}

/**
 * Update status category
 */
export async function update(id: string, input: UpdateStatusCategoryInput) {
  const { name } = input;

  const current = await prisma.statusCategory.findUnique({
    where: { id },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!current || current.deletedAt) {
    return { error: "Status category not found", code: "STATUS_CATEGORY_NOT_FOUND" };
  }

  if (name !== undefined) {
    const existing = await prisma.statusCategory.findUnique({
      where: { siteId_name: { siteId: current.siteId, name } },
      select: { id: true, deletedAt: true },
    });

    if (existing && existing.id !== id && !existing.deletedAt) {
      return { error: "A status category with this name already exists for this site", code: "DUPLICATE_NAME" };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;

  const category = await prisma.statusCategory.update({
    where: { id },
    data: updateData,
    include: {
      _count: { select: { statusReasons: true } },
    },
  });

  return { data: category };
}

/**
 * Soft delete status category (fails if has status reasons)
 */
export async function remove(id: string) {
  const category = await prisma.statusCategory.findUnique({
    where: { id },
    include: {
      _count: { select: { statusReasons: true } },
    },
  });

  if (!category || category.deletedAt) {
    return { error: "Status category not found", code: "STATUS_CATEGORY_NOT_FOUND" };
  }

  if (category._count.statusReasons > 0) {
    return {
      error: "Cannot delete status category with status reasons. Remove or reassign reasons first.",
      code: "HAS_STATUS_REASONS",
    };
  }

  await prisma.statusCategory.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}
