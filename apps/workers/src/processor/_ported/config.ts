import type { OverflowPolicy, ProcessorRuntimeConfig } from "./pipeline/types.js";

export interface AppConfig {
  consoleEvents: {
    enabled: boolean;
  };
  mqtt: {
    brokerUrl: string;
    topic: string;
    username?: string;
    password?: string;
  };
  workspaceHttp: {
    eventsEnabled: boolean;
    eventsUrl: string;
    timeoutMs: number;
    authToken: string;
  };
  dbEvents: {
    enabled: boolean;
    connectionString: string;
    table: string;
    insertTimeoutMs: number;
    batchWindowMs: number;
    batchMaxRows: number;
    runtime: Partial<ProcessorRuntimeConfig>;
  };
  fileEvents: {
    enabled: boolean;
    path: string;
  };
  uniqueTopics: {
    enabled: boolean;
  };
  pointsSplitEnrich: {
    enabled: boolean;
    mode: "strict" | "best_effort";
  };
  stationEvents: {
    enabled: boolean;
    url: string;
    authToken: string;
    timeoutMs: number;
    tagFetchBatchSize: number;
    prewarmTagCache: boolean;
    tagSnapshotCacheMaxEntries: number;
    runtime: Partial<ProcessorRuntimeConfig>;
    cacheRefresh: {
      enabled: boolean;
      host: string;
      port: number;
      path: string;
      secret: string;
    };
  };
  metricsIntervalMs: number;
  metricsServer: {
    enabled: boolean;
    host: string;
    port: number;
    path: string;
  };
  shutdownDrainTimeoutMs: number;
  processorDefaults: ProcessorRuntimeConfig;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const overflow = (env.PROCESSOR_OVERFLOW_POLICY ?? "drop_oldest") as OverflowPolicy;
  const consoleEventsEnabled = parseBoolean(env.CONSOLE_EVENTS_ENABLED, false);
  const workspaceHttpEventsEnabled = parseBoolean(env.WORKSPACE_HTTP_EVENTS_ENABLED, true);
  const workspaceHttpEventsUrl = env.WORKSPACE_HTTP_EVENTS_URL ?? "";
  const workspaceHttpAuthToken = env.PROCESSOR_SHARED_SECRET ?? "";
  const dbEventsEnabled = parseBoolean(env.DB_EVENTS_ENABLED, true);
  const dbEventsConnectionString = env.DB_EVENTS_CONNECTION_STRING ?? "";
  const fileEventsEnabled = parseBoolean(env.FILE_EVENTS_ENABLED, false);
  const fileEventsPath = env.FILE_EVENTS_PATH ?? "";
  const uniqueTopicsEnabled = parseBoolean(env.UNIQUE_TOPICS_ENABLED, false);
  const pointsSplitEnrichEnabled = parseBoolean(env.POINTS_SPLIT_ENRICH_ENABLED, true);
  const pointsSplitEnrichMode =
    env.POINTS_SPLIT_ENRICH_MODE === "best_effort" ? "best_effort" : "strict";
  const stationEventsEnabled = parseBoolean(env.STATION_EVENTS_ENABLED, true);
  const stationEventsUrl = env.STATION_EVENTS_URL ?? workspaceHttpEventsUrl;
  const stationEventsAuthToken = env.PROCESSOR_SHARED_SECRET ?? workspaceHttpAuthToken;
  const stationEventsCacheRefreshEnabled = parseBoolean(
    env.STATION_EVENTS_CACHE_REFRESH_ENABLED,
    stationEventsEnabled,
  );
  const stationEventsCacheRefreshSecret = stationEventsAuthToken;

  if (workspaceHttpEventsEnabled && workspaceHttpEventsUrl.length === 0) {
    throw new Error(
      "WORKSPACE_HTTP_EVENTS_URL is required when WORKSPACE_HTTP_EVENTS_ENABLED=true",
    );
  }

  if (workspaceHttpEventsEnabled && workspaceHttpAuthToken.length === 0) {
    throw new Error("PROCESSOR_SHARED_SECRET is required when WORKSPACE_HTTP_EVENTS_ENABLED=true");
  }

  if ((dbEventsEnabled || pointsSplitEnrichEnabled) && dbEventsConnectionString.length === 0) {
    throw new Error(
      "DB_EVENTS_CONNECTION_STRING is required when DB_EVENTS_ENABLED=true or POINTS_SPLIT_ENRICH_ENABLED=true",
    );
  }

  if (fileEventsEnabled && fileEventsPath.length === 0) {
    throw new Error("FILE_EVENTS_PATH is required when FILE_EVENTS_ENABLED=true");
  }

  if (stationEventsEnabled && stationEventsUrl.length === 0) {
    throw new Error("STATION_EVENTS_URL is required when STATION_EVENTS_ENABLED=true");
  }

  if (stationEventsEnabled && stationEventsAuthToken.length === 0) {
    throw new Error("PROCESSOR_SHARED_SECRET is required when STATION_EVENTS_ENABLED=true");
  }

