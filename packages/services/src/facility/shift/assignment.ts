import prisma from "@rw/db";
import { reconcileShiftInstances } from "@rw/services/facility/shift/materialize";

export interface CreateShiftAssignmentInput {
  patternId: string;
  siteId: string;
  workCenterId?: string;
  rotationStartDate: Date;
  rotationEndDate?: Date;
  rotationStartDefinitionId?: string;
}

export interface UpdateShiftAssignmentInput {
  rotationStartDate?: Date;
  rotationEndDate?: Date | null;
  rotationStartDefinitionId?: string | null;
}

export interface ListShiftAssignmentsFilter {
  siteId?: string;
  workCenterId?: string;
  limit?: number;
  offset?: number;
}

const assignmentInclude = {
  pattern: {
    include: {
      shifts: {
        orderBy: { sortOrder: "asc" as const },
      },
    },
  },
  rotationStartDefinition: {
    select: {
      id: true,
      dayOfRotation: true,
      sortOrder: true,
      startTime: true,
      shiftName: true,
    },
  },
  site: {
    select: { id: true, name: true },
  },
  workCenter: {
    select: { id: true, name: true },
  },
  _count: { select: { instances: true } },
};

/**
 * Create a new shift assignment
 */
export async function create(input: CreateShiftAssignmentInput) {
  const { patternId, siteId, workCenterId, rotationStartDate, rotationEndDate, rotationStartDefinitionId } = input;

  // Validate pattern exists
  const pattern = await prisma.shiftPattern.findUnique({
    where: { id: patternId },
    include: { assignment: { select: { id: true } } },
  });

  if (!pattern) {
    return { error: "Shift pattern not found", code: "SHIFT_PATTERN_NOT_FOUND" };
  }

  // Pattern must not already be assigned (1:1 relationship)
  if (pattern.assignment) {
    return {
      error: "This pattern is already assigned. Clone it to create a new assignment.",
      code: "PATTERN_ALREADY_ASSIGNED",
    };
  }

  // Validate site exists
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Pattern must belong to the same site
  if (pattern.siteId !== siteId) {
    return { error: "Pattern must belong to the same site", code: "SITE_MISMATCH" };
  }

  // Validate workcenter if provided
  if (workCenterId) {
    const workcenter = await prisma.workcenter.findUnique({
      where: { id: workCenterId },
      select: { id: true, siteId: true },
    });

    if (!workcenter) {
      return { error: "Workcenter not found", code: "WORKCENTER_NOT_FOUND" };
    }

    if (workcenter.siteId !== siteId) {
      return { error: "Workcenter must belong to the same site", code: "SITE_MISMATCH" };
    }
  }

  // Validate rotation start definition if provided
  if (rotationStartDefinitionId) {
    const definition = await prisma.shiftDefinition.findUnique({
      where: { id: rotationStartDefinitionId },
      select: { id: true, patternId: true },
    });

    if (!definition) {
      return { error: "Shift definition not found", code: "SHIFT_DEFINITION_NOT_FOUND" };
    }

    if (definition.patternId !== patternId) {
      return {
        error: "Rotation start definition must belong to the same pattern",
        code: "DEFINITION_PATTERN_MISMATCH",
      };
    }
  }

  const assignment = await prisma.shiftAssignment.create({
    data: {
      patternId,
      siteId,
      workCenterId: workCenterId ?? null,
      rotationStartDate,
      rotationEndDate: rotationEndDate ?? null,
      rotationStartDefinitionId: rotationStartDefinitionId ?? null,
    },
    include: assignmentInclude,
  });

  // Reconcile: end-date overlapping old assignments, clean up their
  // unused future ShiftInstances, and materialize the new assignment's shifts.
  await reconcileShiftInstances(assignment.id);

  return { data: assignment };
}

/**
 * List shift assignments with optional filtering
 */
export async function list(filter: ListShiftAssignmentsFilter = {}) {
  const { siteId, workCenterId, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = {};

  if (siteId) {
    where.siteId = siteId;
  }

  if (workCenterId) {
    where.workCenterId = workCenterId;
  }

  const [assignments, total] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where,
      include: assignmentInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.shiftAssignment.count({ where }),
  ]);

  return {
    data: assignments,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get shift assignment by ID
 */
export async function getById(id: string) {
  const assignment = await prisma.shiftAssignment.findUnique({
    where: { id },
    include: assignmentInclude,
  });

  if (!assignment) {
    return null;
  }

  return { data: assignment };
}

/**
 * Update shift assignment
 */
export async function update(id: string, input: UpdateShiftAssignmentInput) {
  const { rotationStartDate, rotationEndDate, rotationStartDefinitionId } = input;

  const current = await prisma.shiftAssignment.findUnique({
    where: { id },
    select: { id: true, patternId: true },
  });

  if (!current) {
    return { error: "Shift assignment not found", code: "SHIFT_ASSIGNMENT_NOT_FOUND" };
  }

  // Validate rotation start definition if provided (non-null)
  if (rotationStartDefinitionId) {
    const definition = await prisma.shiftDefinition.findUnique({
      where: { id: rotationStartDefinitionId },
      select: { id: true, patternId: true },
    });

    if (!definition) {
      return { error: "Shift definition not found", code: "SHIFT_DEFINITION_NOT_FOUND" };
    }

    if (definition.patternId !== current.patternId) {
      return {
        error: "Rotation start definition must belong to the same pattern",
        code: "DEFINITION_PATTERN_MISMATCH",
      };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (rotationStartDate !== undefined) updateData.rotationStartDate = rotationStartDate;
  if (rotationEndDate !== undefined) updateData.rotationEndDate = rotationEndDate;
  if (rotationStartDefinitionId !== undefined) updateData.rotationStartDefinitionId = rotationStartDefinitionId;

  const assignment = await prisma.shiftAssignment.update({
    where: { id },
    data: updateData,
    include: assignmentInclude,
  });

  // Re-reconcile when start parameters change
  if (rotationStartDate !== undefined || rotationStartDefinitionId !== undefined) {
    await reconcileShiftInstances(assignment.id);
  }

  return { data: assignment };
}

/**
 * Delete shift assignment (cascades instances)
 */
export async function remove(id: string) {
  const assignment = await prisma.shiftAssignment.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!assignment) {
    return { error: "Shift assignment not found", code: "SHIFT_ASSIGNMENT_NOT_FOUND" };
  }

  await prisma.shiftAssignment.delete({ where: { id } });

  return { success: true };
}
