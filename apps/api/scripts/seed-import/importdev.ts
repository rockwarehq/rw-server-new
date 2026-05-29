import "dotenv/config";
import { createInterface } from "node:readline/promises";
import bcrypt from "bcrypt";
import prisma from "@rw/db";
import { findSystemRole } from "@rw/services/iam/roles";
import { seedSystemRoles } from "./systemRoles.js";
import config from "./config.js";
import { IdMap, setDataFile, setDevSeed } from "./utils.js";
import { importProcessTypes } from "./importProcessTypes.js";
import { importWorkcenters } from "./importWorkcenters.js";
import { importProducts } from "./importProducts.js";
import { importMaterials } from "./importMaterials.js";
import { importProductMaterials } from "./importProductMaterials.js";
import { importTools } from "./importTools.js";
import { importToolCavities } from "./importToolCavities.js";
import { importJobs } from "./importJobs.js";
import { importStations } from "./importStations.js";
import { importJobProducts } from "./importJobProducts.js";
import { importStatusCategories } from "./importStatusCategories.js";
import { importStatusReasons } from "./importStatusReasons.js";
import { importItemDispositions } from "./importItemDispositions.js";
import { importItemDispositionReasons } from "./importItemDispositionReasons.js";
import { driverRegistry } from "../../src/services/device/driver/registry.js";
import * as datasourceSvc from "../../src/services/device/datasource/index.js";
import * as gatewaySvc from "@rw/services/device/gateway/index";

const SALT_ROUNDS = 10;

const DEFAULT_ROLES = ["Operator", "Supervisor", "Lead", "Quality", "Maintenance", "Contractor", "Engineer", "Manager"];

type SystemRoleName = "Company Administrator" | "Factory Administrator" | "Office User" | "Read-only User";
type SiteKey = "primary" | "secondary";

interface RoleAssignmentSpec {
  roleName: SystemRoleName;
  scope: "WORKSPACE" | "SITE";
  site?: SiteKey;
}

interface CustomerDevUser {
  email: string;
  firstName: string;
  lastName: string;
  persona: string;
  description: string;
  status?: "ACTIVE" | "DISABLED";
  createMembership?: boolean;
  assignments: readonly RoleAssignmentSpec[];
}

const CUSTOMER_DEV_USERS: readonly CustomerDevUser[] = [
  {
    email: "factory@example.com",
    firstName: "Factory",
    lastName: "Administrator",
    persona: "Factory Administrator",
    description: "Local factory administrator with full access to production data and site configuration.",
    assignments: [{ roleName: "Factory Administrator", scope: "SITE", site: "primary" }],
  },
  {
    email: "office@example.com",
    firstName: "Office",
    lastName: "User",
    persona: "Office User",
    description: "Production office user who can work with schedules, jobs, products, tools, and facility data for the site.",
    assignments: [{ roleName: "Office User", scope: "SITE", site: "primary" }],
  },
  {
    email: "readonly@example.com",
    firstName: "Read-only",
    lastName: "User",
    persona: "Read-only User",
    description: "Analytics and reporting user with read-only access to production data for the site.",
    assignments: [{ roleName: "Read-only User", scope: "SITE", site: "primary" }],
  },
  {
    email: "coadmin@example.com",
    firstName: "Co",
    lastName: "Administrator",
    persona: "Co-Administrator",
    description: "Second workspace-level admin for testing multi-admin scenarios (mutual disable, ownership transfer).",
    assignments: [{ roleName: "Company Administrator", scope: "WORKSPACE" }],
  },
  {
    email: "norole@example.com",
    firstName: "No",
    lastName: "Role",
    persona: "Member without Role",
    description: "Active workspace member with no role assignment — verifies permission denial for half-onboarded users.",
    assignments: [],
  },
  {
    email: "nomember@example.com",
    firstName: "No",
    lastName: "Member",
    persona: "User without Membership",
    description: "Active user with no workspace membership — verifies login rejection at the membership check.",
    createMembership: false,
    assignments: [],
  },
  {
    email: "disabled@example.com",
    firstName: "Disabled",
    lastName: "User",
    persona: "Disabled Office User",
    description: "Office user with DISABLED status — verifies login rejection and session revocation for disabled accounts.",
    status: "DISABLED",
    assignments: [{ roleName: "Office User", scope: "SITE", site: "primary" }],
  },
  {
    email: "engineer@example.com",
    firstName: "Engineer",
    lastName: "User",
    persona: "Site B Factory Administrator",
    description: "Factory administrator on the secondary site only — verifies cross-site isolation.",
    assignments: [{ roleName: "Factory Administrator", scope: "SITE", site: "secondary" }],
  },
  {
    email: "mixed@example.com",
    firstName: "Mixed",
    lastName: "Roles",
    persona: "Multi-site User",
    description: "Office User on the primary site and Read-only User on the secondary site — tests per-site role differentiation.",
    assignments: [
      { roleName: "Office User", scope: "SITE", site: "primary" },
      { roleName: "Read-only User", scope: "SITE", site: "secondary" },
    ],
  },
];