  if (stationEventsCacheRefreshEnabled && stationEventsCacheRefreshSecret.length === 0) {
    throw new Error(
      "PROCESSOR_SHARED_SECRET is required when STATION_EVENTS_CACHE_REFRESH_ENABLED=true",
    );
  }

  return {
    consoleEvents: {
      enabled: consoleEventsEnabled,
    },
    mqtt: {
      brokerUrl: env.MQTT_BROKER_URL ?? "",
      topic: env.MQTT_TOPIC ?? "#",
      username: env.MQTT_USERNAME ?? "",
      password: env.MQTT_PASSWORD ?? "",
    },
    workspaceHttp: {
      eventsEnabled: workspaceHttpEventsEnabled,
      eventsUrl: workspaceHttpEventsUrl,
      timeoutMs: parsePositiveInt(env.WORKSPACE_HTTP_TIMEOUT_MS, 2_000),
      authToken: workspaceHttpAuthToken,
    },
    dbEvents: {
      enabled: dbEventsEnabled,
      connectionString: dbEventsConnectionString,
      table: env.DB_EVENTS_TABLE ?? "PointValue",
      insertTimeoutMs: parsePositiveInt(env.DB_EVENTS_INSERT_TIMEOUT_MS, 2_000),
      batchWindowMs: parseNonNegativeInt(env.DB_EVENTS_BATCH_WINDOW_MS, 1_000),
      batchMaxRows: parsePositiveInt(env.DB_EVENTS_BATCH_MAX_ROWS, 100),
      runtime: {
        concurrency: parseOptionalPositiveInt(env.DB_EVENTS_RUNTIME_CONCURRENCY),
        queueCapacity: parseOptionalPositiveInt(env.DB_EVENTS_RUNTIME_QUEUE_CAPACITY),
        processTimeoutMs: parseOptionalPositiveInt(env.DB_EVENTS_RUNTIME_TIMEOUT_MS),
      },
    },
    fileEvents: {
      enabled: fileEventsEnabled,
      path: fileEventsPath,
    },
    uniqueTopics: {
      enabled: uniqueTopicsEnabled,
    },
    pointsSplitEnrich: {
      enabled: pointsSplitEnrichEnabled,
      mode: pointsSplitEnrichMode,
    },
    stationEvents: {
      enabled: stationEventsEnabled,
      url: stationEventsUrl,
      authToken: stationEventsAuthToken,
      timeoutMs: parsePositiveInt(env.STATION_EVENTS_TIMEOUT_MS, 10_000),
      tagFetchBatchSize: parsePositiveInt(env.STATION_EVENTS_TAG_FETCH_BATCH_SIZE, 100),
      prewarmTagCache: parseBoolean(env.STATION_EVENTS_PREWARM_TAG_CACHE, true),
      tagSnapshotCacheMaxEntries: parsePositiveInt(
        env.STATION_EVENTS_TAG_SNAPSHOT_CACHE_MAX_ENTRIES,
        50_000,
      ),
      runtime: {
        concurrency: parseOptionalPositiveInt(env.STATION_EVENTS_RUNTIME_CONCURRENCY),
        queueCapacity: parseOptionalPositiveInt(env.STATION_EVENTS_RUNTIME_QUEUE_CAPACITY),
        processTimeoutMs: parseOptionalPositiveInt(env.STATION_EVENTS_RUNTIME_TIMEOUT_MS),
      },
      cacheRefresh: {
        enabled: stationEventsCacheRefreshEnabled,
        host: env.STATION_EVENTS_CACHE_REFRESH_HOST ?? "0.0.0.0",
        port: parsePositiveInt(env.STATION_EVENTS_CACHE_REFRESH_PORT, 9465),
        path: env.STATION_EVENTS_CACHE_REFRESH_PATH ?? "/internal/cache/refresh",
        secret: stationEventsCacheRefreshSecret,
      },
    },
    metricsIntervalMs: parsePositiveInt(env.METRICS_INTERVAL_MS, 10_000),
    metricsServer: {
      enabled: parseBoolean(env.METRICS_ENABLED, true),
      host: env.METRICS_HOST ?? "0.0.0.0",
      port: parsePositiveInt(env.METRICS_PORT, 9464),
      path: env.METRICS_PATH ?? "/metrics",
    },
    shutdownDrainTimeoutMs: parsePositiveInt(env.SHUTDOWN_DRAIN_TIMEOUT_MS, 10_000),
    processorDefaults: {
      concurrency: parsePositiveInt(env.PROCESSOR_CONCURRENCY, 2),
      queueCapacity: parsePositiveInt(env.PROCESSOR_QUEUE_CAPACITY, 100),
      overflow: overflow === "drop_oldest" ? overflow : "drop_oldest",
      processTimeoutMs: parsePositiveInt(env.PROCESSOR_TIMEOUT_MS, 5_000),
    },
  };
}
