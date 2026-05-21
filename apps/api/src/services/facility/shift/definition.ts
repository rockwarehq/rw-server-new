import prisma from "@rw/db";

export interface CreateShiftDefinitionInput {
  patternId: string;
  dayOfRotation: number;
  sortOrder: number;
  startDayOffset?: number;
  startTime: string;
  durationHrs: number;
  shiftName: string;
}

export interface UpdateShiftDefinitionInput {
  dayOfRotation?: number;
  sortOrder?: number;
  startDayOffset?: number;
  startTime?: string;
  durationHrs?: number;
  shiftName?: string;
}

export interface ListShiftDefinitionsFilter {
  patternId: string;
  dayOfRotation?: number;
}

/**
 * Create a new shift definition within a pattern
 */
export async function create(input: CreateShiftDefinitionInput) {
  const { patternId, dayOfRotation, sortOrder, startDayOffset, startTime, durationHrs, shiftName } = input;

  // Validate pattern exists and is not assigned
  const pattern = await prisma.shiftPattern.findUnique({
    where: { id: patternId },
    include: { assignment: { select: { id: true } } },
  });

  if (!pattern) {
    return { error: "Shift pattern not found", code: "SHIFT_PATTERN_NOT_FOUND" };
  }

  if (pattern.assignment) {
    return {
      error: "Cannot add definitions to an assigned pattern. Clone it first.",
      code: "PATTERN_ASSIGNED",
    };
  }

  // Check unique constraint [patternId, dayOfRotation, sortOrder]
  const existing = await prisma.shiftDefinition.findUnique({
    where: { patternId_dayOfRotation_sortOrder: { patternId, dayOfRotation, sortOrder } },
    select: { id: true },
  });

  if (existing) {
    return {
      error: `A shift definition already exists for day ${dayOfRotation}, sort order ${sortOrder}`,
      code: "DUPLICATE_SORT_ORDER",
    };
  }

  const definition = await prisma.shiftDefinition.create({
    data: {
      patternId,
      dayOfRotation,
      sortOrder,
      startDayOffset: startDayOffset ?? 0,
      startTime,
      durationHrs,
      shiftName,
    },
  });

  return { data: definition };
}

/**
 * List shift definitions for a pattern
 */
export async function list(filter: ListShiftDefinitionsFilter) {
  const { patternId, dayOfRotation } = filter;

  const where: Record<string, unknown> = { patternId };

  if (dayOfRotation !== undefined) {
    where.dayOfRotation = dayOfRotation;
  }

  const definitions = await prisma.shiftDefinition.findMany({
    where,
    orderBy: [{ dayOfRotation: "asc" }, { sortOrder: "asc" }],
  });

  return { data: definitions };
}

/**
 * Get shift definition by ID
 */
export async function getById(id: string) {
  const definition = await prisma.shiftDefinition.findUnique({
    where: { id },
  });

  if (!definition) {
    return null;
  }

  return { data: definition };
}

/**
 * Update shift definition
 */
export async function update(id: string, input: UpdateShiftDefinitionInput) {
  const { dayOfRotation, sortOrder, startDayOffset, startTime, durationHrs, shiftName } = input;

  const current = await prisma.shiftDefinition.findUnique({
    where: { id },
    include: {
      pattern: {
        include: { assignment: { select: { id: true } } },
      },
    },
  });

  if (!current) {
    return { error: "Shift definition not found", code: "SHIFT_DEFINITION_NOT_FOUND" };
  }

  if (current.pattern.assignment) {
    return {
      error: "Cannot edit definitions of an assigned pattern. Clone it first.",
      code: "PATTERN_ASSIGNED",
    };
  }

  // Check unique constraint if dayOfRotation or sortOrder are changing
  if (dayOfRotation !== undefined || sortOrder !== undefined) {
    const newDay = dayOfRotation ?? current.dayOfRotation;
    const newSort = sortOrder ?? current.sortOrder;

    const existing = await prisma.shiftDefinition.findUnique({
      where: {
        patternId_dayOfRotation_sortOrder: {
          patternId: current.patternId,
          dayOfRotation: newDay,
          sortOrder: newSort,
        },
      },
      select: { id: true },
    });

    if (existing && existing.id !== id) {
      return {
        error: `A shift definition already exists for day ${newDay}, sort order ${newSort}`,
        code: "DUPLICATE_SORT_ORDER",
      };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (dayOfRotation !== undefined) updateData.dayOfRotation = dayOfRotation;
  if (sortOrder !== undefined) updateData.sortOrder = sortOrder;
  if (startDayOffset !== undefined) updateData.startDayOffset = startDayOffset;
  if (startTime !== undefined) updateData.startTime = startTime;
  if (durationHrs !== undefined) updateData.durationHrs = durationHrs;
  if (shiftName !== undefined) updateData.shiftName = shiftName;

  const definition = await prisma.shiftDefinition.update({
    where: { id },
    data: updateData,
  });

  return { data: definition };
}

/**
 * Delete shift definition
 */
export async function remove(id: string) {
  const definition = await prisma.shiftDefinition.findUnique({
    where: { id },
    include: {
      pattern: {
        include: { assignment: { select: { id: true } } },
      },
    },
  });

  if (!definition) {
    return { error: "Shift definition not found", code: "SHIFT_DEFINITION_NOT_FOUND" };
  }

  if (definition.pattern.assignment) {
    return {
      error: "Cannot delete definitions from an assigned pattern. Clone it first.",
      code: "PATTERN_ASSIGNED",
    };
  }

  await prisma.shiftDefinition.delete({ where: { id } });

  return { success: true };
}
