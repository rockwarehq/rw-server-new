// Config values used by @rw/services. Mirrors the subset of apps/api/src/config.ts
// that the moved files reference.

export { bullmqConfig } from "@rw/runtime/bullmq-config";

const processorSharedSecret = process.env.PROCESSOR_SHARED_SECRET || "";

export const processorConfig = {
  sharedSecret: processorSharedSecret,
  cacheRefreshUrl: process.env.PROCESSOR_CACHE_REFRESH_URL || "",
  cacheRefreshSecret: process.env.PROCESSOR_CACHE_REFRESH_SECRET || processorSharedSecret,
  cacheRefreshTimeoutMs: parseInt(process.env.PROCESSOR_CACHE_REFRESH_TIMEOUT_MS || "", 10) || 2000,
};

export const stationActionConfig = {
  webhookTimeoutMs: parseInt(process.env.STATION_ACTION_WEBHOOK_TIMEOUT_MS || "", 10) || 5000,
};
