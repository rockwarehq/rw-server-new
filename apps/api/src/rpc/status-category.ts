import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { statusCategory } from "@rw/services/facility/index";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures
// ============================================================================

export const create = authRequired.input(createInputSchema).handler(async ({ input }) => {
  const result = await statusCategory.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "DUPLICATE_NAME") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const list = userOrDisplayRequired.input(listInputSchema).handler(async ({ input }) => {
  return statusCategory.list(input);
});

export const get = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await statusCategory.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Status category not found" });
  }
  return result.data;
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await statusCategory.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATUS_CATEGORY_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "DUPLICATE_NAME") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const remove = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await statusCategory.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "STATUS_CATEGORY_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "HAS_STATUS_REASONS") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return { success: true };
});
