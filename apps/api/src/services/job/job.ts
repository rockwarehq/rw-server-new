import prisma from "@rw/db";
import type { Prisma } from "@rw/db";

// ============================================================================
// Types - Job
// ============================================================================

export interface CreateJobInput {
  siteId: string;
  name: string;
  description?: string;
  standardCycle?: number;
  productsPerCycle?: number;
  attrs?: Record<string, unknown>;
}

export interface UpdateJobInput {
  name?: string;
  description?: string;
  standardCycle?: number;
  productsPerCycle?: number;
  attrs?: Record<string, unknown>;
}

export interface ListJobsFilter {
  siteId?: string;
  /** Free-text search across name and description (case-insensitive contains, OR) */
  q?: string;
  name?: string;
  /** Only return jobs that have at least one JobProduct with a matching productId */
  productIds?: string[];
  view?: "full" | "slim";
  limit?: number;
  offset?: number;
}

// ============================================================================
// Types - JobTool
// ============================================================================

export interface AddToolInput {
  jobId: string;
  toolId: string;
}

// ============================================================================
// Types - JobProduct
// ============================================================================

export interface AddItemInput {
  jobId: string;
  productId: string;
  toolId?: string;
  toolCavityId?: string;
  quantity?: number;
}

export interface UpdateItemInput {
  isActive?: boolean;
  toolId?: string | null;
  toolCavityId?: string | null;
  quantity?: number;
}

// ============================================================================
// Job CRUD Operations
// ============================================================================

/**
 * Create a new job with initial blob (version 1)
 */
export async function create(input: CreateJobInput) {
  const { siteId, name, description, standardCycle, productsPerCycle, attrs } = input;

  // Verify site exists
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Create job and initial blob in transaction
  const job = await prisma.$transaction(async (tx) => {
    // 1. Create Job entity
    const j = await tx.job.create({
      data: { siteId },
    });

    // 2. Create initial JobBlob (version 1)
    const blob = await tx.jobBlob.create({
      data: {
        jobId: j.id,
        version: 1,
        name,
        description: description ?? null,
        standardCycle: standardCycle ?? null,
        productsPerCycle: productsPerCycle ?? 1,
        attrs: attrs ?? {},
      },
    });

    // 3. Link blob as current and return
    return tx.job.update({
      where: { id: j.id },
      data: { currentBlobId: blob.id },
      include: {
        currentBlob: true,
        site: { select: { id: true, name: true } },
        _count: { select: { tools: true, jobProducts: true, orders: true, blobs: true } },
      },
    });
  });

  return { data: job };
}

/**
 * List jobs with optional filtering
 */
export async function list(filter: ListJobsFilter = {}) {
  const { siteId, q, name, productIds, view = "full", limit = 50, offset = 0 } = filter;

  const where: Prisma.JobWhereInput = {
    deletedAt: null,
  };

  if (siteId) {
    where.siteId = siteId;
  }

  // Free-text search OR'd across the columns shown in the UI.
  if (q) {
    where.currentBlob = {
      OR: [{ name: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }],
    };
  } else if (name) {
    where.currentBlob = {
      name: { contains: name, mode: "insensitive" },
    };
  }

  // Filter jobs that have at least one JobProduct matching the given product IDs
  if (productIds && productIds.length > 0) {
    where.jobProducts = {
      some: {
        productId: { in: productIds },
        deletedAt: null,
      },
    };
  }

  const pagination = {
    ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
    skip: Number(offset),
    orderBy: { createdAt: "desc" } as const,
  };

  if (view === "slim") {
    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        select: {
          id: true,
          currentBlob: { select: { name: true, description: true } },
        },
        ...pagination,
      }),
      prisma.job.count({ where }),
    ]);

    return {
      data: jobs.map((j) => ({
        id: j.id,
        name: j.currentBlob?.name ?? "",
        description: j.currentBlob?.description ?? null,
      })),
      total,
      limit: Number(limit),
      offset: Number(offset),
    };
  }

  const [jobs, total] = await Promise.all([
    prisma.job.findMany({
      where,
      include: {
        currentBlob: true,
        site: { select: { id: true, name: true } },
        _count: { select: { tools: true, jobProducts: true, orders: true, blobs: true } },
      },
      ...pagination,
    }),
    prisma.job.count({ where }),
  ]);

  return {
    data: jobs,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get job by ID with current blob, tools, and items
 */
export async function getById(id: string) {
  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      currentBlob: true,
      site: { select: { id: true, name: true } },
      tools: {
        where: { deletedAt: null },
        include: {
          tool: {
            include: {
              currentBlob: true,
              toolCavities: {
                where: { deletedAt: null },
                include: { currentBlob: true },
              },
            },
          },
        },
      },
      jobProducts: {
        where: { deletedAt: null },
        include: {
          currentBlob: true,
          product: {
            include: {
              currentBlob: true,
              // BOM materials so the operator screen can list short code +
              // description per material and offer alt-group swaps.
              materials: {
                where: { archivedAt: null },
                include: {
                  currentBlob: true,
                  material: { include: { currentBlob: true } },
                  altGroup: true,
                },
              },
            },
          },
          tool: {
            include: {
              currentBlob: true,
            },
          },
          toolCavity: {
            include: {
              currentBlob: true,
            },
          },
        },
      },
      _count: { select: { tools: true, jobProducts: true, orders: true, blobs: true } },
    },
  });

  if (!job) {
    return null;
  }

  if (job.deletedAt) {
    return { error: "Job has been deleted", code: "JOB_DELETED" };
  }

  return { data: job };
}

