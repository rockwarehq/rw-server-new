import prisma from "@rw/db";

export interface CreateStationInput {
  name: string;
  description?: string;
  attrs?: Record<string, unknown>;
  siteId: string;
  workcenterId?: string;
  // Config fields (stored on StationBlob)
  standardCycle?: number;
  downtimeDetect?: number;
  downtimeDetectUnit?: "SECONDS";
  slowDetect?: number;
  slowDetectUnit?: "PERCENTAGE";
  processTypeId?: string;
  inLineCalculations?: boolean;
  inStationCalculations?: boolean;
}

export interface UpdateStationInput {
  name?: string;
  description?: string;
  attrs?: Record<string, unknown>;
  // Config fields (stored on StationBlob)
  standardCycle?: number | null;
  downtimeDetect?: number | null;
  downtimeDetectUnit?: "SECONDS";
  slowDetect?: number | null;
  slowDetectUnit?: "PERCENTAGE";
  processTypeId?: string | null;
  inLineCalculations?: boolean;
  inStationCalculations?: boolean;
}

export interface ListStationsFilter {
  workspaceId?: string;
  siteId?: string;
  siteIds?: string[];
  workcenterId?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

// Common include for all station queries
const stationInclude = {
  site: {
    select: { id: true, name: true, workspaceId: true },
  },
  workcenter: {
    select: { id: true, name: true },
  },
  currentBlob: true,
  currentJob: {
    select: {
      id: true,
      currentBlob: { select: { name: true } },
    },
  },
};

/** Config field keys that belong on StationBlob */
const BLOB_FIELDS = [
  "standardCycle",
  "downtimeDetect",
  "downtimeDetectUnit",
  "slowDetect",
  "slowDetectUnit",
  "processTypeId",
  "inLineCalculations",
  "inStationCalculations",
] as const;

/** Check if any blob config fields are provided in input */
function hasBlobFields(input: Record<string, unknown>): boolean {
  return BLOB_FIELDS.some((key) => input[key] !== undefined);
}

/**
 * Create a new station
 */
export async function create(input: CreateStationInput) {
  const {
    name,
    description,
    attrs,
    siteId,
    workcenterId,
    standardCycle,
    downtimeDetect,
    downtimeDetectUnit,
    slowDetect,
    slowDetectUnit,
    processTypeId,
    inLineCalculations,
    inStationCalculations,
  } = input;

  // Validate site exists
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // If workcenterId is provided, validate it exists and belongs to the same site
  if (workcenterId) {
    const workcenter = await prisma.workcenter.findUnique({
      where: { id: workcenterId },
      select: { id: true, siteId: true },
    });

    if (!workcenter) {
      return { error: "Workcenter not found", code: "WORKCENTER_NOT_FOUND" };
    }

    if (workcenter.siteId !== siteId) {
      return {
        error: "Workcenter does not belong to the specified site",
        code: "SITE_MISMATCH",
      };
    }
  }

  // If process type specified, validate it
  if (processTypeId) {
    const pt = await prisma.processType.findUnique({
      where: { id: processTypeId },
      select: { id: true, siteId: true, deletedAt: true },
    });

    if (!pt || pt.deletedAt) {
      return { error: "Process type not found", code: "PROCESS_TYPE_NOT_FOUND" };
    }

    if (pt.siteId !== siteId) {
      return { error: "Process type must belong to the same site", code: "SITE_MISMATCH" };
    }
  }

  const wantBlob = hasBlobFields(input as unknown as Record<string, unknown>);

  if (wantBlob) {
    // 3-step transaction: create station -> create blob v1 -> link blob
    const station = await prisma.$transaction(async (tx) => {
      // 1. Create station entity
      const s = await tx.station.create({
        data: {
          name,
          description,
          attrs: attrs ?? {},
          siteId,
          workcenterId: workcenterId ?? null,
        },
      });

      // 2. Create initial StationBlob (version 1)
      const blob = await tx.stationBlob.create({
        data: {
          stationId: s.id,
          version: 1,
          standardCycle: standardCycle ?? null,
          downtimeDetect: downtimeDetect ?? null,
          downtimeDetectUnit: downtimeDetectUnit ?? "SECONDS",
          slowDetect: slowDetect ?? null,
          slowDetectUnit: slowDetectUnit ?? "PERCENTAGE",
          processTypeId: processTypeId ?? null,
          inLineCalculations: inLineCalculations ?? false,
          inStationCalculations: inStationCalculations ?? false,
        },
      });

      // 3. Link blob as current and return with includes
      return tx.station.update({
        where: { id: s.id },
        data: { currentBlobId: blob.id },
        include: stationInclude,
      });
    });

    return { data: station };
  }

  // No config fields — simple create without blob
  const station = await prisma.station.create({
    data: {
      name,
      description,
      attrs: attrs ?? {},
      siteId,
      workcenterId: workcenterId ?? null,
    },
    include: stationInclude,
  });

  return { data: station };
}

/**
 * List stations with optional filtering
 */
export async function list(filter: ListStationsFilter = {}) {
  const { workspaceId, siteId, siteIds, workcenterId, name, limit = 50, offset = 0 } = filter;

  if (siteIds && siteIds.length === 0) {
    return { data: [], total: 0, limit: Number(limit), offset: Number(offset) };
  }

  const where: Record<string, unknown> = {};

  if (workspaceId) {
    where.site = { workspaceId };
  }

  if (siteId) {
    where.siteId = siteId;
  } else if (siteIds) {
    where.siteId = { in: siteIds };
  }

  if (workcenterId) {
    where.workcenterId = workcenterId;
  }

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  }

