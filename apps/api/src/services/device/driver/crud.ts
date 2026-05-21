import prisma from "@rw/db";
import type { Driver } from "@rw/db";

export interface DriverSummary {
  [x: string]: unknown;
  id: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  vendor?: string;
  category?: string;
}

export interface ListDriversFilter {
  name?: string;
  version?: string;
}

/**
 * List drivers from database with optional filtering
 */
export async function list(filter: ListDriversFilter = {}): Promise<DriverSummary[]> {
  const { name, version } = filter;

  const where: Record<string, unknown> = {};
  if (name) {
    where.name = name;
  }
  if (version) {
    where.version = version;
  }

  const drivers = await prisma.driver.findMany({
    where,
    orderBy: [{ name: "asc" }, { version: "desc" }],
  });

  // Return summary info (extract from manifest)
  return drivers.map((d: Driver) => {
    const manifest = d.manifest as Record<string, unknown>;
    return {
      id: d.id,
      name: d.name,
      version: d.version,
      displayName: manifest.displayName as string | undefined,
      description: manifest.description as string | undefined,
      vendor: manifest.vendor as string | undefined,
      category: manifest.category as string | undefined,
    };
  });
}

/**
 * Get driver by ID
 */
export async function getById(id: string) {
  return prisma.driver.findUnique({
    where: { id },
  });
}

/**
 * Get driver by name and version
 */
export async function getByNameVersion(name: string, version: string) {
  return prisma.driver.findUnique({
    where: {
      name_version: { name, version },
    },
  });
}

/**
 * Get driver schemas by ID
 */
export async function getSchemas(id: string) {
  const driver = await prisma.driver.findUnique({
    where: { id },
  });

  if (!driver) {
    return null;
  }

  const manifest = driver.manifest as Record<string, unknown>;

  return {
    connectionSchema: manifest.connectionSchema as Record<string, unknown>,
    pointSchema: (manifest.pointSchema as Record<string, unknown>) || null,
    pointGroupSchema: (manifest.pointGroupSchema as Record<string, unknown>) || null,
  };
}

/**
 * Check if driver exists by ID
 */
export async function exists(id: string) {
  const driver = await prisma.driver.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!driver;
}
