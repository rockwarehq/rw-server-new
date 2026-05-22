import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { tool, job } from "@rw/services/job/index";

// ============================================================================
// Input Schemas - Tool CRUD
// ============================================================================

const toolCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  cavityCount: z.number().int().positive().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const toolUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  cavityCount: z.number().int().positive().nullable().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const toolIdInputSchema = z.object({
  id: z.uuid(),
});

const toolListInputSchema = z.object({
  siteId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Input Schemas - Tool Cavity
// ============================================================================

const addCavityInputSchema = z.object({
  toolId: z.uuid(),
  name: z.string().min(1),
  position: z.number().int().optional(),
});

const updateCavityInputSchema = z.object({
  cavityId: z.uuid(),
  name: z.string().min(1).optional(),
  position: z.number().int().optional(),
});

const cavityIdInputSchema = z.object({
  cavityId: z.uuid(),
});

const listCavitiesInputSchema = z.object({
  toolId: z.uuid(),
});

// ============================================================================
// Input Schemas - Job CRUD
// ============================================================================

const jobCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  standardCycle: z.number().positive().optional(),
  productsPerCycle: z.number().int().positive().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const jobUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  standardCycle: z.number().positive().optional(),
  productsPerCycle: z.number().int().positive().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const jobIdInputSchema = z.object({
  id: z.uuid(),
});

const jobListInputSchema = z.object({
  siteId: z.uuid().optional(),
  q: z.string().optional(),
  name: z.string().optional(),
  productIds: z.array(z.uuid()).optional(),
  view: z.enum(["full", "slim"]).default("full"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Input Schemas - Job Tools
// ============================================================================

const addToolInputSchema = z.object({
  jobId: z.uuid(),
  toolId: z.uuid(),
});

const removeToolInputSchema = z.object({
  jobId: z.uuid(),
  toolId: z.uuid(),
});

const listToolsInputSchema = z.object({
  jobId: z.uuid(),
});

// ============================================================================
// Input Schemas - Job Items
// ============================================================================

const addItemInputSchema = z.object({
  jobId: z.uuid(),
  productId: z.uuid(),
  toolId: z.uuid().optional(),
  toolCavityId: z.uuid().optional(),
  quantity: z.number().int().positive().default(1),
});

const updateItemInputSchema = z.object({
  itemId: z.uuid(),
  isActive: z.boolean().optional(),
  toolId: z.uuid().nullable().optional(),
  toolCavityId: z.uuid().nullable().optional(),
  quantity: z.number().int().positive().optional(),
});

const itemIdInputSchema = z.object({
  itemId: z.uuid(),
});

const listItemsInputSchema = z.object({
  jobId: z.uuid(),
});

// ============================================================================
// Procedures - Tool CRUD
// ============================================================================

/**
 * Create a new tool
 */
export const toolCreate = authRequired.input(toolCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await tool.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * List tools with optional filters
 */
export const toolList = authRequired.input(toolListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return tool.list(input);
});

/**
 * Get tool by ID
 */
export const toolGet = authRequired.input(toolIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await tool.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Tool not found" });
  }
  if ("error" in result) {
    const code = result.code as string;
    if (code === "TOOL_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Update tool (creates new blob version)
 */
export const toolUpdate = authRequired.input(toolUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const { id, ...updateData } = input;
  const result = await tool.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "TOOL_NOT_FOUND" || code === "TOOL_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Delete tool (soft delete)
 */
export const toolRemove = authRequired.input(toolIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await tool.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "TOOL_NOT_FOUND" || code === "TOOL_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "HAS_JOBS" || code === "HAS_JOB_ITEMS") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return { success: true };
});

// ============================================================================
// Procedures - Tool Cavity
// ============================================================================

/**
 * Add a cavity to a tool
 */
export const toolAddCavity = authRequired.input(addCavityInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await tool.addCavity(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "TOOL_NOT_FOUND" || code === "TOOL_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Update a cavity (creates new blob version)
 */
export const toolUpdateCavity = authRequired.input(updateCavityInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const { cavityId, ...updateData } = input;
  const result = await tool.updateCavity(cavityId, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "CAVITY_NOT_FOUND" || code === "CAVITY_DELETED" || code === "TOOL_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Remove a cavity (soft delete)
 */
export const toolRemoveCavity = authRequired.input(cavityIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await tool.removeCavity(input.cavityId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "CAVITY_NOT_FOUND" || code === "CAVITY_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "HAS_JOB_ITEMS") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return { success: true };
});

/**
 * List cavities for a tool
 */
export const toolListCavities = authRequired.input(listCavitiesInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await tool.listCavities(input.toolId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "TOOL_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

// ============================================================================
// Procedures - Job CRUD
// ============================================================================

/**
 * Create a new job
 */
export const create = authRequired.input(jobCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * List jobs with optional filters
 */
export const list = userOrDisplayRequired.input(jobListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return job.list(input);
});

/**
 * Get job by ID
 */
export const get = userOrDisplayRequired.input(jobIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  }
  if ("error" in result) {
    const code = result.code as string;
    if (code === "JOB_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Update job (creates new blob version)
 */
export const update = authRequired.input(jobUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const { id, ...updateData } = input;
  const result = await job.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "JOB_NOT_FOUND" || code === "JOB_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Delete job (soft delete)
 */
export const remove = authRequired.input(jobIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "JOB_NOT_FOUND" || code === "JOB_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "HAS_ORDERS") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return { success: true };
});

// ============================================================================
// Procedures - Job Tools (linking tools to jobs)
// ============================================================================

/**
 * Add a tool to a job
 */
export const addTool = authRequired.input(addToolInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.addTool(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "JOB_NOT_FOUND" || code === "JOB_DELETED" || code === "TOOL_NOT_FOUND" || code === "TOOL_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "SITE_MISMATCH" || code === "ALREADY_LINKED") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Remove a tool from a job
 */
export const removeTool = authRequired.input(removeToolInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.removeTool(input.jobId, input.toolId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "NOT_LINKED" || code === "ALREADY_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return { success: true };
});

/**
 * List tools linked to a job
 */
export const listTools = userOrDisplayRequired.input(listToolsInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.listTools(input.jobId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "JOB_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

// ============================================================================
// Procedures - Job Items (linking products to jobs)
// ============================================================================

/**
 * Add a product (item) to a job
 */
export const addItem = authRequired.input(addItemInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.addItem(input);
  if ("error" in result) {
    const code = result.code as string;
    if (
      code === "JOB_NOT_FOUND" ||
      code === "JOB_DELETED" ||
      code === "PRODUCT_NOT_FOUND" ||
      code === "PRODUCT_DELETED" ||
      code === "TOOL_NOT_FOUND" ||
      code === "TOOL_DELETED" ||
      code === "CAVITY_NOT_FOUND" ||
      code === "CAVITY_DELETED"
    ) {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "SITE_MISMATCH" || code === "TOOL_SITE_MISMATCH") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Update a job item
 */
export const updateItem = authRequired.input(updateItemInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const { itemId, ...updateData } = input;
  const result = await job.updateItem(itemId, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (
      code === "ITEM_NOT_FOUND" ||
      code === "ITEM_DELETED" ||
      code === "JOB_DELETED" ||
      code === "TOOL_NOT_FOUND" ||
      code === "TOOL_DELETED" ||
      code === "CAVITY_NOT_FOUND" ||
      code === "CAVITY_DELETED"
    ) {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "TOOL_SITE_MISMATCH") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Remove a job item (soft delete)
 */
export const removeItem = authRequired.input(itemIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.removeItem(input.itemId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "ITEM_NOT_FOUND" || code === "ITEM_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return { success: true };
});

/**
 * List items for a job
 */
export const listItems = userOrDisplayRequired.input(listItemsInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await job.listItems(input.jobId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "JOB_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Get jobs capable of producing the given products
 */
const jobsByProductIdsInputSchema = z.object({
  siteId: z.uuid(),
  productIds: z.array(z.uuid()),
});

export const jobsByProductIds = authRequired.input(jobsByProductIdsInputSchema).handler(async ({ input }) => {
  const result = await job.jobsByProductIds(input.siteId, input.productIds);
  return result.data;
});
