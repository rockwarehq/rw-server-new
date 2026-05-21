import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import prisma from "@rw/db";

export interface DriverManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  vendor?: string;
  category?: string;
  status?: string;
  connectionSchema: Record<string, unknown>;
  pointGroupSchema?: Record<string, unknown>;
  pointSchema?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  ui?: Record<string, unknown>;
}

export interface DriverInfo {
  name: string;
  version: string;
  manifest: DriverManifest;
}

class DriverRegistry {
  private drivers: Map<string, DriverInfo> = new Map();
  private driversPath: string;

  constructor(driversPath: string) {
    this.driversPath = driversPath;
  }

  /**
   * Load all driver manifests from the drivers directory
   */
  async loadAll(): Promise<void> {
    this.drivers.clear();

    let files: string[];
    try {
      files = await readdir(this.driversPath);
    } catch (_error) {
      console.warn(`Drivers directory not found: ${this.driversPath}`);
      return;
    }

    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    for (const file of jsonFiles) {
      try {
        const filePath = join(this.driversPath, file);
        const content = await readFile(filePath, "utf-8");
        const manifest = JSON.parse(content) as DriverManifest;

        if (!manifest.name || !manifest.version) {
          console.warn(`Skipping ${file}: missing name or version`);
          continue;
        }

        const key = this.makeKey(manifest.name, manifest.version);
        this.drivers.set(key, {
          name: manifest.name,
          version: manifest.version,
          manifest,
        });

        console.log(`Loaded driver: ${manifest.name}@${manifest.version}`);
      } catch (error) {
        console.error(`Failed to load driver ${file}:`, error);
      }
    }
  }

  /**
   * Sync loaded drivers to the database
   */
  async syncToDatabase(): Promise<void> {
    for (const driver of this.drivers.values()) {
      await prisma.driver.upsert({
        where: {
          name_version: {
            name: driver.name,
            version: driver.version,
          },
        },
        create: {
          name: driver.name,
          version: driver.version,
          manifest: driver.manifest as any,
        },
        update: {
          manifest: driver.manifest as any,
        },
      });
    }
  }

  /**
   * Initialize registry: load from files and sync to database
   */
  async initialize(): Promise<void> {
    await this.loadAll();
    await this.syncToDatabase();
    console.log(`Driver registry initialized with ${this.drivers.size} driver(s)`);
  }

  /**
   * List all available drivers
   */
  list(): DriverInfo[] {
    return Array.from(this.drivers.values());
  }

  /**
   * Get driver by name (returns latest version if no version specified)
   */
  get(name: string, version?: string): DriverInfo | undefined {
    if (version) {
      return this.drivers.get(this.makeKey(name, version));
    }

    // Find latest version of this driver
    const matching = Array.from(this.drivers.values()).filter((d) => d.name === name);
    if (matching.length === 0) return undefined;

    // Sort by version descending and return first (latest)
    return matching.sort((a, b) => this.compareVersions(b.version, a.version))[0];
  }

  /**
   * Check if a driver exists
   */
  has(name: string, version?: string): boolean {
    return this.get(name, version) !== undefined;
  }

  /**
   * Get the connection schema for a driver
   */
  getConnectionSchema(name: string, version?: string): Record<string, unknown> | undefined {
    const driver = this.get(name, version);
    return driver?.manifest.connectionSchema;
  }

  /**
   * Get the point schema for a driver
   */
  getPointSchema(name: string, version?: string): Record<string, unknown> | undefined {
    const driver = this.get(name, version);
    return driver?.manifest.pointSchema;
  }

  /**
   * Get the point group schema for a driver
   */
  getPointGroupSchema(name: string, version?: string): Record<string, unknown> | undefined {
    const driver = this.get(name, version);
    return driver?.manifest.pointGroupSchema;
  }

  private makeKey(name: string, version: string): string {
    return `${name}@${version}`;
  }

  private compareVersions(a: string, b: string): number {
    const partsA = a.split(".").map(Number);
    const partsB = b.split(".").map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const numA = partsA[i] || 0;
      const numB = partsB[i] || 0;
      if (numA !== numB) return numA - numB;
    }
    return 0;
  }
}

// Default instance using drivers directory relative to project root
const driversPath = join(process.cwd(), "drivers");
export const driverRegistry = new DriverRegistry(driversPath);

export default driverRegistry;
