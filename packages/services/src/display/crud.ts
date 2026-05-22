import { randomBytes } from "node:crypto";
import prisma from "@rw/db";
import { hashToken } from "@rw/services/auth/tokens";

// ============================================================================
// Types
// ============================================================================

export interface ClaimDisplayInput {
  name: string;
  siteId: string;
}

export interface UpdateDisplayInput {
  name?: string;
  workcenterId?: string | null;
  stationId?: string | null;
}

export interface ListDisplaysFilter {
  siteId?: string;
  status?: "UNCLAIMED" | "CLAIMED";
  limit?: number;
  offset?: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a random 6-character claim code (e.g. "A3X-7K2")
 * Excludes ambiguous characters: I, O, 0, 1
 */
function generateClaimCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part1 = Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const part2 = Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${part1}-${part2}`;
}

/**
 * Generate a unique claim code (retry on collision)
 */
async function generateUniqueClaimCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = generateClaimCode();
    const existing = await prisma.display.findUnique({
      where: { claimCode: code },
      select: { id: true },
    });
    if (!existing) return code;
  }
  throw new Error("Failed to generate unique claim code after 10 attempts");
}

function generateBootstrapSecret(): string {
  return randomBytes(32).toString("hex");
}

// ============================================================================
// Operations
// ============================================================================

/**
 * Register a new unclaimed display (called from the TV/tablet, no auth)
 * Returns the display with its claim code.
 */
export async function register() {
  const claimCode = await generateUniqueClaimCode();
  const bootstrapSecret = generateBootstrapSecret();

  const display = await prisma.display.create({
    data: {
      claimCode,
      bootstrapSecretHash: hashToken(bootstrapSecret),
      bootstrapSecretCreatedAt: new Date(),
      status: "UNCLAIMED",
      lastSeenAt: new Date(),
    },
    select: {
      id: true,
      claimCode: true,
      status: true,
      createdAt: true,
    },
  });

  return {
    data: {
      ...display,
      bootstrapSecret,
    },
  };
}

/**
 * Get display by ID (public -- used by both TV and workspace)
 * Includes dashboard spec/state when a dashboard is assigned.
 */
export async function getById(id: string) {
  const display = await prisma.display.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      status: true,
      siteId: true,
      dashboardId: true,
      workcenterId: true,
      stationId: true,
      claimedAt: true,
      lastSeenAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!display) {
    return null;
  }

  return { data: display };
}

/**
 * Claim a display by its claim code (called from workspace, requires auth)
 */
export async function claim(workspaceId: string, claimCode: string, input: ClaimDisplayInput) {
  const { name, siteId } = input;

  // Verify site exists
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true, name: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  if (site.workspaceId !== workspaceId) {
    return { error: "Site does not belong to this workspace", code: "SITE_NOT_IN_WORKSPACE" };
  }

  // Find unclaimed display by code
  const display = await prisma.display.findUnique({
    where: { claimCode },
    select: { id: true, status: true },
  });

  if (!display) {
    return { error: "Invalid claim code", code: "INVALID_CLAIM_CODE" };
  }

  if (display.status === "CLAIMED") {
    return { error: "Display has already been claimed", code: "ALREADY_CLAIMED" };
  }

  const claimed = await prisma.display.update({
    where: { id: display.id },
    data: {
      name,
      siteId,
      claimCode: null,
      status: "CLAIMED",
      claimedAt: new Date(),
    },
    include: {
      site: { select: { id: true, name: true } },
      dashboard: {
        select: {
          id: true,
          name: true,
          description: true,
          spec: true,
          state: true,
        },
      },
    },
  });

  return { data: claimed };
}

/**
 * List displays for a site
 */
export async function list(filter: ListDisplaysFilter = {}) {
  return listForWorkspace("", filter);
}

export async function listForWorkspace(workspaceId: string, filter: ListDisplaysFilter = {}) {
  const { siteId, status, limit = 50, offset = 0 } = filter;

  const where: Record<string, unknown> = {};

  if (workspaceId) {
    where.site = {
      workspaceId,
    };
  }

  if (siteId) {
    where.siteId = siteId;
  }

  if (status) {
    where.status = status;
  }

  const [displays, total] = await Promise.all([
    prisma.display.findMany({
      where,
      include: {
        site: { select: { id: true, name: true } },
        dashboard: {
          select: { id: true, name: true },
        },
        workcenter: { select: { id: true, name: true } },
        station: { select: { id: true, name: true } },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.display.count({ where }),
  ]);

  return {
    data: displays,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Assign a dashboard to a display
 */
export async function assignDashboard(workspaceId: string, id: string, dashboardId: string) {
  const display = await prisma.display.findFirst({
    where: {
      id,
      site: {
        workspaceId,
      },
    },
    select: { id: true, status: true, siteId: true },
  });

  if (!display) {
    return { error: "Display not found", code: "DISPLAY_NOT_FOUND" };
  }

  if (display.status !== "CLAIMED") {
    return { error: "Display must be claimed before assigning a dashboard", code: "NOT_CLAIMED" };
  }

  const dashboard = await prisma.dashboard.findFirst({
    where: {
      id: dashboardId,
      site: {
        workspaceId,
      },
    },
    select: { id: true, deletedAt: true, siteId: true },
  });

  if (!dashboard || dashboard.deletedAt) {
    return { error: "Dashboard not found", code: "DASHBOARD_NOT_FOUND" };
  }

  if (dashboard.siteId !== display.siteId) {
    return { error: "Dashboard must belong to the display's site", code: "SITE_MISMATCH" };
  }

  const updated = await prisma.display.update({
    where: { id },
    data: { dashboardId },
    include: {
      site: { select: { id: true, name: true } },
      dashboard: {
        select: {
          id: true,
          name: true,
          description: true,
          spec: true,
          state: true,
        },
      },
    },
  });

  return { data: updated };
}

/**
 * Unassign dashboard from a display
 */
export async function unassignDashboard(workspaceId: string, id: string) {
  const display = await prisma.display.findFirst({
    where: {
      id,
      site: {
        workspaceId,
      },
    },
    select: { id: true },
  });

  if (!display) {
    return { error: "Display not found", code: "DISPLAY_NOT_FOUND" };
  }

  const updated = await prisma.display.update({
    where: { id },
    data: { dashboardId: null },
    include: {
      site: { select: { id: true, name: true } },
      dashboard: {
        select: { id: true, name: true },
      },
    },
  });

  return { data: updated };
}

/**
 * Update display (name, workcenter, station)
 */
export async function update(workspaceId: string, id: string, input: UpdateDisplayInput) {
  const { name, workcenterId, stationId } = input;

  const display = await prisma.display.findFirst({
    where: {
      id,
      site: {
        workspaceId,
      },
    },
    select: { id: true, siteId: true },
  });

  if (!display) {
    return { error: "Display not found", code: "DISPLAY_NOT_FOUND" };
  }

  if (!display.siteId) {
    return { error: "Display is not assigned to a site", code: "SITE_NOT_FOUND" };
  }

  if (workcenterId) {
    const workcenter = await prisma.workcenter.findFirst({
      where: {
        id: workcenterId,
        siteId: display.siteId,
      },
      select: { id: true },
    });

    if (!workcenter) {
      return { error: "Workcenter not found in display site", code: "WORKCENTER_NOT_FOUND" };
    }
  }

  if (stationId) {
    const station = await prisma.station.findFirst({
      where: {
        id: stationId,
        siteId: display.siteId,
      },
      select: { id: true },
    });

    if (!station) {
      return { error: "Station not found in display site", code: "STATION_NOT_FOUND" };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (workcenterId !== undefined) updateData.workcenterId = workcenterId;
  if (stationId !== undefined) updateData.stationId = stationId;

  const updated = await prisma.display.update({
    where: { id },
    data: updateData,
    include: {
      site: { select: { id: true, name: true } },
      dashboard: {
        select: { id: true, name: true },
      },
    },
  });

  return { data: updated };
}

/**
 * Remove a display (hard delete)
 */
export async function remove(workspaceId: string, id: string) {
  const display = await prisma.display.findFirst({
    where: {
      id,
      site: {
        workspaceId,
      },
    },
    select: { id: true },
  });

  if (!display) {
    return { error: "Display not found", code: "DISPLAY_NOT_FOUND" };
  }

  await prisma.display.delete({ where: { id } });

  return { success: true };
}

/**
 * Update lastSeenAt timestamp (called by display heartbeat, no auth)
 */
export async function heartbeat(id: string) {
  const display = await prisma.display.findUnique({
    where: { id },
    select: { id: true, status: true },
  });

  if (!display) {
    return { error: "Display not found", code: "DISPLAY_NOT_FOUND" };
  }

  await prisma.display.update({
    where: { id },
    data: { lastSeenAt: new Date() },
  });

  return { success: true };
}

export async function getClaimedDisplayForAuth(displayId: string) {
  const display = await prisma.display.findUnique({
    where: { id: displayId },
    select: {
      id: true,
      status: true,
      siteId: true,
      dashboardId: true,
      workcenterId: true,
      stationId: true,
      site: {
        select: {
          id: true,
          name: true,
          workspaceId: true,
        },
      },
    },
  });

  if (!display || display.status !== "CLAIMED" || !display.siteId || !display.site) {
    return null;
  }

  return display;
}
