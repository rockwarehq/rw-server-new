import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

// ============================================================================
// Types
// ============================================================================

type OrderStatus = "DRAFT" | "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "COMPLETED" | "CANCELLED";

const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ["OPEN", "CANCELLED"],
  OPEN: ["COMPLETED", "ON_HOLD", "CANCELLED"],
  IN_PROGRESS: ["ON_HOLD", "COMPLETED", "CANCELLED"],
  ON_HOLD: ["OPEN", "IN_PROGRESS", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export interface CreateOrderInput {
  siteId: string;
  orderNumber: string;
  status?: "DRAFT" | "OPEN";
  customerId?: string;
  poNumber?: string;
  startDate?: Date;
  dueDate?: Date;
  priority?: number;
  defaultTargetQuantity?: number;
  notes?: string;
  lineItems?: { productId: string; targetQuantity: number }[];
}

export interface UpdateOrderInput {
  orderNumber?: string;
  customerId?: string | null;
  poNumber?: string | null;
  startDate?: Date | null;
  dueDate?: Date | null;
  priority?: number;
  defaultTargetQuantity?: number;
  notes?: string | null;
}

export interface ListOrdersFilter {
  siteId?: string;
  status?: OrderStatus | OrderStatus[];
  customerId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Shared includes
// ============================================================================

const orderInclude = {
  customer: { select: { id: true, name: true } },
  lineItems: {
    include: {
      product: {
        select: {
          id: true,
          currentBlob: { select: { sku: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
};

// ============================================================================
// Helpers
// ============================================================================

const ORDER_NUMBER_RE = /^(.*?)(\d+)$/;

function parseOrderNumber(orderNumber: string): { prefix: string; number: number; width: number } | null {
  const match = orderNumber.match(ORDER_NUMBER_RE);
  if (!match) return null;
  const digits = match[2];
  return { prefix: match[1], number: parseInt(digits, 10), width: digits.length };
}

// ============================================================================
// Next Order Number
// ============================================================================

const DEFAULT_ORDER_PREFIX = "SO-";
const DEFAULT_ORDER_WIDTH = 3;

export async function getNextOrderNumber(siteId: string) {
  // Include soft-deleted orders so we never hand out a number that collides
  // with the DB unique constraint (which doesn't respect deletedAt).
  const orders = await prisma.order.findMany({
    where: { siteId },
    select: { orderNumber: true, createdAt: true, deletedAt: true },
    orderBy: { createdAt: "desc" },
  });

  // Prefix follows the most recent live order so soft-deleted history
  // doesn't resurrect an abandoned naming scheme.
  let prefix = DEFAULT_ORDER_PREFIX;
  let width = DEFAULT_ORDER_WIDTH;

  for (const o of orders) {
    if (o.deletedAt) continue;
    const parsed = parseOrderNumber(o.orderNumber);
    if (parsed) {
      prefix = parsed.prefix;
      break;
    }
  }

  // Max number scans live + soft-deleted so we can't reissue a tombstoned number
  let maxNum = 0;
  for (const o of orders) {
    const parsed = parseOrderNumber(o.orderNumber);
    if (parsed && parsed.prefix === prefix) {
      if (parsed.number > maxNum) {
        maxNum = parsed.number;
        width = parsed.width;
      }
    }
  }

  const nextNum = maxNum + 1;
  const padded = String(nextNum).padStart(width, "0");
  return { orderNumber: `${prefix}${padded}` };
}

// ============================================================================
// CRUD
// ============================================================================

export async function create(input: CreateOrderInput) {
  const { siteId, orderNumber, status = "DRAFT", customerId, lineItems, ...rest } = input;

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, attrs: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  const existing = await prisma.order.findUnique({
    where: { siteId_orderNumber: { siteId, orderNumber } },
    select: { id: true, deletedAt: true },
  });

  if (existing) {
    const message = existing.deletedAt
      ? "This order number was previously used and cannot be reused"
      : "An order with this number already exists";
    return { error: message, code: "DUPLICATE_ORDER_NUMBER" };
  }

  if (customerId) {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, deletedAt: true },
    });
    if (!customer || customer.deletedAt) {
      return { error: "Customer not found", code: "CUSTOMER_NOT_FOUND" };
    }
  }

  // Check for duplicate products in line items
  if (lineItems && lineItems.length > 0) {
    const productIds = new Set<string>();
    for (const li of lineItems) {
      if (productIds.has(li.productId)) {
        return { error: "Duplicate product in line items", code: "DUPLICATE_PRODUCT" };
      }
      productIds.add(li.productId);
    }
  }

  // Assign sequence when creating as OPEN
  let sequence: number | null = null;
  if (status === "OPEN") {
    const maxSeq = await prisma.order.aggregate({
      where: { siteId, deletedAt: null },
      _max: { sequence: true },
    });
    sequence = (maxSeq._max.sequence ?? 0) + 1;
  }

  const order = await prisma.order.create({
    data: {
      siteId,
      orderNumber,
      status,
      sequence,
      customerId: customerId ?? null,
      ...rest,
      lineItems:
        lineItems && lineItems.length > 0
          ? {
              create: lineItems.map((li) => ({
                productId: li.productId,
                targetQuantity: li.targetQuantity,
              })),
            }
          : undefined,
    },
    include: orderInclude,
  });

  return { data: order };
}

export async function list(filter: ListOrdersFilter = {}) {
  const { siteId, status, customerId, search, limit = 200, offset = 0 } = filter;

  const where: Prisma.OrderWhereInput = { deletedAt: null };

  if (siteId) {
    where.siteId = siteId;
  }

  if (status) {
    if (Array.isArray(status)) {
      where.status = { in: status };
    } else {
      where.status = status;
    }
  }

  if (customerId) {
    where.customerId = customerId;
  }

  if (search) {
    where.OR = [
      { orderNumber: { contains: search, mode: "insensitive" } },
      { customer: { name: { contains: search, mode: "insensitive" } } },
      { poNumber: { contains: search, mode: "insensitive" } },
    ];
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: orderInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: [{ sequence: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    }),
    prisma.order.count({ where }),
  ]);

  return { data: orders, total, limit: Number(limit), offset: Number(offset) };
}

export async function get(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: orderInclude,
  });

  if (!order || order.deletedAt) {
    return { error: "Order not found", code: "ORDER_NOT_FOUND" };
  }

  return { data: order };
}

export async function update(id: string, input: UpdateOrderInput) {
  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, siteId: true, status: true, deletedAt: true },
  });

  if (!order || order.deletedAt) {
    return { error: "Order not found", code: "ORDER_NOT_FOUND" };
  }

  // Terminal statuses: no edits at all
  if (order.status === "COMPLETED" || order.status === "CANCELLED") {
    return { error: "Cannot edit completed or cancelled orders", code: "NOT_EDITABLE" };
  }

  // Check if order has any allocations
  const allocationCount = await prisma.orderInventoryAllocation.count({
    where: { orderLineItem: { orderId: id } },
  });
  const hasAllocations = allocationCount > 0;

  if (hasAllocations) {
    // Only notes can be updated when order has allocations
    input = { notes: input.notes };
  } else if (order.status !== "DRAFT" && order.status !== "OPEN") {
    return { error: "Can only edit orders in DRAFT or OPEN status", code: "NOT_EDITABLE" };
  }

  if (input.orderNumber) {
    const existing = await prisma.order.findUnique({
      where: { siteId_orderNumber: { siteId: order.siteId, orderNumber: input.orderNumber } },
      select: { id: true, deletedAt: true },
    });
    if (existing && !existing.deletedAt && existing.id !== id) {
      return { error: "An order with this number already exists", code: "DUPLICATE_ORDER_NUMBER" };
    }
  }

  const updated = await prisma.order.update({
    where: { id },
    data: input,
    include: orderInclude,
  });

  return { data: updated };
}

