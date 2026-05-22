import mqtt from "mqtt";

import { createPrismaClient, type PrismaClient } from "@rw/db";

import { loadConfig } from "./config.js";
import { startMetricsServer } from "./observability/metrics-server.js";
import { createPgQueryClient } from "./pg-query-client.js";
import { createDispatcher } from "./pipeline/dispatcher.js";
import { createMetrics, startMetricsReporter } from "./pipeline/metrics.js";
import { parseMessage } from "./pipeline/parser.js";
import { createPointsSplitEnricher } from "./pipeline/preprocessors/points-split-enricher.js";
import type { EventPreprocessor, Logger } from "./pipeline/types.js";
import { createProcessorRuntimeEntries } from "./processors/index.js";
import { createStationEventsProcessor } from "./processors/station-events-processor.js";
import { startStationEventsCacheRefreshServer } from "./station-events/cache-refresh-server.js";
import { createPointSnapshotPreprocessor } from "./station-events/point-snapshot-preprocessor.js";
import { createStationEventsRpcClient } from "./station-events/rpc-client.js";
import { StationEventCache } from "./station-events/station-event-cache.js";
import { TagSnapshotCache } from "./station-events/tag-snapshot-cache.js";
import { hydrateMissingTagSnapshots } from "./station-events/tag-snapshot-loader.js";

function createLogger(): Logger {
  return {
    debug(message, meta) {
      console.debug(message, meta ?? {});
    },
    info(message, meta) {
      console.info(message, meta ?? {});
    },
    warn(message, meta) {
      console.warn(message, meta ?? {});
    },
    error(message, meta) {
      console.error(message, meta ?? {});
    },
  };
}

function endClient(client: mqtt.MqttClient): Promise<void> {
  return new Promise((resolve) => {
    client.end(true, {}, () => resolve());
  });
}

interface ListenerHandle {
  logger: Logger;
  prisma: PrismaClient;
  dispatcher: Awaited<ReturnType<typeof createDispatcher>>;
  mqttClient: mqtt.MqttClient;
  metrics: ReturnType<typeof createMetrics>;
  metricsServer: Awaited<ReturnType<typeof startMetricsServer>>;
  stationEventsRefreshServer: Awaited<ReturnType<typeof startStationEventsCacheRefreshServer>>;
  stopMetricsReporter: () => void;
  shutdownDrainTimeoutMs: number;
}

let handle: ListenerHandle | undefined;
let stopping = false;

