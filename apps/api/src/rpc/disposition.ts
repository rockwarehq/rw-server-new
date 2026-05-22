import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import * as dispositionService from "@rw/services/inventory/disposition";
import * as dispositionReasonService from "@rw/services/inventory/disposition-reason";
import * as dispositionLogService from "@rw/services/inventory/disposition-log";

// ============================================================================
// ItemDisposition Input Schemas
// ============================================================================

const dispositionCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
});

const dispositionUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const dispositionListInputSchema = z.object({
  siteId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// ItemDispositionReason Input Schemas
// ============================================================================

const reasonCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  itemDispositionIds: z.array(z.uuid()).optional(),
  processTypeId: z.uuid().optional(),
});

const reasonUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  itemDispositionIds: z.array(z.uuid()).optional(),
  processTypeId: z.uuid().nullable().optional(),
});

const reasonListInputSchema = z.object({
  siteId: z.uuid().optional(),
  itemDispositionId: z.uuid().optional(),
  processTypeId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// ItemDispositionLog Input Schemas
// ============================================================================

const logRecordInputSchema = z.object({
  siteId: z.uuid(),
  stationId: z.uuid(),
  workcenterId: z.uuid().optional(),
  productId: z.uuid(),
  jobId: z.uuid().optional(),
  toolCavityId: z.uuid().optional(),
  quantity: z
    .number()
    .int()
    .refine((q) => q !== 0, { message: "quantity must be non-zero" })
    .optional(),
  itemDispositionId: z.uuid(),
  dispositionReasonId: z.uuid(),
  cycleId: z.uuid().optional(),
  shiftInstanceId: z.uuid().optional(),
});

const logCreateInputSchema = z.object({
  siteId: z.uuid(),
  stationId: z.uuid(),
  quantity: z.number().int().min(1).optional(),
  itemDispositionId: z.uuid(),
  dispositionReasonId: z.uuid(),
  cycleId: z.uuid().optional(),
  shiftInstanceId: z.uuid().optional(),
  productBlobId: z.uuid(),
  stationBlobId: z.uuid().optional(),
  jobProductBlobId: z.uuid().optional(),
  toolBlobId: z.uuid().optional(),
  toolCavityBlobId: z.uuid().optional(),
});

const logUpdateInputSchema = z.object({
  id: z.uuid(),
  quantity: z.number().int().min(1).optional(),
  itemDispositionId: z.uuid().nullable().optional(),
  dispositionReasonId: z.uuid().nullable().optional(),
});

const logListInputSchema = z.object({
  siteId: z.uuid().optional(),
  stationId: z.uuid().optional(),
  shiftInstanceId: z.uuid().optional(),
  dispositionReasonId: z.uuid().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// ItemDisposition Procedures
// ============================================================================

export const dispositionCreate = authRequired.input(dispositionCreateInputSchema).handler(async ({ input }) => {
  const result = await dispositionService.create(input);
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

export const dispositionList = userOrDisplayRequired.input(dispositionListInputSchema).handler(async ({ input }) => {
  return dispositionService.list(input);
});

export const dispositionGet = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await dispositionService.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Disposition not found" });
  }
  return result.data;
});

export const dispositionUpdate = authRequired.input(dispositionUpdateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await dispositionService.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "DISPOSITION_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "DUPLICATE_NAME") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const dispositionDelete = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await dispositionService.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "DISPOSITION_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "HAS_REASONS" || code === "HAS_LOGS") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return { success: true };
});

// ============================================================================
// ItemDispositionReason Procedures
// ============================================================================

export const reasonCreate = authRequired.input(reasonCreateInputSchema).handler(async ({ input }) => {
  const result = await dispositionReasonService.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND" || code === "DISPOSITION_NOT_FOUND" || code === "PROCESS_TYPE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "DUPLICATE_NAME" || code === "SITE_MISMATCH") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const reasonList = userOrDisplayRequired.input(reasonListInputSchema).handler(async ({ input }) => {
  return dispositionReasonService.list(input);
});

export const reasonGet = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await dispositionReasonService.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Disposition reason not found" });
  }
  return result.data;
});

export const reasonUpdate = authRequired.input(reasonUpdateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await dispositionReasonService.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (
      code === "DISPOSITION_REASON_NOT_FOUND" ||
      code === "DISPOSITION_NOT_FOUND" ||
      code === "PROCESS_TYPE_NOT_FOUND"
    ) {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "DUPLICATE_NAME" || code === "SITE_MISMATCH") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const reasonDelete = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await dispositionReasonService.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "DISPOSITION_REASON_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "HAS_LOGS") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return { success: true };
});

// ============================================================================
// ItemDispositionLog Procedures
// ============================================================================

export const logRecord = userOrDisplayRequired.input(logRecordInputSchema).handler(async ({ input }) => {
  const result = await dispositionLogService.record(input);
  if ("error" in result) {
    const code = result.code as string;
    if (
      code === "STATION_NOT_FOUND" ||
      code === "PRODUCT_NOT_FOUND" ||
      code === "JOB_PRODUCT_NOT_FOUND" ||
      code === "TOOL_CAVITY_NOT_FOUND" ||
      code === "DISPOSITION_NOT_FOUND" ||
      code === "DISPOSITION_REASON_NOT_FOUND"
    ) {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "SITE_MISMATCH" || code === "NO_CURRENT_BLOB" || code === "DISPOSITION_REASON_NOT_LINKED") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const logCreate = authRequired.input(logCreateInputSchema).handler(async ({ input }) => {
  const result = await dispositionLogService.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (
      code === "STATION_NOT_FOUND" ||
      code === "DISPOSITION_NOT_FOUND" ||
      code === "DISPOSITION_REASON_NOT_FOUND" ||
      code === "PRODUCT_BLOB_NOT_FOUND"
    ) {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "SITE_MISMATCH" || code === "DISPOSITION_REASON_NOT_LINKED") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const logList = userOrDisplayRequired.input(logListInputSchema).handler(async ({ input }) => {
  return dispositionLogService.list(input);
});

export const logGet = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await dispositionLogService.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Disposition log not found" });
  }
  return result.data;
});

export const logUpdate = authRequired.input(logUpdateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await dispositionLogService.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (
      code === "DISPOSITION_LOG_NOT_FOUND" ||
      code === "DISPOSITION_NOT_FOUND" ||
      code === "DISPOSITION_REASON_NOT_FOUND"
    ) {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "SITE_MISMATCH" || code === "DISPOSITION_REASON_NOT_LINKED") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const logDelete = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await dispositionLogService.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "DISPOSITION_LOG_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return { success: true };
});
