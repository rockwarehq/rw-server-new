/**
 * Dev-only cycle simulator.
 *
 * Fires cycle.complete() on a repeating interval against the first
 * station it can find. Useful for testing metric bucket accumulation.
 *
 * Enable with:
 *   DEV_CYCLE_SIMULATOR=1 pnpm dev
 *   DEV_CYCLE_SIMULATOR=1 DEV_CYCLE_SIMULATOR_INTERVAL_MS=5000 pnpm dev
 *   pnpm dev:testcycle
 */

import prisma from "@rw/db";
import { complete } from "@rw/services/cycle/cycle";

const INTERVAL_MS = parseInt(process.env.DEV_CYCLE_SIMULATOR_INTERVAL_MS || "", 10) || 10_000;

let handle: ReturnType<typeof setInterval> | null = null;
let count = 0;

async function tick() {
  // Try station with a job assigned first
  let station = await prisma.station.findFirst({
    where: { currentJobId: { not: null } },
    select: { id: true, name: true, siteId: true, currentJobId: true },
  });

  let jobId: string;
  let jobName: string;

  if (station?.currentJobId) {
    const job = await prisma.job.findUnique({
      where: { id: station.currentJobId },
      select: { id: true, currentBlobId: true, currentBlob: { select: { name: true } } },
    });
    if (!job?.currentBlobId) {
      console.log("[cycle-simulator] Assigned job has no blob. Skipping.");
      return;
    }
    jobId = job.id;
    jobName = job.currentBlob?.name ?? "Unknown";
  } else {
    // Fallback: any station + any job in the same site
    station = await prisma.station.findFirst({
      select: { id: true, name: true, siteId: true, currentJobId: true },
    });
    if (!station) {
      console.log("[cycle-simulator] No stations found. Create one first.");
      return;
    }

    const job = await prisma.job.findFirst({
      where: {
        siteId: station.siteId,
        deletedAt: null,
        currentBlobId: { not: null },
      },
      select: { id: true, currentBlob: { select: { name: true } } },
    });
    if (!job) {
      console.log("[cycle-simulator] No jobs with a blob found. Create one first.");
      return;
    }
    jobId = job.id;
    jobName = job.currentBlob?.name ?? "Unknown";
  }

  count++;
  const result = await complete({
    stationId: station.id,
    timestamp: new Date(),
    jobId,
    keepOpen: false,
  });

  if ("error" in result) {
    console.error(`[cycle-simulator] Cycle #${count} failed: ${result.error}`);
  } else {
    console.log(`[cycle-simulator] Cycle #${count} — "${station.name}" + "${jobName}"`);
  }
}

export function maybeStartCycleSimulator() {
  if (!process.env.DEV_CYCLE_SIMULATOR) return;

  console.log(`[cycle-simulator] Starting — every ${INTERVAL_MS}ms`);

  handle = setInterval(() => {
    tick().catch((err) => console.error("[cycle-simulator] Tick error:", err));
  }, INTERVAL_MS);
}

export function stopCycleSimulator() {
  if (handle) {
    clearInterval(handle);
    handle = null;
    console.log(`[cycle-simulator] Stopped after ${count} cycles`);
  }
}
