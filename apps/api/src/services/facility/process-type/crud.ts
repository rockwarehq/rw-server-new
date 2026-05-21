import prisma from "@rw/db";

export interface CreateProcessTypeInput {
  name: string;
  description?: string;
  siteId: string;
}

export interface UpdateProcessTypeInput {
  name?: string;
  description?: string;
}

export interface ListProcessTypesFilter {
  siteId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

/**
 * Create a new process type
 */
export async function create(input: CreateProcessTypeInput) {
  const { name, description, siteId } = input;

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Check unique constraint
  const existing = await prisma.processType.findUnique({
    where: { siteId_name: { siteId, name } },
    select: { id: true, deletedAt: true },
  });

  if (existing && !existing.deletedAt) {
    return { error: "A process type with this name already exists for this site", code: "DUPLICATE_NAME" };
  }

  const processType = await prisma.processType.create({
    data: {
      name,
      description: description ?? null,
      siteId,
    },
  });

  return { data: processType };
}

/**
 * List process types with optional filtering
 */
export async function list(filter: ListProcessTypesFilter = {}) {
  const { siteId, name, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = { deletedAt: null };

  if (siteId) {
    where.siteId = siteId;
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  const [processTypes, total] = await Promise.all([
    prisma.processType.findMany({
      where,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.processType.count({ where }),
  ]);

  return {
    data: processTypes,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get process type by ID
 */
export async function getById(id: string) {
  const processType = await prisma.processType.findUnique({
    where: { id },
  });

  if (!processType || processType.deletedAt) {
    return null;
  }

  return { data: processType };
}

/**
 * Update process type
 */
export async function update(id: string, input: UpdateProcessTypeInput) {
  const { name, description } = input;

  const current = await prisma.processType.findUnique({
    where: { id },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!current || current.deletedAt) {
    return { error: "Process type not found", code: "PROCESS_TYPE_NOT_FOUND" };
  }

  // Check unique constraint if name is changing
  if (name !== undefined) {
    const existing = await prisma.processType.findUnique({
      where: { siteId_name: { siteId: current.siteId, name } },
      select: { id: true, deletedAt: true },
    });

    if (existing && existing.id !== id && !existing.deletedAt) {
      return { error: "A process type with this name already exists for this site", code: "DUPLICATE_NAME" };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;

  const processType = await prisma.processType.update({
    where: { id },
    data: updateData,
  });

  return { data: processType };
}

/**
 * Soft delete process type
 */
export async function remove(id: string) {
  const processType = await prisma.processType.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });

  if (!processType || processType.deletedAt) {
    return { error: "Process type not found", code: "PROCESS_TYPE_NOT_FOUND" };
  }

  await prisma.processType.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}
