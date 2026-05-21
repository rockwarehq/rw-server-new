import prisma from "@rw/db";
import type { Datasource, Point, PointGroup } from "@rw/db";

/**
 * Build the spec JSON for a gateway by aggregating all datasources, point groups, and points.
 * This is computed on-demand (not stored) to ensure single source of truth.
 */
export async function buildSpec(gatewayId: string) {
  const datasources = await prisma.datasource.findMany({
    where: {
      gatewayId,
      status: "ACTIVE", // Only sync ACTIVE datasources, exclude DRAFT
    },
    include: {
      pointGroups: {
        include: {
          points: true,
        },
      },
      points: {
        where: {
          groupId: null, // Only ungrouped points
        },
      },
    },
  });

  const spec = {
    datasources: datasources.map(
      (ds: Datasource & { pointGroups: (PointGroup & { points: Point[] })[]; points: Point[] }) => ({
        id: ds.id,
        name: ds.name,
        type: ds.type,
        driver: ds.driver,
        driverVersion: ds.driverVersion,
        connection: ds.connection,
        pointGroups: ds.pointGroups.map((pg: PointGroup & { points: Point[] }) => ({
          id: pg.id,
          name: pg.name,
          pollRateMs: pg.pollRateMs,
          config: pg.config,
          points: pg.points.map((p: Point) => ({
            id: p.id,
            name: p.name,
            address: p.address,
            dataType: p.dataType,
            scaleFactor: p.scaleFactor,
            offset: p.offset,
            config: p.config,
          })),
        })),
        points: ds.points.map((p: Point) => ({
          id: p.id,
          name: p.name,
          address: p.address,
          dataType: p.dataType,
          scaleFactor: p.scaleFactor,
          offset: p.offset,
          config: p.config,
        })),
      }),
    ),
  };

  return spec;
}

/**
 * Bump the spec version for a gateway.
 * Call this whenever datasources, point groups, or points change.
 * The actual spec is computed on-demand when the gateway requests it.
 */
export async function bumpSpecVersion(gatewayId: string) {
  const gateway = await prisma.gateway.update({
    where: { id: gatewayId },
    data: {
      specVersion: { increment: 1 },
      specUpdatedAt: new Date(),
    },
  });

  return {
    specVersion: gateway.specVersion,
    specUpdatedAt: gateway.specUpdatedAt,
  };
}

/**
 * Get the current spec version and computed spec for a gateway.
 * Used by sync endpoint and admin API.
 */
export async function getGatewaySpec(gatewayId: string) {
  const gateway = await prisma.gateway.findUnique({
    where: { id: gatewayId },
    select: { specVersion: true, specUpdatedAt: true },
  });

  if (!gateway) {
    return null;
  }

  const spec = await buildSpec(gatewayId);

  return {
    version: gateway.specVersion,
    updatedAt: gateway.specUpdatedAt,
    spec,
  };
}
