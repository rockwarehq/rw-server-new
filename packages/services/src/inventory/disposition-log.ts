import prisma from "@rw/db";
import { updateDispositionBadItems } from "@rw/services/metrics/recalc";
import { deductScrap } from "@rw/services/order/allocation";

export interface CreateDispositionLogInput {
  siteId: string;
  stationId: string;
  workcenterId?: string;
  quantity?: number;
  itemDispositionId?: string;
  dispositionReasonId?: string;
  cycleId?: string;
  shiftInstanceId?: string;
  /** If not provided, blob IDs are auto-resolved from current station/job state */
  productBlobId: string;
  stationBlobId?: string;
  jobProductBlobId?: string;
  toolBlobId?: string;
  toolCavityBlobId?: string;
  productMaterialBlobIds?: string[];
}

export interface UpdateDispositionLogInput {
  quantity?: number;
  itemDispositionId?: string | null;
  dispositionReasonId?: string | null;
}

export interface ListDispositionLogsFilter {
  siteId?: string;
  stationId?: string;
  shiftInstanceId?: string;
  dispositionReasonId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

const logInclude = {
  station: { select: { id: true, name: true } },
  itemDisposition: { select: { id: true, name: true } },
  dispositionReason: {
    select: {
      id: true,
      name: true,
      processType: { select: { id: true, name: true } },
    },
  },
  productBlob: { select: { id: true, version: true, name: true, sku: true } },
  stationBlob: { select: { id: true, version: true } },
  toolBlob: { select: { id: true, version: true, name: true } },
  toolCavityBlob: { select: { id: true, version: true, name: true } },
  jobProductBlob: { select: { id: true, version: true } },
  productMaterialBlobs: {
    select: {
      id: true,
      version: true,
      weight: true,
      weightUnits: true,
      itemCost: true,
      materialBlob: {
        select: { id: true, version: true, name: true, materialNumber: true, shortCode: true },
      },
    },
  },
  shiftInstance: { select: { id: true, shiftName: true, businessDate: true, startTime: true, endTime: true } },
  cycle: { select: { id: true } },
};

// Extended include for list — resolves entity IDs from blobs for UI aggregation
const logListInclude = {
  ...logInclude,
  productBlob: { select: { id: true, version: true, name: true, sku: true, productId: true } },
  toolCavityBlob: { select: { id: true, version: true, name: true, toolCavityId: true } },
  jobProductBlob: { select: { id: true, version: true, jobProduct: { select: { jobId: true } } } },
};

export interface RecordDispositionLogInput {
  siteId: string;
  stationId: string;
  workcenterId?: string;
  productId: string;
  jobId?: string;
  toolCavityId?: string;
  quantity?: number;
  itemDispositionId?: string;
  dispositionReasonId?: string;
  cycleId?: string;
  shiftInstanceId?: string;
}

async function validateDispositionReasonPair(
  siteId: string,
  itemDispositionId: string | null | undefined,
  dispositionReasonId: string | null | undefined,
) {
  if (!itemDispositionId && !dispositionReasonId) {
    return { data: { itemDispositionId: null, dispositionReasonId: null } };
  }

  if (!itemDispositionId || !dispositionReasonId) {
    return {
      error: "Disposition and disposition reason are required together",
      code: "DISPOSITION_PAIR_REQUIRED",
    };
  }

  const disposition = await prisma.itemDisposition.findUnique({
    where: { id: itemDispositionId },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!disposition || disposition.deletedAt) {
    return { error: "Disposition not found", code: "DISPOSITION_NOT_FOUND" };
  }

  if (disposition.siteId !== siteId) {
    return { error: "Disposition must belong to the same site", code: "SITE_MISMATCH" };
  }

  const reason = await prisma.itemDispositionReason.findUnique({
    where: { id: dispositionReasonId },
    select: {
      id: true,
      siteId: true,
      deletedAt: true,
      itemDispositions: {
        where: { id: itemDispositionId },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!reason || reason.deletedAt) {
    return { error: "Disposition reason not found", code: "DISPOSITION_REASON_NOT_FOUND" };
  }

  if (reason.siteId !== siteId) {
    return { error: "Disposition reason must belong to the same site", code: "SITE_MISMATCH" };
  }

  if (reason.itemDispositions.length === 0) {
    return {
      error: "Disposition reason is not linked to this disposition",
      code: "DISPOSITION_REASON_NOT_LINKED",
    };
  }

  return { data: { itemDispositionId, dispositionReasonId } };
}

/**
 * Create a disposition log entry from entity IDs, auto-resolving
 * the current blob snapshots for station, product, jobProduct,
 * tool, and toolCavity.
 */
export async function record(input: RecordDispositionLogInput) {
  const { siteId, stationId, productId, jobId, toolCavityId, ...passthrough } = input;

  // Resolve station → stationBlobId
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { id: true, siteId: true, currentBlobId: true },
  });

  if (!station) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }
  if (station.siteId !== siteId) {
    return { error: "Station must belong to the specified site", code: "SITE_MISMATCH" };
  }

  // Resolve product → productBlobId and product material blob IDs
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      currentBlobId: true,
      deletedAt: true,
      materials: {
        select: { currentBlobId: true },
      },
    },
  });

  if (!product || product.deletedAt) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }
  if (!product.currentBlobId) {
    return { error: "Product has no current blob version", code: "NO_CURRENT_BLOB" };
  }

  // Resolve jobProduct → jobProductBlobId (if jobId provided)
  let jobProductBlobId: string | undefined;
  if (jobId) {
    const jobProduct = await prisma.jobProduct.findFirst({
      where: { jobId, productId, deletedAt: null },
      select: { currentBlobId: true },
    });

    if (!jobProduct) {
      return { error: "JobProduct not found for given job and product", code: "JOB_PRODUCT_NOT_FOUND" };
    }
    if (!jobProduct.currentBlobId) {
      return { error: "JobProduct has no current blob version", code: "NO_CURRENT_BLOB" };
    }
    jobProductBlobId = jobProduct.currentBlobId;
  }

  // Resolve toolCavity → toolCavityBlobId + toolBlobId (if provided)
  let toolCavityBlobId: string | undefined;
  let toolBlobId: string | undefined;
  if (toolCavityId) {
    const toolCavity = await prisma.toolCavity.findUnique({
      where: { id: toolCavityId },
      select: {
        currentBlobId: true,
        deletedAt: true,
        tool: { select: { currentBlobId: true } },
      },
    });

    if (!toolCavity || toolCavity.deletedAt) {
      return { error: "Tool cavity not found", code: "TOOL_CAVITY_NOT_FOUND" };
    }
    if (!toolCavity.currentBlobId) {
      return { error: "Tool cavity has no current blob version", code: "NO_CURRENT_BLOB" };
    }
    toolCavityBlobId = toolCavity.currentBlobId;
    toolBlobId = toolCavity.tool.currentBlobId ?? undefined;
  }

  // Resolve product material blob IDs
  const productMaterialBlobIds = product.materials
    .map((pm) => pm.currentBlobId)
    .filter((id): id is string => id != null);

  const result = await create({
    siteId,
    stationId,
    productBlobId: product.currentBlobId,
    stationBlobId: station.currentBlobId ?? undefined,
    jobProductBlobId,
    toolBlobId,
    toolCavityBlobId,
    productMaterialBlobIds,
    ...passthrough,
  });

  // Order deduction is handled inside create() (via the resolved productBlob),
  // so we must not call deductScrap again here or scrap would be double-counted
  // against the order line item.
  return result;
}