/**
 * Update job (creates new blob version)
 */
export async function update(id: string, input: UpdateJobInput) {
  const { name, description, standardCycle, productsPerCycle, attrs } = input;

  // Get current job with blob
  const current = await prisma.job.findUnique({
    where: { id },
    include: { currentBlob: true },
  });

  if (!current) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  if (current.deletedAt) {
    return { error: "Job has been deleted", code: "JOB_DELETED" };
  }

  if (!current.currentBlob) {
    return { error: "Job has no current blob", code: "NO_CURRENT_BLOB" };
  }

  const currentBlob = current.currentBlob;

  // Get next version number
  const latestBlob = await prisma.jobBlob.findFirst({
    where: { jobId: id },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const nextVersion = (latestBlob?.version ?? 0) + 1;

  // Create new blob with merged data
  const job = await prisma.$transaction(async (tx) => {
    const blob = await tx.jobBlob.create({
      data: {
        jobId: id,
        version: nextVersion,
        name: name ?? currentBlob.name,
        description: description !== undefined ? description : currentBlob.description,
        standardCycle: standardCycle !== undefined ? standardCycle : currentBlob.standardCycle,
        productsPerCycle: productsPerCycle !== undefined ? productsPerCycle : currentBlob.productsPerCycle,
        attrs: attrs !== undefined ? attrs : (currentBlob.attrs as Record<string, unknown>),
      },
    });

    return tx.job.update({
      where: { id },
      data: { currentBlobId: blob.id },
      include: {
        currentBlob: true,
        site: { select: { id: true, name: true } },
        _count: { select: { tools: true, jobProducts: true, orders: true, blobs: true } },
      },
    });
  });

  return { data: job };
}

/**
 * Soft delete job (sets deletedAt)
 */
export async function remove(id: string) {
  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      _count: { select: { orders: true } },
    },
  });

  if (!job) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  if (job.deletedAt) {
    return { error: "Job already deleted", code: "JOB_DELETED" };
  }

  if (job._count.orders > 0) {
    return {
      error: "Cannot delete job that has work orders. Delete work orders first.",
      code: "HAS_ORDERS",
    };
  }

  await prisma.job.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}

/**
 * Check if job exists
 */
export async function exists(id: string) {
  const job = await prisma.job.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  return job !== null && job.deletedAt === null;
}

// ============================================================================
// JobTool Operations (linking tools to jobs)
// ============================================================================

/**
 * Add a tool to a job
 */
export async function addTool(input: AddToolInput) {
  const { jobId, toolId } = input;

  // Verify job exists and is not deleted
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!job) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  if (job.deletedAt) {
    return { error: "Job has been deleted", code: "JOB_DELETED" };
  }

  // Verify tool exists and is not deleted
  const tool = await prisma.tool.findUnique({
    where: { id: toolId },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!tool) {
    return { error: "Tool not found", code: "TOOL_NOT_FOUND" };
  }

  if (tool.deletedAt) {
    return { error: "Tool has been deleted", code: "TOOL_DELETED" };
  }

  // Verify same site
  if (job.siteId !== tool.siteId) {
    return { error: "Job and tool must belong to the same site", code: "SITE_MISMATCH" };
  }

  // Check if already linked
  const existing = await prisma.jobTool.findUnique({
    where: { jobId_toolId: { jobId, toolId } },
  });

  if (existing && !existing.deletedAt) {
    return { error: "Tool is already linked to this job", code: "ALREADY_LINKED" };
  }

  // Create or restore JobTool
  let jobTool: Awaited<ReturnType<typeof prisma.jobTool.update>>;

  if (existing) {
    // Restore soft-deleted link
    jobTool = await prisma.jobTool.update({
      where: { id: existing.id },
      data: { deletedAt: null, isActive: true },
      include: {
        tool: {
          include: {
            currentBlob: true,
            toolCavities: {
              where: { deletedAt: null },
              include: { currentBlob: true },
            },
          },
        },
      },
    });
  } else {
    // Create new link
    jobTool = await prisma.jobTool.create({
      data: { jobId, toolId, isActive: true },
      include: {
        tool: {
          include: {
            currentBlob: true,
            toolCavities: {
              where: { deletedAt: null },
              include: { currentBlob: true },
            },
          },
        },
      },
    });
  }

  return { data: jobTool };
}

