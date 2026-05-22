import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createMetrics } from "../pipeline/metrics.js";
import { startMetricsServer } from "./metrics-server.js";

const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe("metrics server", () => {
  test("exposes prometheus metrics and health endpoint", async () => {
    const metrics = createMetrics();
    metrics.incParsedOk();
    metrics.incParseError();
    metrics.incSubmitted("console");
    metrics.incProcessedOk("console");
    metrics.setQueueDepth("console", 3);
    metrics.setInFlight("console", 1);

    const server = await startMetricsServer({
      config: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        path: "/metrics",
      },
      logger: testLogger,
    });

    assert.ok(server);

    try {
      const metricsResponse = await fetch(`http://${server.host}:${server.port}${server.path}`);
      assert.equal(metricsResponse.status, 200);

      const metricsBody = await metricsResponse.text();
      assert.ok(metricsBody.includes("event_processor_parsed_total"));
      assert.ok(metricsBody.includes("event_processor_queue_depth"));
      assert.ok(metricsBody.includes("event_processor_up"));

      const healthResponse = await fetch(`http://${server.host}:${server.port}/healthz`);
      assert.equal(healthResponse.status, 200);
      assert.equal(await healthResponse.text(), "ok");
    } finally {
      await server.close();
    }
  });
});