export async function remove(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, status: true, deletedAt: true },
  });

  if (!order || order.deletedAt) {
    return { error: "Order not found", code: "ORDER_NOT_FOUND" };
  }

  if (order.status !== "DRAFT" && order.status !== "CANCELLED") {
    return { error: "Can only delete orders in DRAFT or CANCELLED status", code: "NOT_DELETABLE" };
  }

  await prisma.order.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}

// ============================================================================
// Status Transitions
// ============================================================================

export async function transitionStatus(id: string, targetStatus: OrderStatus) {
  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, siteId: true, status: true, previousStatus: true, deletedAt: true, sequence: true },
  });

  if (!order || order.deletedAt) {
    return { error: "Order not found", code: "ORDER_NOT_FOUND" };
  }

  const currentStatus = order.status as OrderStatus;
  const allowed = STATUS_TRANSITIONS[currentStatus] ?? [];

  if (!allowed.includes(targetStatus)) {
    return {
      error: `Cannot transition from ${currentStatus} to ${targetStatus}`,
      code: "INVALID_TRANSITION",
    };
  }

  const updateData: Record<string, unknown> = { status: targetStatus };

  // Store previous status when entering ON_HOLD
  if (targetStatus === "ON_HOLD") {
    updateData.previousStatus = currentStatus;
  }

  // Restore previous status when leaving ON_HOLD
  if (currentStatus === "ON_HOLD" && (targetStatus === "OPEN" || targetStatus === "IN_PROGRESS")) {
    updateData.previousStatus = null;
  }

  // Assign sequence when transitioning to OPEN (if not already set)
  if (targetStatus === "OPEN" && order.sequence == null) {
    const maxSeq = await prisma.order.aggregate({
      where: { siteId: order.siteId, deletedAt: null },
      _max: { sequence: true },
    });
    updateData.sequence = (maxSeq._max.sequence ?? 0) + 1;
  }

  const updated = await prisma.order.update({
    where: { id },
    data: updateData,
    include: orderInclude,
  });

  return { data: updated };
}