/**
 * Remove a tool from a job (soft delete)
 */
export async function removeTool(jobId: string, toolId: string) {
  const jobTool = await prisma.jobTool.findUnique({
    where: { jobId_toolId: { jobId, toolId } },
  });

  if (!jobTool) {
    return { error: "Tool is not linked to this job", code: "NOT_LINKED" };
  }

  if (jobTool.deletedAt) {
    return { error: "Link already deleted", code: "ALREADY_DELETED" };
  }

  await prisma.jobTool.update({
    where: { id: jobTool.id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}

/**
 * List tools linked to a job
 */
export async function listTools(jobId: string) {
  // Verify job exists
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, deletedAt: true },
  });

  if (!job) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  const jobTools = await prisma.jobTool.findMany({
    where: {
      jobId,
      deletedAt: null,
    },
    include: {
      tool: {
        include: {
          currentBlob: true,
          toolCavities: {
            where: { deletedAt: null },
            include: {
              currentBlob: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return { data: jobTools };
}

// ============================================================================
// JobProduct Operations (linking products to jobs)
// ============================================================================

/**
 * Add a product (item) to a job
 */
export async function addItem(input: AddItemInput) {
  const { jobId, productId, toolId, toolCavityId, quantity } = input;

  // Verify job exists and is not deleted
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!job) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  if (job.deletedAt) {
    return { error: "Job has been deleted", code: "JOB_DELETED" };
  }

  // Verify product exists and is not deleted
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, siteId: true, deletedAt: true },
  });

  if (!product) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  if (product.deletedAt) {
    return { error: "Product has been deleted", code: "PRODUCT_DELETED" };
  }

  // Verify same site
  if (job.siteId !== product.siteId) {
    return { error: "Job and product must belong to the same site", code: "SITE_MISMATCH" };
  }

  // If toolId provided, verify it
  if (toolId) {
    const tool = await prisma.tool.findUnique({
      where: { id: toolId },
      select: { id: true, siteId: true, deletedAt: true },
    });

    if (!tool) {
      return { error: "Tool not found", code: "TOOL_NOT_FOUND" };
    }

    if (tool.deletedAt) {
      return { error: "Tool has been deleted", code: "TOOL_DELETED" };
    }

    if (job.siteId !== tool.siteId) {
      return { error: "Tool must belong to the same site as job", code: "TOOL_SITE_MISMATCH" };
    }
  }

  // If toolCavityId provided, verify it
  if (toolCavityId) {
    const cavity = await prisma.toolCavity.findUnique({
      where: { id: toolCavityId },
      select: { id: true, toolId: true, deletedAt: true },
    });

    if (!cavity) {
      return { error: "Tool cavity not found", code: "CAVITY_NOT_FOUND" };
    }

    if (cavity.deletedAt) {
      return { error: "Tool cavity has been deleted", code: "CAVITY_DELETED" };
    }
  }

  // Create JobProduct with blob
  const jobProduct = await prisma.$transaction(async (tx) => {
    // 1. Create JobProduct entity
    const jp = await tx.jobProduct.create({
      data: {
        jobId,
        productId,
        toolId: toolId ?? null,
        toolCavityId: toolCavityId ?? null,
      },
    });

    // 2. Create initial JobProductBlob (version 1)
    const blob = await tx.jobProductBlob.create({
      data: {
        jobProductId: jp.id,
        version: 1,
        isActive: true,
        quantity: quantity ?? 1,
      },
    });

    // 3. Link blob as current and return
    return tx.jobProduct.update({
      where: { id: jp.id },
      data: { currentBlobId: blob.id },
      include: {
        currentBlob: true,
        product: {
          include: {
            currentBlob: true,
          },
        },
        tool: {
          include: {
            currentBlob: true,
          },
        },
        toolCavity: {
          include: {
            currentBlob: true,
          },
        },
      },
    });
  });

  return { data: jobProduct };
}

/**
 * Update a job product (creates new blob version)
 */
export async function updateItem(itemId: string, input: UpdateItemInput) {
  const { isActive, toolId, toolCavityId, quantity } = input;

  // Get current item with blob
  const current = await prisma.jobProduct.findUnique({
    where: { id: itemId },
    include: {
      currentBlob: true,
      job: { select: { id: true, siteId: true, deletedAt: true } },
    },
  });

  if (!current) {
    return { error: "Job product not found", code: "ITEM_NOT_FOUND" };
  }

  if (current.deletedAt) {
    return { error: "Job product has been deleted", code: "ITEM_DELETED" };
  }

  if (current.job.deletedAt) {
    return { error: "Job has been deleted", code: "JOB_DELETED" };
  }

  if (!current.currentBlob) {
    return { error: "Job product has no current blob", code: "NO_CURRENT_BLOB" };
  }

  const currentBlob = current.currentBlob;

  // Validate toolId if changing
  if (toolId !== undefined && toolId !== null) {
    const tool = await prisma.tool.findUnique({
      where: { id: toolId },
      select: { id: true, siteId: true, deletedAt: true },
    });

    if (!tool) {
      return { error: "Tool not found", code: "TOOL_NOT_FOUND" };
    }

    if (tool.deletedAt) {
      return { error: "Tool has been deleted", code: "TOOL_DELETED" };
    }

    if (current.job.siteId !== tool.siteId) {
      return { error: "Tool must belong to the same site as job", code: "TOOL_SITE_MISMATCH" };
    }
  }

  // Validate toolCavityId if changing
  if (toolCavityId !== undefined && toolCavityId !== null) {
    const cavity = await prisma.toolCavity.findUnique({
      where: { id: toolCavityId },
      select: { id: true, toolId: true, deletedAt: true },
    });

    if (!cavity) {
      return { error: "Tool cavity not found", code: "CAVITY_NOT_FOUND" };
    }

    if (cavity.deletedAt) {
      return { error: "Tool cavity has been deleted", code: "CAVITY_DELETED" };
    }
  }

  // Get next version number
  const latestBlob = await prisma.jobProductBlob.findFirst({
    where: { jobProductId: itemId },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const nextVersion = (latestBlob?.version ?? 0) + 1;

  // Create new blob and update item
  const jobProduct = await prisma.$transaction(async (tx) => {
    const blob = await tx.jobProductBlob.create({
      data: {
        jobProductId: itemId,
        version: nextVersion,
        isActive: isActive !== undefined ? isActive : currentBlob.isActive,
        quantity: quantity !== undefined ? quantity : currentBlob.quantity,
      },
    });

    return tx.jobProduct.update({
      where: { id: itemId },
      data: {
        currentBlobId: blob.id,
        toolId: toolId !== undefined ? toolId : undefined,
        toolCavityId: toolCavityId !== undefined ? toolCavityId : undefined,
      },
      include: {
        currentBlob: true,
        product: {
          include: {
            currentBlob: true,
          },
        },
        tool: {
          include: {
            currentBlob: true,
          },
        },
        toolCavity: {
          include: {
            currentBlob: true,
          },
        },
      },
    });
  });

  return { data: jobProduct };
}

/**
 * Remove a job product (soft delete)
 */
export async function removeItem(itemId: string) {
  const item = await prisma.jobProduct.findUnique({
    where: { id: itemId },
  });

  if (!item) {
    return { error: "Job product not found", code: "ITEM_NOT_FOUND" };
  }

  if (item.deletedAt) {
    return { error: "Job product already deleted", code: "ITEM_DELETED" };
  }

  await prisma.jobProduct.update({
    where: { id: itemId },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}

/**
 * List products for a job
 */
export async function listItems(jobId: string) {
  // Verify job exists
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, deletedAt: true },
  });

  if (!job) {
    return { error: "Job not found", code: "JOB_NOT_FOUND" };
  }

  const jobProducts = await prisma.jobProduct.findMany({
    where: {
      jobId,
      deletedAt: null,
    },
    include: {
      currentBlob: true,
      product: {
        include: {
          currentBlob: true,
        },
      },
      tool: {
        include: {
          currentBlob: true,
        },
      },
      toolCavity: {
        include: {
          currentBlob: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return { data: jobProducts };
}

/**
 * Given a list of product IDs, return the jobs capable of producing each.
 * Returns a map of productId → [{ jobId, jobName }].
 */
export async function jobsByProductIds(siteId: string, productIds: string[]) {
  if (productIds.length === 0) return { data: {} };

  const jobProducts = await prisma.jobProduct.findMany({
    where: {
      deletedAt: null,
      productId: { in: productIds },
      job: { siteId, deletedAt: null },
    },
    select: {
      productId: true,
      job: {
        select: {
          id: true,
          currentBlob: { select: { name: true } },
        },
      },
    },
  });

  const map: Record<string, { jobId: string; jobName: string }[]> = {};
  for (const jp of jobProducts) {
    if (!map[jp.productId]) map[jp.productId] = [];
    // Deduplicate — same job can appear multiple times via different cavities
    if (map[jp.productId].some((e) => e.jobId === jp.job.id)) continue;
    map[jp.productId].push({ jobId: jp.job.id, jobName: jp.job.currentBlob?.name ?? "" });
  }

  return { data: map };
}
