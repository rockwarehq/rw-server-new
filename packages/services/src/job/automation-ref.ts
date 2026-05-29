import type { RefSource } from "@rw/automations";
import prisma from "@rw/db";

/**
 * Job picker hook for the automation framework. The user-facing job name lives on `JobBlob.name`
 * (the versioned config), read via `Job.currentBlob`. Jobs without a current blob are skipped —
 * without a name there's nothing the picker can render.
 */
export const jobsAutomationRef: RefSource = {
  key: "jobs",
  async list(_ctx) {
    const rows = await prisma.job.findMany({
      where: { deletedAt: null, currentBlobId: { not: null } },
      select: { id: true, currentBlob: { select: { name: true } } },
    });
    return rows
      .filter((j) => j.currentBlob !== null)
      .map((j) => ({ id: j.id, label: (j.currentBlob as { name: string }).name }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  },
};