export async function create(input: CreateDispositionLogInput) {
  const {
    siteId,
    stationId,
    workcenterId,
    quantity,
    itemDispositionId,
    dispositionReasonId,
    cycleId,
    shiftInstanceId,
    productBlobId,
    stationBlobId,
    jobProductBlobId,
    toolBlobId,
    toolCavityBlobId,
    productMaterialBlobIds,
  } = input;

  // Validate station exists and belongs to site
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { id: true, siteId: true },
  });

  if (!station) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  if (station.siteId !== siteId) {
    return { error: "Station must belong to the specified site", code: "SITE_MISMATCH" };
  }

  const dispositionPair = await validateDispositionReasonPair(siteId, itemDispositionId, dispositionReasonId);
  if ("error" in dispositionPair) {
    return dispositionPair;
  }

  // Validate productBlob exists and resolve productId for order deduction
  const productBlob = await prisma.productBlob.findUnique({
    where: { id: productBlobId },
    select: { id: true, productId: true },
  });

  if (!productBlob) {
    return { error: "Product blob not found", code: "PRODUCT_BLOB_NOT_FOUND" };
  }

  const log = await prisma.itemDispositionLog.create({
    data: {
      siteId,
      stationId,
      workcenterId: workcenterId ?? null,
      quantity: quantity ?? 1,
      itemDispositionId: dispositionPair.data.itemDispositionId,
      dispositionReasonId: dispositionPair.data.dispositionReasonId,
      cycleId: cycleId ?? null,
      shiftInstanceId: shiftInstanceId ?? null,
      productBlobId,
      stationBlobId: stationBlobId ?? null,
      jobProductBlobId: jobProductBlobId ?? null,
      toolBlobId: toolBlobId ?? null,
      toolCavityBlobId: toolCavityBlobId ?? null,
      productMaterialBlobs:
        productMaterialBlobIds && productMaterialBlobIds.length > 0
          ? { connect: productMaterialBlobIds.map((id) => ({ id })) }
          : undefined,
    },
    include: logInclude,
  });

  // Trigger metric recalculation for badItems
  updateDispositionBadItems(stationId, siteId, log.createdAt, quantity ?? 1).catch((err) => {
    console.error(`[disposition-log] Failed to update badItems metrics for station ${stationId}:`, err);
  });

  // Deduct from the highest-priority order for this product
  if (productBlob?.productId) {
    deductScrap(siteId, productBlob.productId, quantity ?? 1).catch((err) => {
      console.error(`[disposition-log] Failed to deduct from order for product ${productBlob.productId}:`, err);
    });
  }

  return { data: log };
}

