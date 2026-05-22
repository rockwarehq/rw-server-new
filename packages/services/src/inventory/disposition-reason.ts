import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

export interface CreateDispositionReasonInput {
  name: string;
  siteId: string;
  itemDispositionIds?: string[];
  processTypeId?: string;
}

export interface UpdateDispositionReasonInput {
  name?: string;
  itemDispositionIds?: string[];
  processTypeId?: string | null;
}

export interface ListDispositionReasonsFilter {
  siteId?: string;
  itemDispositionId?: string;
  processTypeId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

async function validateDispositionLinks(itemDispositionIds: string[], siteId: string) {
  const uniqueIds = [...new Set(itemDispositionIds)];

  if (uniqueIds.length === 0) {
    return { data: [] };
  }

  const dispositions = await prisma.itemDisposition.findMany({
    where: { id: { in: uniqueIds }, deletedAt: null },
    select: { id: true, siteId: true },
  });

  if (dispositions.length !== uniqueIds.length) {
    return { error: "Disposition not found", code: "DISPOSITION_NOT_FOUND" };
  }

  if (dispositions.some((disposition) => disposition.siteId !== siteId)) {
    return { error: "Disposition must belong to the same site", code: "SITE_MISMATCH" };
  }

  return { data: uniqueIds };
}

export async function create(input: CreateDispositionReasonInput) {
  const { name, siteId, itemDispositionIds, processTypeId } = input;

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  const existing = await prisma.itemDispositionReason.findUnique({
    where: { siteId_name: { siteId, name } },
    select: { id: true, deletedAt: true },
  });

  if (existing && !existing.deletedAt) {
    return { error: "A disposition reason with this name already exists for this site", code: "DUPLICATE_NAME" };
  }

  const dispositionLinks = itemDispositionIds
    ? await validateDispositionLinks(itemDispositionIds, siteId)
    : { data: [] };
  if ("error" in dispositionLinks) {
    return dispositionLinks;
  }

  // Validate process type if provided
  if (processTypeId) {
    const processType = await prisma.processType.findUnique({
      where: { id: processTypeId },
      select: { id: true, siteId: true, deletedAt: true },
    });

    if (!processType || processType.deletedAt) {
      return { error: "Process type not found", code: "PROCESS_TYPE_NOT_FOUND" };
    }

    if (processType.siteId !== siteId) {
      return { error: "Process type must belong to the same site", code: "SITE_MISMATCH" };
    }
  }

  const reason = await prisma.itemDispositionReason.create({
    data: {
      name,
      siteId,
      itemDispositions:
        dispositionLinks.data.length > 0 ? { connect: dispositionLinks.data.map((id) => ({ id })) } : undefined,
      processTypeId: processTypeId ?? null,
    },
    include: {
      itemDispositions: { select: { id: true, name: true }, orderBy: { name: "asc" } },
      processType: { select: { id: true, name: true } },
    },
  });

  return { data: reason };
}

export async function list(filter: ListDispositionReasonsFilter = {}) {
  const { siteId, itemDispositionId, processTypeId, name, limit = 50, offset = 0 } = filter;

  const where: Prisma.ItemDispositionReasonWhereInput = { deletedAt: null };

  if (siteId) where.siteId = siteId;
  if (itemDispositionId) where.itemDispositions = { some: { id: itemDispositionId } };
  if (processTypeId) where.processTypeId = processTypeId;
  if (name) where.name = { contains: name, mode: "insensitive" };

  const [reasons, total] = await Promise.all([
    prisma.itemDispositionReason.findMany({
      where,
      include: {
        itemDispositions: { select: { id: true, name: true }, orderBy: { name: "asc" } },
        processType: { select: { id: true, name: true } },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.itemDispositionReason.count({ where }),
  ]);

  return {
    data: reasons,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

export async function getById(id: string) {
  const reason = await prisma.itemDispositionReason.findUnique({
    where: { id },
    include: {
      itemDispositions: { select: { id: true, name: true }, orderBy: { name: "asc" } },
      processType: { select: { id: true, name: true } },
    },
  });

  if (!reason || reason.deletedAt) {
    return null;
  }

  return { data: reason };
}

export async function update(id: string, input: UpdateDispositionReasonInput) {
  const { name, itemDispositionIds, processTypeId } = input;

  const current = await prisma.itemDispositionReason.findUnique({
    where: { id },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!current || current.deletedAt) {
    return { error: "Disposition reason not found", code: "DISPOSITION_REASON_NOT_FOUND" };
  }

  if (name !== undefined) {
    const existing = await prisma.itemDispositionReason.findUnique({
      where: { siteId_name: { siteId: current.siteId, name } },
      select: { id: true, deletedAt: true },
    });

    if (existing && existing.id !== id && !existing.deletedAt) {
      return { error: "A disposition reason with this name already exists for this site", code: "DUPLICATE_NAME" };
    }
  }

  const dispositionLinks =
    itemDispositionIds !== undefined ? await validateDispositionLinks(itemDispositionIds, current.siteId) : undefined;
  if (dispositionLinks && "error" in dispositionLinks) {
    return dispositionLinks;
  }

  if (processTypeId !== undefined && processTypeId !== null) {
    const processType = await prisma.processType.findUnique({
      where: { id: processTypeId },
      select: { id: true, siteId: true, deletedAt: true },
    });

    if (!processType || processType.deletedAt) {
      return { error: "Process type not found", code: "PROCESS_TYPE_NOT_FOUND" };
    }

    if (processType.siteId !== current.siteId) {
      return { error: "Process type must belong to the same site", code: "SITE_MISMATCH" };
    }
  }

  const updateData: Prisma.ItemDispositionReasonUpdateInput = {};
  if (name !== undefined) updateData.name = name;
  if (dispositionLinks) updateData.itemDispositions = { set: dispositionLinks.data.map((id) => ({ id })) };
  if (processTypeId !== undefined) {
    updateData.processType = processTypeId ? { connect: { id: processTypeId } } : { disconnect: true };
  }

  const reason = await prisma.itemDispositionReason.update({
    where: { id },
    data: updateData,
    include: {
      itemDispositions: { select: { id: true, name: true }, orderBy: { name: "asc" } },
      processType: { select: { id: true, name: true } },
    },
  });

  return { data: reason };
}

export async function remove(id: string) {
  const reason = await prisma.itemDispositionReason.findUnique({
    where: { id },
    include: {
      _count: { select: { itemDispositionLogs: true } },
    },
  });

  if (!reason || reason.deletedAt) {
    return { error: "Disposition reason not found", code: "DISPOSITION_REASON_NOT_FOUND" };
  }

  if (reason._count.itemDispositionLogs > 0) {
    return {
      error: "Cannot delete disposition reason that is referenced by disposition logs",
      code: "HAS_LOGS",
    };
  }

  await prisma.itemDispositionReason.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}
