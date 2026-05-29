import type { PrismaClient } from "@rw/db";
import { hashPassword, comparePassword } from "../../src/services/auth/session.js";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
  nullable,
} from "./utils.js";

interface SqlServerRow {
  NameID: string;
  Role: string;
  PIN: string;
  EmployeeID: string;
}

function splitName(nameId: string): { firstName: string; lastName: string } {
  const trimmed = nameId.trim();
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { firstName: trimmed, lastName: "" };
  return {
    firstName: trimmed.slice(0, idx),
    lastName: trimmed.slice(idx + 1).trim(),
  };
}

export async function importEmployees(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("Employee");

  const rows = await readData<SqlServerRow>("Employee");

  if (rows.length === 0) {
    log.warn("No Employee data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { workspaceId: true },
  });
  if (!site) {
    log.error(`Site ${siteId} not found — aborting Employee import`);
    return;
  }
  const workspaceId = site.workspaceId;

  const operatorRoleId = idMap.get("employeeRole", "Operator") ?? null;
  if (!operatorRoleId) {
    log.warn(
      "No 'Operator' role found — employees with an unknown role will get no site access",
    );
  }

  let siteAccessSkipped = 0;

  const result = await batchUpsert(
    rows,
    async (row) => {
      const nameId = row.NameID.trim();
      if (!nameId) return;

      const { firstName, lastName } = splitName(nameId);
      if (!firstName) return;

      const employeeNumber = nullable(row.EmployeeID.trim());
      const plainPin = nullable(row.PIN.trim());
      const roleName = row.Role.trim();
      const roleId =
        idMap.get("employeeRole", roleName) ?? operatorRoleId ?? null;

      // Idempotency match: same workspace + same current-version profile tuple.
      // employeeNumber is the strongest discriminator when present.
      const existing = await prisma.employee.findFirst({
        where: {
          workspaceId,
          version: { firstName, lastName, employeeNumber },
        },
        include: { version: true },
      });

      let employeeId: string;

      if (existing && existing.version) {
        const currentVersion = existing.version;
        const profileChanged =
          currentVersion.firstName !== firstName ||
          currentVersion.lastName !== lastName ||
          currentVersion.employeeNumber !== employeeNumber;

        // Never clobber an existing pinHash with null. Only re-hash if a new
        // PIN is present AND it doesn't match what's stored.
        let nextPinHash: string | null = currentVersion.pinHash;
        let pinChanged = false;
        if (plainPin) {
          const matches = currentVersion.pinHash
            ? await comparePassword(plainPin, currentVersion.pinHash)
            : false;
          if (!matches) {
            nextPinHash = await hashPassword(plainPin);
            pinChanged = true;
          }
        }

        if (profileChanged || pinChanged) {
          const maxVersion = await prisma.employeeVersion.findFirst({
            where: { employeeId: existing.id },
            orderBy: { version: "desc" },
            select: { version: true },
          });
          const nextVersionNum =
            (maxVersion?.version ?? currentVersion.version) + 1;
          const newVersion = await prisma.employeeVersion.create({
            data: {
              employeeId: existing.id,
              version: nextVersionNum,
              firstName,
              lastName,
              employeeNumber,
              pinHash: nextPinHash,
              badgeNumber: currentVersion.badgeNumber,
            },
          });
          await prisma.employee.update({
            where: { id: existing.id },
            data: { versionId: newVersion.id },
          });
        }

        employeeId = existing.id;
      } else {
        const employee = await prisma.employee.create({
          data: { workspaceId, status: "ACTIVE" },
        });
        const pinHash = plainPin ? await hashPassword(plainPin) : null;
        const version = await prisma.employeeVersion.create({
          data: {
            employeeId: employee.id,
            version: 1,
            firstName,
            lastName,
            employeeNumber,
            pinHash,
          },
        });
        await prisma.employee.update({
          where: { id: employee.id },
          data: { versionId: version.id },
        });
        employeeId = employee.id;
      }

      idMap.set("employee", nameId, employeeId);

      if (!roleId) {
        siteAccessSkipped++;
        return;
      }

      await prisma.employeeSiteAccess.upsert({
        where: { employeeId_siteId: { employeeId, siteId } },
        update: { roleId, status: "ACTIVE" },
        create: { employeeId, siteId, roleId, status: "ACTIVE" },
      });
    },
    { label: "employees" },
  );

  log.summary(result);
  if (siteAccessSkipped > 0) {
    log.warn(
      `${siteAccessSkipped} employee(s) created without site access (role unresolved, no Operator fallback)`,
    );
  }
}
