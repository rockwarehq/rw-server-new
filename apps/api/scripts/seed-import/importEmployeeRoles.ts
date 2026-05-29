import type { PrismaClient } from "@rw/db";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
} from "./utils.js";

interface SqlServerRow {
  name: string;
}

export async function importEmployeeRoles(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("EmployeeRole");

  const rows = await readData<SqlServerRow>("EmployeeRole");

  if (rows.length === 0) {
    log.warn("No EmployeeRole data found in sqlLegacyData.txt — skipping");
  } else {
    log.info(`Found ${rows.length} rows to import`);

    const result = await batchUpsert(
      rows,
      async (row) => {
        const name = row.name.trim();
        if (!name) return;

        // Case-insensitive existence check so dump-uppercase ("OPERATOR")
        // matches db:seed titlecase ("Operator") instead of duplicating.
        const existing = await prisma.employeeRole.findFirst({
          where: { siteId, name: { equals: name, mode: "insensitive" } },
        });

        const record =
          existing ??
          (await prisma.employeeRole.create({
            data: { siteId, name },
          }));

        idMap.set("employeeRole", name, record.id);
      },
      { label: "employee roles" },
    );

    log.summary(result);
  }

  // Pull in any pre-existing roles on this site (e.g. seeded defaults like
  // "Operator") so the Employee importer's fallback can resolve them.
  const allRoles = await prisma.employeeRole.findMany({ where: { siteId } });
  for (const role of allRoles) {
    if (!idMap.get("employeeRole", role.name)) {
      idMap.set("employeeRole", role.name, role.id);
    }
  }
}