  const [stations, total] = await Promise.all([
    prisma.station.findMany({
      where,
      include: stationInclude,
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { name: "asc" },
    }),
    prisma.station.count({ where }),
  ]);

  return {
    data: stations,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get station by ID with related entities
 */
export async function getById(id: string, workspaceId?: string) {
  const station = await prisma.station.findUnique({
    where: { id },
    include: stationInclude,
  });

  if (!station) {
    return null;
  }

  // Validate workspace access
  if (workspaceId && station.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  return { data: station };
}

/**
 * Update station (creates new blob version if config fields change)
 */
export async function update(id: string, input: UpdateStationInput, workspaceId?: string) {
  const {
    name,
    description,
    attrs,
    standardCycle,
    downtimeDetect,
    downtimeDetectUnit,
    slowDetect,
    slowDetectUnit,
    processTypeId,
    inLineCalculations,
    inStationCalculations,
  } = input;

  // Get current station with workspace info and current blob
  const current = await prisma.station.findUnique({
    where: { id },
    include: {
      site: { select: { workspaceId: true } },
      currentBlob: true,
    },
  });

  if (!current) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && current.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  // Validate process type if changing
  if (processTypeId !== undefined && processTypeId !== null) {
    const pt = await prisma.processType.findUnique({
      where: { id: processTypeId },
      select: { id: true, siteId: true, deletedAt: true },
    });

    if (!pt || pt.deletedAt) {
      return { error: "Process type not found", code: "PROCESS_TYPE_NOT_FOUND" };
    }

    if (pt.siteId !== current.siteId) {
      return { error: "Process type must belong to the same site", code: "SITE_MISMATCH" };
    }
  }

  // Build station entity update (name, description, attrs)
  const stationUpdateData: Record<string, unknown> = {};
  if (name !== undefined) stationUpdateData.name = name;
  if (description !== undefined) stationUpdateData.description = description;
  if (attrs !== undefined) stationUpdateData.attrs = attrs;

  // Check if any blob config fields are being updated
  const blobInput = {
    standardCycle,
    downtimeDetect,
    downtimeDetectUnit,
    slowDetect,
    slowDetectUnit,
    processTypeId,
    inLineCalculations,
    inStationCalculations,
  };
  const wantBlobUpdate = hasBlobFields(blobInput as unknown as Record<string, unknown>);

  if (wantBlobUpdate) {
    // Create new blob version with merged data
    const latestBlob = await prisma.stationBlob.findFirst({
      where: { stationId: id },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    const nextVersion = (latestBlob?.version ?? 0) + 1;
    const oldBlob = current.currentBlob;

    const station = await prisma.$transaction(async (tx) => {
      // 1. Create new blob version
      const blob = await tx.stationBlob.create({
        data: {
          stationId: id,
          version: nextVersion,
          standardCycle: standardCycle !== undefined ? standardCycle : (oldBlob?.standardCycle ?? null),
          downtimeDetect: downtimeDetect !== undefined ? downtimeDetect : (oldBlob?.downtimeDetect ?? null),
          downtimeDetectUnit:
            downtimeDetectUnit !== undefined ? downtimeDetectUnit : (oldBlob?.downtimeDetectUnit ?? "SECONDS"),
          slowDetect: slowDetect !== undefined ? slowDetect : (oldBlob?.slowDetect ?? null),
          slowDetectUnit: slowDetectUnit !== undefined ? slowDetectUnit : (oldBlob?.slowDetectUnit ?? "PERCENTAGE"),
          processTypeId: processTypeId !== undefined ? processTypeId : (oldBlob?.processTypeId ?? null),
          inLineCalculations:
            inLineCalculations !== undefined ? inLineCalculations : (oldBlob?.inLineCalculations ?? false),
          inStationCalculations:
            inStationCalculations !== undefined ? inStationCalculations : (oldBlob?.inStationCalculations ?? false),
        },
      });

      // 2. Update station: entity fields + swing blob pointer
      return tx.station.update({
        where: { id },
        data: {
          ...stationUpdateData,
          currentBlobId: blob.id,
        },
        include: stationInclude,
      });
    });

    return { data: station };
  }

  // No config changes — simple station entity update
  const station = await prisma.station.update({
    where: { id },
    data: stationUpdateData,
    include: stationInclude,
  });

  return { data: station };
}

/**
 * Move station to a different workcenter or directly under the site
 * @param newWorkcenterId - The target workcenter ID, or null to move directly under the site
 */
export async function move(id: string, newWorkcenterId: string | null, workspaceId?: string) {
  const current = await prisma.station.findUnique({
    where: { id },
    include: {
      site: {
        select: { id: true, workspaceId: true },
      },
    },
  });

  if (!current) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && current.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  // If moving to a workcenter, validate it exists and is in the same site
  if (newWorkcenterId !== null) {
    const newWorkcenter = await prisma.workcenter.findUnique({
      where: { id: newWorkcenterId },
      select: {
        id: true,
        siteId: true,
      },
    });

    if (!newWorkcenter) {
      return { error: "Workcenter not found", code: "WORKCENTER_NOT_FOUND" };
    }

    // Must be in same site
    if (newWorkcenter.siteId !== current.siteId) {
      return {
        error: "Cannot move station to a workcenter in a different site",
        code: "SITE_MISMATCH",
      };
    }
  }

  const station = await prisma.station.update({
    where: { id },
    data: { workcenterId: newWorkcenterId },
    include: stationInclude,
  });

  return { data: station };
}

/**
 * Delete station (cascades statusLogs and stationDatasources)
 */
export async function remove(id: string, workspaceId?: string) {
  const station = await prisma.station.findUnique({
    where: { id },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!station) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && station.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  await prisma.station.delete({ where: { id } });

  return { success: true };
}

/**
 * Check if station exists
 */
export async function exists(id: string) {
  const station = await prisma.station.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!station;
}

/**
 * Add one or more datasources to a station
 * Validates all belong to the same site
 * Uses transaction for all-or-nothing behavior
 */
export async function addDatasource(stationId: string, datasourceIds: string | string[], workspaceId?: string) {
  // Normalize to array
  const ids = Array.isArray(datasourceIds) ? datasourceIds : [datasourceIds];

  if (ids.length === 0) {
    return { error: "At least one datasource ID is required", code: "INVALID_INPUT" };
  }

  // Get station with site info
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    include: {
      site: {
        select: { id: true, workspaceId: true },
      },
    },
  });

  if (!station) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && station.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  // Get all datasources with site info
  const datasources = await prisma.datasource.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      type: true,
      driver: true,
      siteId: true,
    },
  });

  // Check all datasources exist
  if (datasources.length !== ids.length) {
    const foundIds = new Set(datasources.map((d) => d.id));
    const missingIds = ids.filter((id) => !foundIds.has(id));
    return {
      error: `Datasource(s) not found: ${missingIds.join(", ")}`,
      code: "DATASOURCE_NOT_FOUND",
    };
  }

  // Validate all datasources belong to the same site
  const wrongSiteDatasources = datasources.filter((d) => d.siteId !== station.siteId);
  if (wrongSiteDatasources.length > 0) {
    return {
      error: `Datasource(s) must belong to the same site as the station: ${wrongSiteDatasources.map((d) => d.name).join(", ")}`,
      code: "SITE_MISMATCH",
    };
  }

  // Check if any are already linked
  const existingLinks = await prisma.stationDatasource.findMany({
    where: {
      stationId,
      datasourceId: { in: ids },
    },
    select: {
      datasourceId: true,
      datasource: { select: { name: true } },
    },
  });

  if (existingLinks.length > 0) {
    const alreadyLinkedNames = existingLinks.map((l: (typeof existingLinks)[number]) => l.datasource.name);
    return {
      error: `Datasource(s) already linked to this station: ${alreadyLinkedNames.join(", ")}`,
      code: "ALREADY_LINKED",
    };
  }

  // Create all links in a transaction
  const links = await prisma.$transaction(
    ids.map((datasourceId) =>
      prisma.stationDatasource.create({
        data: {
          stationId,
          datasourceId,
        },
        include: {
          datasource: {
            select: {
              id: true,
              name: true,
              type: true,
              driver: true,
              status: true,
            },
          },
        },
      }),
    ),
  );

  return { data: links };
}

/**
 * Remove a datasource from a station
 */
export async function removeDatasource(stationId: string, datasourceId: string, workspaceId?: string) {
  // Get station with workspace info
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!station) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && station.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  // Find the link
  const link = await prisma.stationDatasource.findUnique({
    where: {
      stationId_datasourceId: {
        stationId,
        datasourceId,
      },
    },
  });

  if (!link) {
    return { error: "Datasource is not linked to this station", code: "LINK_NOT_FOUND" };
  }

  // Delete the link
  await prisma.stationDatasource.delete({
    where: { id: link.id },
  });

  return { success: true };
}

/**
 * List all datasources linked to a station
 */
export async function listDatasources(stationId: string, workspaceId?: string) {
  // Get station with workspace info
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!station) {
    return { error: "Station not found", code: "STATION_NOT_FOUND" };
  }

  // Validate workspace access
  if (workspaceId && station.site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  // Get all linked datasources
  const links = await prisma.stationDatasource.findMany({
    where: { stationId },
    include: {
      datasource: {
        select: {
          id: true,
          name: true,
          type: true,
          driver: true,
          driverVersion: true,
          status: true,
          gatewayId: true,
          gateway: {
            select: { id: true, name: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    data: links.map((link: (typeof links)[number]) => ({
      ...link.datasource,
      linkedAt: link.createdAt,
    })),
  };
}
