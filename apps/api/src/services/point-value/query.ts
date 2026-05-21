import prisma from "@rw/db";

export interface PointSnapshot {
  pointId: string;
  quality: "GOOD" | "BAD" | "UNKNOWN";
  value: number | null;
  valueRaw: unknown;
  previousValue: number | null;
  previousValueRaw: unknown;
  timestamp: string;
  gatewayTimestamp: string;
  processorTimestamp: string;
}

export type ValidatePointWorkspaceAccessResult =
  | {
      success: true;
    }
  | {
      success: false;
      code: "POINTS_NOT_FOUND" | "WORKSPACE_MISMATCH";
      error: string;
      pointIds: string[];
    };

export type ValidatePointSiteAccessResult =
  | {
      success: true;
    }
  | {
      success: false;
      code: "POINTS_NOT_FOUND" | "SITE_MISMATCH";
      error: string;
      pointIds: string[];
    };

function uniquePointIds(pointIds: string[]): string[] {
  return Array.from(new Set(pointIds));
}

export async function validatePointWorkspaceAccess(
  pointIds: string[],
  workspaceId: string,
): Promise<ValidatePointWorkspaceAccessResult> {
  const requestedPointIds = uniquePointIds(pointIds);

  if (requestedPointIds.length === 0) {
    return { success: true };
  }

  const points = await prisma.point.findMany({
    where: {
      id: {
        in: requestedPointIds,
      },
    },
    select: {
      id: true,
      datasource: {
        select: {
          site: {
            select: {
              workspaceId: true,
            },
          },
        },
      },
    },
  });

  const foundPointIds = new Set(points.map((point) => point.id));

  const forbiddenPointIds = points
    .filter((point) => point.datasource.site?.workspaceId !== workspaceId)
    .map((point) => point.id);

  if (forbiddenPointIds.length > 0) {
    return {
      success: false,
      code: "WORKSPACE_MISMATCH",
      error: "One or more points do not belong to this workspace",
      pointIds: forbiddenPointIds,
    };
  }

  const missingPointIds = requestedPointIds.filter((pointId) => !foundPointIds.has(pointId));
  if (missingPointIds.length > 0) {
    return {
      success: false,
      code: "POINTS_NOT_FOUND",
      error: "One or more points were not found",
      pointIds: missingPointIds,
    };
  }

  return { success: true };
}

export async function validatePointSiteAccess(
  pointIds: string[],
  siteId: string,
): Promise<ValidatePointSiteAccessResult> {
  const requestedPointIds = uniquePointIds(pointIds);

  if (requestedPointIds.length === 0) {
    return { success: true };
  }

  const points = await prisma.point.findMany({
    where: {
      id: {
        in: requestedPointIds,
      },
    },
    select: {
      id: true,
      datasource: {
        select: {
          siteId: true,
        },
      },
    },
  });

  const foundPointIds = new Set(points.map((point) => point.id));

  const forbiddenPointIds = points.filter((point) => point.datasource.siteId !== siteId).map((point) => point.id);

  if (forbiddenPointIds.length > 0) {
    return {
      success: false,
      code: "SITE_MISMATCH",
      error: "One or more points do not belong to this site",
      pointIds: forbiddenPointIds,
    };
  }

  const missingPointIds = requestedPointIds.filter((pointId) => !foundPointIds.has(pointId));
  if (missingPointIds.length > 0) {
    return {
      success: false,
      code: "POINTS_NOT_FOUND",
      error: "One or more points were not found",
      pointIds: missingPointIds,
    };
  }

  return { success: true };
}

export async function getLatestPointSnapshots(pointIds: string[]): Promise<Record<string, PointSnapshot>> {
  const requestedPointIds = uniquePointIds(pointIds);

  if (requestedPointIds.length === 0) {
    return {};
  }

  const pointValues = await prisma.pointValue.findMany({
    where: {
      pointId: {
        in: requestedPointIds,
      },
    },
    orderBy: [{ pointId: "asc" }, { timestamp: "desc" }],
    distinct: ["pointId"],
    select: {
      pointId: true,
      quality: true,
      value: true,
      valueRaw: true,
      previousValue: true,
      previousValueRaw: true,
      timestamp: true,
      gatewayTimestamp: true,
      processorTimestamp: true,
    },
  });

  const snapshots: Record<string, PointSnapshot> = {};

  for (const pointValue of pointValues) {
    snapshots[pointValue.pointId] = {
      pointId: pointValue.pointId,
      quality: pointValue.quality,
      value: pointValue.value,
      valueRaw: pointValue.valueRaw,
      previousValue: pointValue.previousValue,
      previousValueRaw: pointValue.previousValueRaw,
      timestamp: pointValue.timestamp.toISOString(),
      gatewayTimestamp: pointValue.gatewayTimestamp.toISOString(),
      processorTimestamp: pointValue.processorTimestamp.toISOString(),
    };
  }

  return snapshots;
}
