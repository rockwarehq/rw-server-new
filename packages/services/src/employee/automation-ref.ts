import type { RefSource } from "@rw/automations";
import prisma from "@rw/db";

/**
 * Employee picker hook for the automation framework. The name lives on `EmployeeVersion` (the
 * versioned profile snapshot) and is read through `Employee.versionId → version`. Employees
 * without a current version are skipped — no version means no name to render in the picker.
 *
 * TODO (deferred): email resolution. The picker label is name-only today. When an action handler
 * needs an email for a stored employee id, the resolution path is `Employee.memberships[0]?.user.
 * email`. Wire that into `getEmployeeById` (extend `ResolvedEmployee` with optional `email`) when
 * sendAlert@v2 lands — or surface a separate `getEmployeeEmail(id)` if the consumer doesn't need
 * the name + email together.
 */

/** Resolved employee shape used by automation handlers. Name only for now (see TODO above). */
export interface ResolvedEmployee {
  id: string;
  name: string;
}

/**
 * `employees` ref source backed by Postgres. Lists every active employee whose current version has
 * a name, ordered alphabetically by display name. `{ id, label }` shape matches the other ref
 * sources so the editor renders uniformly.
 */
export const employeesAutomationRef: RefSource = {
  key: "employees",
  async list(_ctx) {
    const employees = await listEmployees();
    return employees.map((e) => ({ id: e.id, label: e.name }));
  },
};

/**
 * Resolve a single employee by id. Returns undefined if the employee doesn't exist or has no
 * current version (no name to render).
 */
export async function getEmployeeById(id: string): Promise<ResolvedEmployee | undefined> {
  const employee = await prisma.employee.findFirst({
    where: { id, versionId: { not: null } },
    select: { id: true, version: { select: { firstName: true, lastName: true } } },
  });
  if (!employee?.version) return undefined;
  return mapEmployee(employee as { id: string; version: { firstName: string; lastName: string } });
}

/** Every active employee with a current version. Stable name-ordered for picker UX. */
async function listEmployees(): Promise<ResolvedEmployee[]> {
  const rows = await prisma.employee.findMany({
    where: { versionId: { not: null } },
    select: { id: true, version: { select: { firstName: true, lastName: true } } },
  });
  const out = rows
    .filter((r): r is { id: string; version: { firstName: string; lastName: string } } => r.version !== null)
    .map(mapEmployee);
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}

function mapEmployee(input: { id: string; version: { firstName: string; lastName: string } }): ResolvedEmployee {
  const name = `${input.version.firstName} ${input.version.lastName}`.trim();
  return { id: input.id, name };
}
