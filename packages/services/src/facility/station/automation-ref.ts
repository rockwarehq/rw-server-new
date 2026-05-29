import prisma from "@rw/db";
import { createNameRef } from "../automation-ref-factory.js";

/** `stations` picker source — every non-deleted station, name-ordered. */
export const stationsAutomationRef = createNameRef({
  key: "stations",
  findRows: () =>
    prisma.station.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
});
