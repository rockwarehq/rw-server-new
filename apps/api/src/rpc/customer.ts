import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired } from "./middleware.js";
import * as customerService from "@rw/services/order/customer";

// ============================================================================
// Input Schemas
// ============================================================================

const createInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1).max(255),
});

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(255).optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid().optional(),
  search: z.string().optional(),
  limit: z.number().min(0).default(200),
  offset: z.number().min(0).default(0),
});

const idInputSchema = z.object({ id: z.uuid() });

// ============================================================================
// Procedures
// ============================================================================

export const create = authRequired.input(createInputSchema).handler(async ({ input }) => {
  const result = await customerService.create(input);
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

export const list = authRequired.input(listInputSchema).handler(async ({ input }) => {
  return customerService.list(input);
});

export const get = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await customerService.getById(input.id);
  if ("error" in result) {
    throw new ORPCError("NOT_FOUND", { message: result.error as string });
  }
  return result.data;
});

export const update = authRequired.input(updateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await customerService.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "CUSTOMER_NOT_FOUND") {
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
  const result = await customerService.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "CUSTOMER_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "HAS_ORDERS") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return { success: true };
});