async function upsertSeedUser(input: {
  email: string;
  firstName: string;
  lastName?: string;
  passwordHash: string;
  systemRole?: "SUPPORT";
  status?: "ACTIVE" | "DISABLED";
}) {
  const status = input.status ?? "ACTIVE";
  return prisma.user.upsert({
    where: { email: input.email },
    update: {
      passwordHash: input.passwordHash,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      status,
      systemRole: input.systemRole ?? null,
    },
    create: {
      email: input.email,
      passwordHash: input.passwordHash,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      status,
      systemRole: input.systemRole ?? null,
    },
  });
}

async function setRoleAssignments(input: {
  membershipId: string;
  workspaceId: string;
  siteIds: Record<SiteKey, string>;
  assignments: readonly RoleAssignmentSpec[];
}) {
  await prisma.roleAssignment.deleteMany({ where: { membershipId: input.membershipId } });
  for (const a of input.assignments) {
    if (a.scope === "SITE" && !a.site) {
      throw new Error(`${a.roleName} requires a site key`);
    }
    const role = await findSystemRole(input.workspaceId, a.roleName, a.scope);
    if (!role) {
      throw new Error(`${a.roleName} system role missing for workspace ${input.workspaceId}`);
    }
    await prisma.roleAssignment.create({
      data: {
        membershipId: input.membershipId,
        roleId: role.id,
        siteId: a.scope === "SITE" ? input.siteIds[a.site as SiteKey] : null,
      },
    });
  }
}

function describeAssignments(spec: CustomerDevUser): string {
  if (spec.createMembership === false) return "No workspace membership";
  if (spec.assignments.length === 0) return "Member, no role";
  const parts = spec.assignments.map((a) =>
    a.scope === "WORKSPACE" ? `Workspace ${a.roleName}` : `Site ${a.site} ${a.roleName}`,
  );
  const summary = parts.join(" + ");
  return spec.status === "DISABLED" ? `${summary} (DISABLED)` : summary;
}

async function seedDevAccess(
  workspaceId: string,
  siteIds: Record<SiteKey, string>,
  adminEmail: string,
  passwordHash: string,
) {
  const seededUsers: Array<{ email: string; persona: string; description: string; access: string }> = [];

  const admin = await upsertSeedUser({
    email: adminEmail,
    passwordHash,
    firstName: "Company",
    lastName: "Administrator",
  });
  const adminMembership = await prisma.workspaceMembership.upsert({
    where: { userId_workspaceId: { userId: admin.id, workspaceId } },
    update: {},
    create: { userId: admin.id, workspaceId },
  });
  await setRoleAssignments({
    membershipId: adminMembership.id,
    workspaceId,
    siteIds,
    assignments: [{ roleName: "Company Administrator", scope: "WORKSPACE" }],
  });
  seededUsers.push({
    email: admin.email,
    persona: "Company Administrator",
    description: "Company-level administrator with billing visibility and full operational access across all sites.",
    access: "Workspace Company Administrator",
  });

  for (const userSpec of CUSTOMER_DEV_USERS) {
    const user = await upsertSeedUser({
      email: userSpec.email,
      passwordHash,
      firstName: userSpec.firstName,
      lastName: userSpec.lastName,
      status: userSpec.status,
    });

    if (userSpec.createMembership === false) {
      await prisma.workspaceMembership.deleteMany({ where: { userId: user.id } });
    } else {
      const membership = await prisma.workspaceMembership.upsert({
        where: { userId_workspaceId: { userId: user.id, workspaceId } },
        update: {},
        create: { userId: user.id, workspaceId },
      });
      await setRoleAssignments({
        membershipId: membership.id,
        workspaceId,
        siteIds,
        assignments: userSpec.assignments,
      });
    }

    seededUsers.push({
      email: user.email,
      persona: userSpec.persona,
      description: userSpec.description,
      access: describeAssignments(userSpec),
    });
  }

  const support = await upsertSeedUser({
    email: "admin@rw.com",
    passwordHash,
    firstName: "Rockware",
    lastName: "Support",
    systemRole: "SUPPORT",
  });
  await prisma.workspaceMembership.deleteMany({ where: { userId: support.id } });
  seededUsers.push({
    email: support.email,
    persona: "Rockware Support Admin",
    description: "Internal Rockware support account for system-role testing; no customer workspace membership.",
    access: "System SUPPORT",
  });

  return seededUsers;
}