export async function startListener(): Promise<void> {
  if (handle) {
    return;
  }

  const config = loadConfig();
  const logger = createLogger();
  const metrics = createMetrics();
  const prisma = createPrismaClient("processor");
  const preprocessors: EventPreprocessor[] = [];
  let stationEventCache: StationEventCache | undefined;
  let stationEventsProcessor: ReturnType<typeof createStationEventsProcessor> | undefined;

  const stationEventsRefreshServer = await startStationEventsCacheRefreshServer({
    config: config.stationEvents.cacheRefresh,
    logger,
    onRefresh: async (body) => {
      if (!stationEventCache) {
        logger.warn("station event cache refresh ignored because station events are disabled", {
          operation: body.operation,
          stationId: body.stationId,
          eventId: body.eventId,
        });
        throw new Error("station events are disabled");
      }

      await stationEventCache.refresh(`callback:${body.operation}`);
    },
  });

  if (config.stationEvents.enabled) {
    const stationEventsRpcClient = createStationEventsRpcClient({
      baseUrl: config.stationEvents.url,
      authToken: config.stationEvents.authToken,
    });

    stationEventCache = new StationEventCache({
      logger,
      rpcClient: stationEventsRpcClient,
    });
    const tagSnapshotCache = new TagSnapshotCache({
      maxEntries: config.stationEvents.tagSnapshotCacheMaxEntries,
    });

    await stationEventCache.loadInitialSnapshot();

    preprocessors.push(
      createPointSnapshotPreprocessor({
        tagSnapshotCache,
      }),
    );

    if (config.stationEvents.prewarmTagCache) {
      try {
        await hydrateMissingTagSnapshots({
          rpcClient: stationEventsRpcClient,
          tagSnapshotCache,
          tagKeys: stationEventCache.getAllRequiredKeys(),
          timeoutMs: config.stationEvents.timeoutMs,
          batchSize: config.stationEvents.tagFetchBatchSize,
          logger,
          reason: "station-event-startup-prewarm",
        });
      } catch (error) {
        logger.warn("station event tag prewarm failed", {
          cache: "tag-snapshots",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    stationEventsProcessor = createStationEventsProcessor({
      config: {
        timeoutMs: config.stationEvents.timeoutMs,
        tagFetchBatchSize: config.stationEvents.tagFetchBatchSize,
      },
      stationEventCache,
      tagSnapshotCache,
      rpcClient: stationEventsRpcClient,
      logger,
    });
  }

  if (config.pointsSplitEnrich.enabled) {
    preprocessors.push(
      createPointsSplitEnricher({
        queryClient: createPgQueryClient(prisma),
        mode: config.pointsSplitEnrich.mode,
        logger,
      }),
    );

    logger.info("points split enrichment enabled", {
      mode: config.pointsSplitEnrich.mode,
    });
  } else {
    logger.info("points split enrichment disabled");
  }

  const entries = createProcessorRuntimeEntries({
    config,
    metrics,
    logger,
    prisma,
    stationEventsProcessor,
  });

  const dispatcher = createDispatcher({ entries, metrics, logger, preprocessors });
  const metricsServer = await startMetricsServer({
    config: config.metricsServer,
    logger,
  });
  const stopMetricsReporter = startMetricsReporter({
    metrics,
    logger,
    intervalMs: config.metricsIntervalMs,
  });

  const mqttClient = mqtt.connect(config.mqtt.brokerUrl, {
    username: config.mqtt.username,
    password: config.mqtt.password,
  });

  mqttClient.on("message", (topic, raw) => {
    if (stopping) {
      return;
    }

    const receivedAt = Date.now();
    const parsed = parseMessage({ topic, raw, receivedAt });

    if (parsed.isErr()) {
      metrics.incParseError();
      logger.warn("message rejected by parser", {
        topic,
        code: parsed.error.code,
        message: parsed.error.message,
      });
      return;
    }

    metrics.incParsedOk();

    void dispatcher.dispatch(parsed.value).catch((error) => {
      logger.error("dispatch failed", {
        topic,
        eventId: parsed.value.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  mqttClient.on("error", (error: Error) => {
    logger.error("mqtt client error", { error: error.message });
  });

  mqttClient.on("close", () => {
    logger.info("mqtt connection closed");
  });

  mqttClient.on("offline", () => {
    logger.warn("mqtt client offline");
  });

  mqttClient.on("reconnect", () => {
    logger.info("mqtt reconnecting");
  });

  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      logger.info("connected to mqtt broker", { brokerUrl: config.mqtt.brokerUrl });
      mqttClient.subscribe(config.mqtt.topic, (error) => {
        mqttClient.off("error", onError);
        if (error) {
          logger.error("failed to subscribe", {
            topic: config.mqtt.topic,
            error: error.message,
          });
          reject(error);
          return;
        }

        logger.info("subscribed", { topic: config.mqtt.topic });
        resolve();
      });
    };
    const onError = (error: Error) => {
      mqttClient.off("connect", onConnect);
      reject(error);
    };
    mqttClient.once("connect", onConnect);
    mqttClient.once("error", onError);
  });

  handle = {
    logger,
    prisma,
    dispatcher,
    mqttClient,
    metrics,
    metricsServer,
    stationEventsRefreshServer,
    stopMetricsReporter,
    shutdownDrainTimeoutMs: config.shutdownDrainTimeoutMs,
  };
}

export async function stopListener(): Promise<void> {
  if (!handle || stopping) {
    return;
  }

  stopping = true;
  const h = handle;
  handle = undefined;

  h.logger.info("shutdown requested");

  await h.dispatcher.shutdown({ drainTimeoutMs: h.shutdownDrainTimeoutMs });
  if (h.stationEventsRefreshServer) {
    await h.stationEventsRefreshServer.close();
  }
  await endClient(h.mqttClient);
  h.metrics.setServiceUp(0);
  if (h.metricsServer) {
    await h.metricsServer.close();
  }
  h.stopMetricsReporter();
  await h.prisma.$disconnect();

  h.logger.info("shutdown complete");
  stopping = false;
}
