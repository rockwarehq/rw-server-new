// API entry point. HTTP/RPC/auth — apps/api's primary purpose.
//
// In-process BullMQ workers that stay in apps/api:
//   - stale-gateway-check  (BullMQ repeating job, every 30s)
//   - station-detect       (slow + down)
//   - replay-reconcile     (with startup recoverReplayWindows)
//   - dev-cycle-simulator  (DEV_CYCLE_SIMULATOR=1 only)
//
// Producer-side queue inits (no worker registered here):
//   - station-detection queues   (HTTP handlers call scheduleDetection)
//   - metric-bucket queues       (services/metrics/bucket.ts calls scheduleNextShiftBuckets)
//
// Rollups (metric-bucket-ensure, shift-bucket-create, shift-change,
// combined metrics tick, archive) and station-event-execution live in
// apps/workers — NOT here. That keeps apps/api horizontally-scalable.

process.env.TZ = "UTC";

import "dotenv/config";

import { createPrismaClient } from "@rw/db";
createPrismaClient("api");

import { initEventsBridge } from "@rw/runtime/events-bus";
import { initMetricsBridge } from "@rw/services/rpc/metrics-bus";

import { serverConfig } from "./config.js";
import { startStaleGatewayCheck, stopStaleGatewayCheck } from "@rw/services/queues/background-workers";
import { initQueues, registerStateDetectionWorkers, stopQueues } from "@rw/services/queues/station-detection";
import { initMetricBucketQueues, stopMetricBucketQueues } from "@rw/services/queues/metric-buckets";
import { createServer } from "./server.js";
import { driver } from "./services/device/index.js";
import { registerReplayReconcileWorker, stopReplayReconcileWorker } from "@rw/services/queues/replay-reconcile";
import { recoverReplayWindows, cleanup as cleanupReplay } from "@rw/services/cycle/replay";

let cleanupBridge: (() => Promise<void>) | null = null;
let cleanupMetricsBridge: (() => Promise<void>) | null = null;

async function main() {
  // Initialize driver registry (load from files and upsert to DB —
  // safe under multiple API instances, name+version is the unique key).
  await driver.driverRegistry.initialize();

  // Start HTTP first so healthchecks and RPCs respond immediately while
  // workers are still registering.
  const server = createServer(serverConfig);
  await server.start();

  // `both` mode: subscribes to receive worker-published events AND publishes
  // its own events through Redis so SSE clients on other api machines see
  // them too (horizontal-scaling safe). The process's own publishes loop
  // back through Redis (~1ms) — fine for SSE latency, no double-delivery.
  cleanupBridge = await initEventsBridge("both");
  cleanupMetricsBridge = await initMetricsBridge("both");

  // Producer-side queues that HTTP/RPC handlers enqueue against. These
  // initialize Queue instances; the workers consuming them run elsewhere
  // (rollups for metric-bucket / shift-change).
  await initMetricBucketQueues();

  // station-detection: producer (scheduleDetection) + workers (slow/down)
  // both stay in apps/api.
  await initQueues();
  await registerStateDetectionWorkers();

  // The four in-process workers that belong in apps/api.
  await startStaleGatewayCheck();
  await registerReplayReconcileWorker();
  await recoverReplayWindows();

  if (process.env.DEV_CYCLE_SIMULATOR) {
    const { maybeStartCycleSimulator } = await import("./dev-cycle-simulator.js");
    await maybeStartCycleSimulator();
  }

  console.log("[api] HTTP + in-process workers started");
}

async function shutdown() {
  await Promise.all([
    stopStaleGatewayCheck(),
    stopQueues(),
    stopMetricBucketQueues(),
    stopReplayReconcileWorker(),
    cleanupReplay(),
  ]);
  if (cleanupBridge) await cleanupBridge();
  if (cleanupMetricsBridge) await cleanupMetricsBridge();
  const { createPrismaClient: getClient } = await import("@rw/db");
  await getClient("api").$disconnect();
}

process.on("SIGINT", () => shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => shutdown().then(() => process.exit(0)));
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  shutdown().then(() => process.exit(1));
});

main().catch((err) => {
  console.error("Failed to start server:", err);
  shutdown().then(() => process.exit(1));
});