async function bootstrap() {
  console.log("── Bootstrap ────────────────────────────────────────────");

  const workspace = await prisma.workspace.upsert({
    where: { slug: "default" },
    update: {},
    create: { name: "Default", slug: "default", description: "Default workspace", isDefault: true },
  });
  console.log(`  Workspace: ${workspace.name} (${workspace.id})`);

  await seedSystemRoles(workspace.id);

  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  const devUserPassword = process.env.DEV_USER_PASSWORD || process.env.ADMIN_PASSWORD || "changeme123";
  const passwordHash = await bcrypt.hash(devUserPassword, SALT_ROUNDS);

  const site = await prisma.site.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: config.siteName } },
    update: {},
    create: { name: config.siteName, workspaceId: workspace.id, timezone: "America/New_York" },
  });
  console.log(`  Site (primary): ${site.name} (${site.id})`);

  const secondarySite = await prisma.site.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: "Test Site B" } },
    update: {},
    create: { name: "Test Site B", workspaceId: workspace.id, timezone: "America/New_York" },
  });
  console.log(`  Site (secondary): ${secondarySite.name} (${secondarySite.id})`);

  for (const roleName of DEFAULT_ROLES) {
    await prisma.employeeRole.upsert({
      where: { siteId_name: { siteId: site.id, name: roleName } },
      update: {},
      create: { siteId: site.id, name: roleName },
    });
  }
  console.log(`  Employee roles: ${DEFAULT_ROLES.length} seeded`);

  const seededUsers = await seedDevAccess(
    workspace.id,
    { primary: site.id, secondary: secondarySite.id },
    adminEmail,
    passwordHash,
  );
  console.log(`  RBAC dev users: ${seededUsers.length} seeded`);
  console.log(`  Dev user password: ${devUserPassword}`);
  for (const seededUser of seededUsers) {
    console.log(`    ${seededUser.email} — ${seededUser.persona} (${seededUser.access})`);
    console.log(`      ${seededUser.description}`);
  }
  console.log();

  return site;
}

