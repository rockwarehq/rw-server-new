// BullMQ tuning — lifted from rw-server/src/config.ts.

export interface BullMQTuning {
  /** Interval (ms) at which workers check for stalled jobs. Default 30s; increase for Upstash. */
  stalledInterval: number;
  /** Delay (ms) workers wait before polling when queue is drained. Default 5s; increase for Upstash. */
  drainDelay: number;
  /** ioredis connect timeout (ms). Default 10s; increase for high-latency Redis. */
  connectTimeout: number;
}

export const bullmqConfig: BullMQTuning = {
  stalledInterval: Number.parseInt(process.env.BULLMQ_STALLED_INTERVAL ?? "", 10) || 30_000,
  drainDelay: Number.parseInt(process.env.BULLMQ_DRAIN_DELAY ?? "", 10) || 5_000,
  connectTimeout: Number.parseInt(process.env.BULLMQ_CONNECT_TIMEOUT ?? "", 10) || 10_000,
};

export function getRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required");
  return url;
}

export interface BullMQConnectionOpts {
  url: string;
  connectTimeout: number;
  maxRetriesPerRequest: null;
}

export function bullmqConnectionOpts(): BullMQConnectionOpts {
  return {
    url: getRedisUrl(),
    connectTimeout: bullmqConfig.connectTimeout,
    maxRetriesPerRequest: null,
  };
}
