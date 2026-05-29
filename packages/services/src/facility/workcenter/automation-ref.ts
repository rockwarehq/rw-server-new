import prisma from "@rw/db";
import { createNameRef } from "../automation-ref-factory.js";

/** `workCenters` picker source — every workcenter, name-ordered. */
export const workCentersAutomationRef = createNameRef({
  key: "workCenters",
  findRows: () =>
    prisma.workcenter.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
});