async function confirmWipe(): Promise<void> {
  const rawUrl = process.env.DATABASE_URL ?? "(DATABASE_URL not set)";
  const maskedUrl = rawUrl.replace(/(:\/\/[^:]+:)[^@]+(@)/, "$1****$2");

  console.log("── Confirm Wipe ────────────────────────────────────────");
  console.log("  This will DROP and recreate the public schema.");
  console.log("  ALL DATA in the target database will be permanently lost.");
  console.log(`  Target: ${maskedUrl}`);
  console.log();

  if (!process.stdin.isTTY) {
    console.error("Refusing to wipe: importdev requires an interactive TTY to confirm.");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('  Type "wipe" to proceed (anything else aborts): ');
  rl.close();

  if (answer.trim() !== "wipe") {
    console.log("  Aborted.");
    process.exit(0);
  }
  console.log();
}

async function wipeDatabase() {
  console.log("── Wipe Database ───────────────────────────────────────");
  await prisma.$executeRawUnsafe(`DROP SCHEMA public CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA public`);
  console.log("  Schema dropped and recreated");

  // Disconnect so Prisma picks up the fresh schema after db push
  await prisma.$disconnect();
}

async function main() {
  const idMap = new IdMap();
  const startTime = Date.now();

  console.log("=".repeat(60));
  console.log("Dev Seed — Bootstrap + Legacy Data Import");
  console.log("=".repeat(60));
  console.log();

  await confirmWipe();
  await wipeDatabase();

  // Apply schema and migrations to the clean database
  console.log("  Running Prisma migrations...");
  const { execSync } = await import("node:child_process");
  execSync("pnpm --filter @rw/db exec prisma migrate deploy", { stdio: "inherit" });
  console.log();


  const site = await bootstrap();

  setDataFile("sqlLegacyData.seed.txt");
  setDevSeed(true);

  console.log("── Legacy Data Import ───────────────────────────────────");
  console.log();

  await importProcessTypes(prisma, idMap, site.id);
  await importWorkcenters(prisma, idMap, site.id);
  await importProducts(prisma, idMap, site.id);
  await importMaterials(prisma, idMap, site.id);
  await importProductMaterials(prisma, idMap, site.id);
  await importTools(prisma, idMap, site.id);
  await importToolCavities(prisma, idMap, site.id);
  await importJobs(prisma, idMap, site.id);
  await importStations(prisma, idMap, site.id);
  await importJobProducts(prisma, idMap, site.id);
  await importStatusCategories(prisma, idMap, site.id);
  await importStatusReasons(prisma, idMap, site.id);
  await importItemDispositions(prisma, idMap, site.id);
  await importItemDispositionReasons(prisma, idMap, site.id);

  // ── Normalize job standard cycle times ──────────────────────────
  const updatedJobs = await prisma.$executeRaw`
    UPDATE "JobBlob" SET "standardCycle" = 20
    WHERE id IN (SELECT "currentBlobId" FROM "Job" WHERE "currentBlobId" IS NOT NULL)
  `;
  console.log(`[Job] Set standardCycle=20 on ${updatedJobs} job blobs`);

  // ── Activate all job products ─────────────────────────────────
  const activatedProducts = await prisma.$executeRaw`
    UPDATE "JobProductBlob" SET "isActive" = true
    WHERE "isActive" = false
  `;
  console.log(`[JobProduct] Activated ${activatedProducts} inactive job product blobs`);

  // ── Copy standard cycle to active station job logs ────────────
  const updatedJobLogs = await prisma.$executeRaw`
    UPDATE "StationJobLog" jl
    SET "standardCycle" = jb."standardCycle"
    FROM "JobBlob" jb
    WHERE jb.id = jl."jobBlobId"
      AND jl."endTime" IS NULL
      AND (jl."standardCycle" IS NULL OR jl."standardCycle" = 0)
  `;
  console.log(`[StationJobLog] Set standardCycle on ${updatedJobLogs} active job logs`);

  // ── Fix unnamed tool cavities ──────────────────────────────────
  // Seed file alignment issues cause cavity names to be empty.
  // Name them "1", "2", etc. per tool.
  console.log();
  console.log("── Fix Cavity Names ────────────────────────────────────");
  console.log();

  const unnamedCavities = await prisma.$queryRaw<
    Array<{ blobId: string; toolId: string }>
  >`
    SELECT tcb.id AS "blobId", tc."toolId"
    FROM "ToolCavityBlob" tcb
    JOIN "ToolCavity" tc ON tc."currentBlobId" = tcb.id
    WHERE tcb.name = '' OR tcb.name IS NULL
    ORDER BY tc."toolId", tc."createdAt"
  `;

  const cavityCountByTool = new Map<string, number>();
  for (const row of unnamedCavities) {
    const count = (cavityCountByTool.get(row.toolId) ?? 0) + 1;
    cavityCountByTool.set(row.toolId, count);
    await prisma.toolCavityBlob.update({
      where: { id: row.blobId },
      data: { name: String(count), position: count },
    });
  }

  console.log(`[ToolCavity] Named ${unnamedCavities.length} unnamed cavities across ${cavityCountByTool.size} tools`);

  // ── Assign at least one material to each product ────────────────
  console.log();
  console.log("── Product → Material Assignment ────────────────────────");
  console.log();

  const materials = await prisma.$queryRaw<Array<{ id: string; currentBlobId: string }>>`
    SELECT id, "currentBlobId" FROM "Material" WHERE "currentBlobId" IS NOT NULL
  `;
  const products = await prisma.$queryRaw<Array<{ id: string; currentBlobId: string }>>`
    SELECT id, "currentBlobId" FROM "Product" WHERE "currentBlobId" IS NOT NULL
  `;

  let materialLinks = 0;
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const material = materials[i % materials.length];

    const pm = await prisma.productMaterial.create({
      data: { productId: product.id, materialId: material.id },
    });

    const blob = await prisma.productMaterialBlob.create({
      data: {
        version: 1,
        productMaterialId: pm.id,
        materialBlobId: material.currentBlobId,
        productBlobId: product.currentBlobId,
      },
    });

    await prisma.productMaterial.update({
      where: { id: pm.id },
      data: { currentBlobId: blob.id },
    });

    materialLinks++;
  }

  console.log(`[ProductMaterial] Linked ${materialLinks} products to materials`);

  // ── Assign products to job cavities ─────────────────────────────
  // For every job that has a tool, create a JobProduct for each
  // cavity, round-robin assigning from the product pool.
  console.log();
  console.log("── Tool Cavity → Job Assignment ────────────────────────");
  console.log();

  const allJobTools = await prisma.$queryRaw<
    Array<{ jobId: string; toolId: string }>
  >`
    SELECT jt."jobId", jt."toolId"
    FROM "JobTool" jt
    WHERE jt."deletedAt" IS NULL
  `;

  const productIds = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Product"
  `.then((rows) => rows.map((r) => r.id));

  let productIndex = 0;
  let cavityAssignments = 0;

  for (const jt of allJobTools) {
    const cavities = await prisma.toolCavity.findMany({
      where: { toolId: jt.toolId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });

    for (const cavity of cavities) {
      const existing = await prisma.jobProduct.findFirst({
        where: { jobId: jt.jobId, toolCavityId: cavity.id, deletedAt: null },
      });
      if (existing) continue;

      const productId = productIds[productIndex % productIds.length];
      productIndex++;

      const jobProduct = await prisma.jobProduct.create({
        data: { jobId: jt.jobId, productId, toolId: jt.toolId, toolCavityId: cavity.id },
      });

      const blob = await prisma.jobProductBlob.create({
        data: { version: 1, isActive: true, quantity: 1, jobProductId: jobProduct.id },
      });

      await prisma.jobProduct.update({
        where: { id: jobProduct.id },
        data: { currentBlobId: blob.id },
      });

      cavityAssignments++;
    }
  }

  console.log(`[JobProduct] Assigned ${cavityAssignments} products to cavities across ${allJobTools.length} jobs`);

  // ── 3-Shift schedule assigned to MOLD workcenter ─────────────
  console.log();
  console.log("── Shift Schedule ──────────────────────────────────────");
  console.log();

  const moldWorkcenterId = idMap.get("workcenter", "MOLD");
  if (moldWorkcenterId) {
    const pattern = await prisma.shiftPattern.create({
      data: {
        name: "3-Shift",
        siteId: site.id,
        totalDaysInRotation: 1,
        useEndDateForBusinessDate: true,
      },
    });

    const shifts = [
      { sortOrder: 1, shiftName: "Shift 1", startTime: "03:00", durationHrs: 8 },
      { sortOrder: 2, shiftName: "Shift 2", startTime: "11:00", durationHrs: 8 },
      { sortOrder: 3, shiftName: "Shift 3", startTime: "19:00", durationHrs: 8 },
    ];

    const definitions = await Promise.all(
      shifts.map((s) =>
        prisma.shiftDefinition.create({
          data: {
            patternId: pattern.id,
            dayOfRotation: 1,
            sortOrder: s.sortOrder,
            startDayOffset: 0,
            startTime: s.startTime,
            durationHrs: s.durationHrs,
            shiftName: s.shiftName,
          },
        }),
      ),
    );

    const firstShift = definitions.find((d) => d.sortOrder === 1)!;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    await prisma.shiftAssignment.create({
      data: {
        patternId: pattern.id,
        siteId: site.id,
        workCenterId: moldWorkcenterId,
        rotationStartDate: today,
        rotationStartDefinitionId: firstShift.id,
      },
    });

    console.log(`[ShiftPattern] Created "3-Shift" with 3 definitions`);
    console.log(`[ShiftAssignment] Assigned to workcenter MOLD`);
  } else {
    console.log("[ShiftPattern] WARN: MOLD workcenter not found, skipping shift setup");
  }

  // ── Simulation gateway + datasources for all stations ────────
  console.log();
  console.log("── Simulation Devices ──────────────────────────────────");
  console.log();

  await driverRegistry.initialize();

  if (!driverRegistry.has("simulation")) {
    console.log("[SimDevices] WARN: simulation driver not found, skipping");
  } else {
    const gwResult = await gatewaySvc.create({
      name: "Sim Gateway",
      description: "Virtual gateway for simulation datasources",
      hosting: "SELF",
      siteId: site.id,
      workspaceId: site.workspaceId,
    });
    if ("error" in gwResult) throw new Error(`Gateway create failed: ${gwResult.error}`);
    const gw = gwResult.data;
    console.log(`[Gateway] Created "${gw.name}" (${gw.id})`);

    const stations = await prisma.station.findMany({
      where: { siteId: site.id },
      orderBy: { name: "asc" },
    });

    const stationDevices: Array<{
      stationId: string;
      stationName: string;
      datasourceId: string;
      datasourceName: string;
      pointId: string;
    }> = [];

    for (const station of stations) {
      const dsResult = await datasourceSvc.create({
        name: `${station.name} Sim`,
        driver: "simulation",
        connection: { mode: "simulation" },
        siteId: site.id,
        workspaceId: site.workspaceId,
      });
      if ("error" in dsResult) {
        console.error(`  ${station.name}: datasource create failed — ${dsResult.error}`);
        continue;
      }

      const pgResult = await datasourceSvc.groups.create(dsResult.data.id, {
        name: "default",
        pollRateMs: 1000,
      });
      if ("error" in pgResult) {
        console.error(`  ${station.name}: group create failed — ${pgResult.error}`);
        continue;
      }

      const ptResult = await datasourceSvc.points.create(dsResult.data.id, {
        name: "cycle",
        address: "cycle-20s",
        dataType: "INT16",
        groupId: pgResult.data.id,
      });
      if ("error" in ptResult) {
        console.error(`  ${station.name}: point create failed — ${ptResult.error}`);
        continue;
      }

      await prisma.stationDatasource.create({
        data: { stationId: station.id, datasourceId: dsResult.data.id },
      });

      stationDevices.push({
        stationId: station.id,
        stationName: station.name,
        datasourceId: dsResult.data.id,
        datasourceName: dsResult.data.name,
        pointId: ptResult.data.id,
      });
    }

    const datasourceIds = stationDevices.map((d) => d.datasourceId);

    if (datasourceIds.length > 0) {
      await prisma.datasource.updateMany({
        where: { id: { in: datasourceIds } },
        data: { gatewayId: gw.id },
      });

      for (const dsId of datasourceIds) {
        await datasourceSvc.publish(dsId);
      }
    }

    console.log(`[SimDevices] Created ${stationDevices.length} sim datasource(s) on gateway "${gw.name}"`);

    // ── Record Cycle events for each station ─────────────────────
    for (const sd of stationDevices) {
      await prisma.stationEvent.create({
        data: {
          name: `${sd.stationName} Event`,
          enabled: true,
          stationId: sd.stationId,
          trigger: {
            operator: "all",
            clauses: [
              {
                id: `clause_${Date.now()}_${Math.floor(Math.random() * 100)}`,
                kind: "condition",
                condition: "increments_up",
                deviceId: sd.datasourceId,
                deviceName: sd.datasourceName,
                tagId: sd.pointId,
                tagName: "cycle",
                value: null,
              },
            ],
          },
          actions: [
            {
              id: `action_${Date.now()}_${Math.floor(Math.random() * 100)}`,
              event: "cycle.record",
              eventDisplayName: "Record Cycle",
              inputs: { duration: "0", machineId: "{{station.id}}" },
            },
          ],
        },
      });
    }

    console.log(`[StationEvents] Created ${stationDevices.length} Record Cycle event(s)`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();
  console.log("=".repeat(60));
  console.log(`Dev seed completed in ${elapsed}s`);

  if (idMap.tables().length > 0) {
    console.log("\nID mappings created:");
    for (const table of idMap.tables()) {
      console.log(`  ${table}: ${idMap.count(table)} records`);
    }
  }

  console.log("=".repeat(60));
}

main()
  .catch((e) => {
    console.error("Dev seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