export async function list(filter: ListDispositionLogsFilter = {}) {
  const {
    siteId,
    stationId,
    shiftInstanceId,
    dispositionReasonId,
    startDate,
    endDate,
    limit = 50,
    offset = 0,
  } = filter;

  const where: Record<string, unknown> = { deletedAt: null };

  if (siteId) where.siteId = siteId;
  if (stationId) where.stationId = stationId;
  if (shiftInstanceId) where.shiftInstanceId = shiftInstanceId;
  if (dispositionReasonId) where.dispositionReasonId = dispositionReasonId;

  if (startDate || endDate) {
    const createdAt: Record<string, unknown> = {};
    if (startDate) createdAt.gte = startDate;
    if (endDate) createdAt.lte = endDate;
    where.createdAt = createdAt;
  }

  const [logs, total] = await Promise.all([
    prisma.itemDispositionLog.findMany({
      where,
      include: logListInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.itemDispositionLog.count({ where }),
  ]);

  return {
    data: logs,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

export async function getById(id: string) {
  const log = await prisma.itemDispositionLog.findUnique({
    where: { id },
    include: logInclude,
  });

  if (!log || log.deletedAt) {
    return null;
  }

  return { data: log };
}

export async function update(id: string, input: UpdateDispositionLogInput) {
  const { quantity, itemDispositionId, dispositionReasonId } = input;

  const current = await prisma.itemDispositionLog.findUnique({
    where: { id },
    select: {
      id: true,
      siteId: true,
      stationId: true,
      deletedAt: true,
      quantity: true,
      itemDispositionId: true,
      dispositionReasonId: true,
    },
  });

  if (!current || current.deletedAt) {
    return { error: "Disposition log not found", code: "DISPOSITION_LOG_NOT_FOUND" };
  }

  const nextItemDispositionId = itemDispositionId !== undefined ? itemDispositionId : current.itemDispositionId;
  const nextDispositionReasonId = dispositionReasonId !== undefined ? dispositionReasonId : current.dispositionReasonId;
  const dispositionPair = await validateDispositionReasonPair(
    current.siteId,
    nextItemDispositionId,
    nextDispositionReasonId,
  );
  if ("error" in dispositionPair) {
    return dispositionPair;
  }

  const updateData: Record<string, unknown> = {};
  if (quantity !== undefined) updateData.quantity = quantity;
  if (itemDispositionId !== undefined) updateData.itemDispositionId = itemDispositionId;
  if (dispositionReasonId !== undefined) updateData.dispositionReasonId = dispositionReasonId;

  const log = await prisma.itemDispositionLog.update({
    where: { id },
    data: updateData,
    include: logInclude,
  });

  // If quantity changed, trigger metric recalc with delta
  if (quantity !== undefined && quantity !== current.quantity) {
    const delta = quantity - current.quantity;
    updateDispositionBadItems(current.stationId, current.siteId, log.createdAt, delta).catch((err) => {
      console.error(`[disposition-log] Failed to update badItems metrics for station ${current.stationId}:`, err);
    });
  }

  return { data: log };
}

export async function remove(id: string) {
  const log = await prisma.itemDispositionLog.findUnique({
    where: { id },
    select: { id: true, stationId: true, siteId: true, quantity: true, deletedAt: true, createdAt: true },
  });

  if (!log || log.deletedAt) {
    return { error: "Disposition log not found", code: "DISPOSITION_LOG_NOT_FOUND" };
  }

  await prisma.itemDispositionLog.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  // Subtract the removed quantity from metrics
  updateDispositionBadItems(log.stationId, log.siteId, log.createdAt, -log.quantity).catch((err) => {
    console.error(`[disposition-log] Failed to update badItems metrics for station ${log.stationId}:`, err);
  });

  return { success: true };
}
