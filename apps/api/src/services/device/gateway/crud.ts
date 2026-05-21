import { customAlphabet } from "nanoid";
import prisma from "@rw/db";

// Alphabet without ambiguous chars (0,1,I,L,O)
const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const generateSerial = customAlphabet(alphabet, 8);
const generateClaimCode = customAlphabet(alphabet, 6);

function generateSerialNumber() {
  const id = generateSerial();
  return `RW-GW-${id.slice(0, 4)}-${id.slice(4)}`;
}

export interface CreateGatewayInput {
  name: string;
  description?: string;
  hosting?: "SELF" | "ROCKWARE";
  metadata?: Record<string, unknown>;
  siteId: string;
  workspaceId: string;
}

export interface UpdateGatewayInput {
  name?: string;
  description?: string;
  hosting?: "SELF" | "ROCKWARE";
  metadata?: Record<string, unknown>;
  siteId?: string;
  workspaceId?: string;
}

export interface ListGatewaysFilter {
  siteId?: string;
  workspaceId?: string;
}

export async function create(input: CreateGatewayInput) {
  const { name, description, hosting, metadata, siteId, workspaceId } = input;

  // Validate site exists and belongs to workspace
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  if (site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  // Generate unique serial number
  let serialNumber = "";
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    serialNumber = generateSerialNumber();
    const existing = await prisma.gateway.findUnique({
      where: { serialNumber },
    });
    if (!existing) break;
    attempts++;
  }

  if (attempts >= maxAttempts) {
    throw new Error("Failed to generate unique serial number");
  }

  const claimCode = generateClaimCode();

  const gateway = await prisma.gateway.create({
    data: {
      name,
      description,
      serialNumber,
      claimCode,
      hosting: hosting || "SELF",
      metadata: metadata ?? {},
      siteId,
    },
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
    },
  });

  return { data: gateway };
}

export async function list(filter?: ListGatewaysFilter) {
  const where: Record<string, unknown> = {};

  if (filter?.siteId) {
    where.siteId = filter.siteId;
  }

  // Filter by workspace - gateways at Sites belonging to this workspace
  if (filter?.workspaceId) {
    where.site = {
      workspaceId: filter.workspaceId,
    };
  }

  return prisma.gateway.findMany({
    where,
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getById(id: string, workspaceId?: string) {
  const gateway = await prisma.gateway.findUnique({
    where: { id },
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
      datasources: true,
      tokens: {
        select: {
          id: true,
          name: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
          lastUsed: true,
        },
      },
    },
  });

  if (!gateway) return null;

  // Validate workspace access via site
  if (workspaceId && gateway.site?.workspaceId && gateway.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  return { data: gateway };
}

export async function getBySerialNumber(serialNumber: string) {
  return prisma.gateway.findUnique({
    where: { serialNumber },
  });
}

export async function update(id: string, input: UpdateGatewayInput) {
  const { name, description, hosting, metadata, siteId, workspaceId } = input;

  // Get current gateway with site info
  const current = await prisma.gateway.findUnique({
    where: { id },
    include: {
      site: {
        select: { id: true, workspaceId: true },
      },
    },
  });

  if (!current) {
    return { error: "Gateway not found", code: "GATEWAY_NOT_FOUND" };
  }

  // Validate workspace access via site
  if (workspaceId && current.site?.workspaceId && current.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  // If changing site, validate new site
  if (siteId && siteId !== current.siteId) {
    const newSite = await prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, workspaceId: true },
    });

    if (!newSite) {
      return { error: "Site not found", code: "SITE_NOT_FOUND" };
    }

    // New site must be in same workspace
    if (workspaceId && newSite.workspaceId !== workspaceId) {
      return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (hosting !== undefined) updateData.hosting = hosting;
  if (metadata !== undefined) updateData.metadata = metadata;
  if (siteId !== undefined) updateData.siteId = siteId;

  const gateway = await prisma.gateway.update({
    where: { id },
    data: updateData,
    include: {
      site: {
        select: { id: true, name: true, workspaceId: true },
      },
    },
  });

  return { data: gateway };
}

export async function remove(id: string, workspaceId?: string) {
  const gateway = await prisma.gateway.findUnique({
    where: { id },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!gateway) {
    return { error: "Gateway not found", code: "GATEWAY_NOT_FOUND" };
  }

  // Validate workspace access via site
  if (workspaceId && gateway.site?.workspaceId && gateway.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  await prisma.gateway.delete({ where: { id } });
  return { success: true };
}

export async function exists(id: string) {
  const gateway = await prisma.gateway.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!gateway;
}

export async function updateStatus(
  id: string,
  status: "PROVISIONED" | "ONLINE" | "OFFLINE" | "DISABLED",
  data?: {
    lastHeartbeat?: Date;
    health?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
) {
  return prisma.gateway.update({
    where: { id },
    data: {
      status,
      ...data,
    },
  });
}
