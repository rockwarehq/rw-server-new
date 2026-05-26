// Processor-consumer worker — runs station-event-execution (the BullMQ
// consumer currently in rw-server/src/cycle-worker.ts).
//
// Reuses apps/api's BullMQ queue init plus its dedicated station-event-execution
// worker (concurrency 10). At cutover, apps/api stops registering its own copy
// of this worker and apps/workers/processor-consumer becomes the sole consumer.

import { createPrismaClient } from "@rw/db";
import { initEventsBridge } from "@rw/runtime/events-bus";
import { initMetricsBridge } from "@rw/services/rpc/metrics-bus";
import { startStationEventWorker, stopStationEventWorker } from "@rw/services/queues/background-workers";
import { initQueues, stopQueues } from "@rw/services/queues/station-detection";
import { initMetricBucketQueues, stopMetricBucketQueues } from "@rw/services/queues/metric-buckets";
import { cleanup as cleanupReplay } from "@rw/services/cycle/replay";

let cleanupBridge: (() => Promise<void>) | null = null;
let cleanupMetricsBridge: (() => Promise<void>) | null = null;

export async function startProcessorConsumer(): Promise<void> {
  createPrismaClient("processor-consumer");
  cleanupBridge = await initEventsBridge("publisher");
  // Bridge metric-bus events to api over Redis. cycle.complete publishes
  // live metric value changes (station status, current job, etc.) that
  // frontend SSE subscribers depend on.
  cleanupMetricsBridge = await initMetricsBridge("publisher");

  // These queues need to be initialized so scheduleDetection and
  // scheduleNextShiftBuckets can enqueue jobs from inside the worker.
  await initQueues();
  await initMetricBucketQueues();

  await startStationEventWorker();
  console.log("[processor-consumer] station-event-execution worker started");
}

export async function stopProcessorConsumer(): Promise<void> {
  await stopStationEventWorker();
  await Promise.all([stopQueues(), stopMetricBucketQueues(), cleanupReplay()]);
  if (cleanupBridge) await cleanupBridge();
  if (cleanupMetricsBridge) await cleanupMetricsBridge();
  const { createPrismaClient: getClient } = await import("@rw/db");
  await getClient("processor-consumer").$disconnect();
}