// ============================================================================
// Line Items
// ============================================================================

export async function addLineItem(orderId: string, input: { productId: string; targetQuantity: number }) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, deletedAt: true },
  });

  if (!order || order.deletedAt) {
    return { error: "Order not found", code: "ORDER_NOT_FOUND" };
  }

  const allocationCount = await prisma.orderInventoryAllocation.count({
    where: { orderLineItem: { orderId } },
  });
  if (allocationCount > 0) {
    return { error: "Cannot modify line items on an order with allocations", code: "HAS_ALLOCATIONS" };
  }

  const existing = await prisma.orderLineItem.findUnique({
    where: { orderId_productId: { orderId, productId: input.productId } },
    select: { id: true },
  });

  if (existing) {
    return { error: "This product is already on the order", code: "DUPLICATE_PRODUCT" };
  }

  const lineItem = await prisma.orderLineItem.create({
    data: {
      orderId,
      productId: input.productId,
      targetQuantity: input.targetQuantity,
    },
    include: {
      product: {
        select: {
          id: true,
          currentBlob: { select: { sku: true, name: true } },
        },
      },
    },
  });

  return { data: lineItem };
}

export async function updateLineItem(lineItemId: string, input: { targetQuantity?: number }) {
  const lineItem = await prisma.orderLineItem.findUnique({
    where: { id: lineItemId },
    select: { id: true, orderId: true },
  });

  if (!lineItem) {
    return { error: "Line item not found", code: "LINE_ITEM_NOT_FOUND" };
  }

  const allocationCount = await prisma.orderInventoryAllocation.count({
    where: { orderLineItem: { orderId: lineItem.orderId } },
  });
  if (allocationCount > 0) {
    return { error: "Cannot modify line items on an order with allocations", code: "HAS_ALLOCATIONS" };
  }

  const updated = await prisma.orderLineItem.update({
    where: { id: lineItemId },
    data: input,
    include: {
      product: {
        select: {
          id: true,
          currentBlob: { select: { sku: true, name: true } },
        },
      },
    },
  });

  return { data: updated };
}

export async function removeLineItem(lineItemId: string) {
  const lineItem = await prisma.orderLineItem.findUnique({
    where: { id: lineItemId },
    select: { id: true, orderId: true },
  });

  if (!lineItem) {
    return { error: "Line item not found", code: "LINE_ITEM_NOT_FOUND" };
  }

  const allocationCount = await prisma.orderInventoryAllocation.count({
    where: { orderLineItem: { orderId: lineItem.orderId } },
  });
  if (allocationCount > 0) {
    return { error: "Cannot modify line items on an order with allocations", code: "HAS_ALLOCATIONS" };
  }

  await prisma.orderLineItem.delete({
    where: { id: lineItemId },
  });

  return { success: true };
}

// ============================================================================
// Reorder (drag-and-drop sequence)
// ============================================================================

export async function reorder(_siteId: string, orderedIds: string[]) {
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.order.update({
        where: { id },
        data: { sequence: index + 1 },
      }),
    ),
  );

  return { success: true };
}
