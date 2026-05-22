import prisma from "@rw/db";

// ============================================================================
// ItemDisposition CRUD
// ============================================================================

export interface CreateDispositionInput {
  name: string;
  siteId: string;
}

export interface UpdateDispositionInput {
  name?: string;
}

export interface ListDispositionsFilter {
  siteId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

export async function create(input: CreateDispositionInput) {
  const { name, siteId } = input;

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  const existing = await prisma.itemDisposition.findUnique({
    where: { siteId_name: { siteId, name } },
    select: { id: true, deletedAt: true },
  });

  if (existing && !existing.deletedAt) {
    return { error: "A disposition with this name already exists for this site", code: "DUPLICATE_NAME" };
  }

  const disposition = await prisma.itemDisposition.create({
    data: { name, siteId },
    include: {
      _count: { select: { itemDispositionReasons: true } },
    },
  });

  return { data: disposition };
}

export async function list(filter: ListDispositionsFilter = {}) {
  const { siteId, name, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = { deletedAt: null };

  if (siteId) {
    where.siteId = siteId;
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  const [dispositions, total] = await Promise.all([
    prisma.itemDisposition.findMany({
      where,
      include: {
        _count: { select: { itemDispositionReasons: true } },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.itemDisposition.count({ where }),
  ]);

  return {
    data: dispositions,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

export async function getById(id: string) {
  const disposition = await prisma.itemDisposition.findUnique({
    where: { id },
    include: {
      itemDispositionReasons: {
        where: { deletedAt: null },
        select: { id: true, name: true, processTypeId: true },
        orderBy: { name: "asc" },
      },
      _count: { select: { itemDispositionReasons: true } },
    },
  });

  if (!disposition || disposition.deletedAt) {
    return null;
  }

  return { data: disposition };
}

export async function update(id: string, input: UpdateDispositionInput) {
  const { name } = input;

  const current = await prisma.itemDisposition.findUnique({
    where: { id },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!current || current.deletedAt) {
    return { error: "Disposition not found", code: "DISPOSITION_NOT_FOUND" };
  }

  if (name !== undefined) {
    const existing = await prisma.itemDisposition.findUnique({
      where: { siteId_name: { siteId: current.siteId, name } },
      select: { id: true, deletedAt: true },
    });

    if (existing && existing.id !== id && !existing.deletedAt) {
      return { error: "A disposition with this name already exists for this site", code: "DUPLICATE_NAME" };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;

  const disposition = await prisma.itemDisposition.update({
    where: { id },
    data: updateData,
    include: {
      _count: { select: { itemDispositionReasons: true } },
    },
  });

  return { data: disposition };
}

export async function remove(id: string) {
  const disposition = await prisma.itemDisposition.findUnique({
    where: { id },
    include: {
      _count: { select: { itemDispositionReasons: true, itemDispositionLogs: true } },
    },
  });

  if (!disposition || disposition.deletedAt) {
    return { error: "Disposition not found", code: "DISPOSITION_NOT_FOUND" };
  }

  if (disposition._count.itemDispositionLogs > 0) {
    return {
      error: "Cannot delete disposition that is referenced by disposition logs",
      code: "HAS_LOGS",
    };
  }

  if (disposition._count.itemDispositionReasons > 0) {
    return {
      error: "Cannot delete disposition with reasons. Remove or reassign reasons first.",
      code: "HAS_REASONS",
    };
  }

  await prisma.itemDisposition.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}
