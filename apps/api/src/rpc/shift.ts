import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { Principal } from "../services/auth/index.js";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { shift } from "@rw/services/facility/index";

// ============================================================================
// Current Shift / Business Date
// ============================================================================

const currentInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
});

export const current = userOrDisplayRequired.input(currentInputSchema).handler(async ({ input, context }) => {
  if (context.iam.principal === Principal.DISPLAY && input.siteId !== context.iam.siteId) {
    throw new ORPCError("FORBIDDEN", { message: "Display can only access shift data for its site" });
  }

  const result = await shift.current.getCurrentShift(input.siteId, input.workCenterId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

// ============================================================================
// ShiftPattern Input Schemas
// ============================================================================

const patternCreateInputSchema = z.object({
  siteId: z.uuid(),
  name: z.string().min(1),
  totalDaysInRotation: z.number().int().min(1).optional(),
  startOnDayOfWeek: z.string().optional(),
  useEndDateForBusinessDate: z.boolean().optional(),
});

const patternUpdateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
  totalDaysInRotation: z.number().int().min(1).optional(),
  startOnDayOfWeek: z.string().nullable().optional(),
  useEndDateForBusinessDate: z.boolean().optional(),
});

const patternListInputSchema = z.object({
  siteId: z.uuid().optional(),
  name: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const duplicateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).optional(),
});

// ============================================================================
// ShiftDefinition Input Schemas
// ============================================================================

const definitionCreateInputSchema = z.object({
  patternId: z.uuid(),
  dayOfRotation: z.number().int().min(1),
  sortOrder: z.number().int().min(1),
  startDayOffset: z.number().int().min(0).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "Must be HH:mm format"),
  durationHrs: z.number().positive(),
  shiftName: z.string().min(1),
});

const definitionUpdateInputSchema = z.object({
  id: z.uuid(),
  dayOfRotation: z.number().int().min(1).optional(),
  sortOrder: z.number().int().min(1).optional(),
  startDayOffset: z.number().int().min(0).optional(),
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Must be HH:mm format")
    .optional(),
  durationHrs: z.number().positive().optional(),
  shiftName: z.string().min(1).optional(),
});

const definitionListInputSchema = z.object({
  patternId: z.uuid(),
  dayOfRotation: z.number().int().min(1).optional(),
});

// ============================================================================
// ShiftAssignment Input Schemas
// ============================================================================

const assignmentCreateInputSchema = z.object({
  patternId: z.uuid(),
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  rotationStartDate: z.coerce.date(),
  rotationEndDate: z.coerce.date().optional(),
  rotationStartDefinitionId: z.uuid().optional(),
});

const assignmentUpdateInputSchema = z.object({
  id: z.uuid(),
  rotationStartDate: z.coerce.date().optional(),
  rotationEndDate: z.coerce.date().nullable().optional(),
  rotationStartDefinitionId: z.uuid().nullable().optional(),
});

const assignmentListInputSchema = z.object({
  siteId: z.uuid().optional(),
  workCenterId: z.uuid().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// ShiftPattern Procedures
// ============================================================================

export const patternCreate = authRequired.input(patternCreateInputSchema).handler(async ({ input }) => {
  const result = await shift.pattern.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const patternList = authRequired.input(patternListInputSchema).handler(async ({ input }) => {
  return shift.pattern.list(input);
});

export const patternGet = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await shift.pattern.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Shift pattern not found" });
  }
  return result.data;
});

export const patternUpdate = authRequired.input(patternUpdateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await shift.pattern.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_PATTERN_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "PATTERN_ASSIGNED") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const patternDelete = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await shift.pattern.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_PATTERN_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "PATTERN_ASSIGNED") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return { success: true };
});

export const patternDuplicate = authRequired.input(duplicateInputSchema).handler(async ({ input }) => {
  const result = await shift.pattern.duplicate(input.id, input.name);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_PATTERN_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

// ============================================================================
// ShiftDefinition Procedures
// ============================================================================

export const definitionCreate = authRequired.input(definitionCreateInputSchema).handler(async ({ input }) => {
  const result = await shift.definition.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_PATTERN_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "PATTERN_ASSIGNED" || code === "DUPLICATE_SORT_ORDER") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const definitionList = authRequired.input(definitionListInputSchema).handler(async ({ input }) => {
  return shift.definition.list(input);
});

export const definitionGet = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await shift.definition.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Shift definition not found" });
  }
  return result.data;
});

export const definitionUpdate = authRequired.input(definitionUpdateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await shift.definition.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_DEFINITION_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "PATTERN_ASSIGNED" || code === "DUPLICATE_SORT_ORDER") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const definitionDelete = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await shift.definition.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_DEFINITION_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "PATTERN_ASSIGNED") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return { success: true };
});

// ============================================================================
// ShiftAssignment Procedures
// ============================================================================

export const assignmentCreate = authRequired.input(assignmentCreateInputSchema).handler(async ({ input }) => {
  const result = await shift.assignment.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_PATTERN_NOT_FOUND" || code === "SITE_NOT_FOUND" || code === "WORKCENTER_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "PATTERN_ALREADY_ASSIGNED" || code === "SITE_MISMATCH") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const assignmentList = authRequired.input(assignmentListInputSchema).handler(async ({ input }) => {
  return shift.assignment.list(input);
});

export const assignmentGet = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await shift.assignment.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Shift assignment not found" });
  }
  return result.data;
});

export const assignmentUpdate = authRequired.input(assignmentUpdateInputSchema).handler(async ({ input }) => {
  const { id, ...updateData } = input;
  const result = await shift.assignment.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_ASSIGNMENT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

export const assignmentDelete = authRequired.input(idInputSchema).handler(async ({ input }) => {
  const result = await shift.assignment.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SHIFT_ASSIGNMENT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return { success: true };
});
