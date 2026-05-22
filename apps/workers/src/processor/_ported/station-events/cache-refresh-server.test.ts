import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { startStationEventsCacheRefreshServer } from "./cache-refresh-server.js";

const testLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe("station events cache refresh server", () => {
  test("accepts authorized refresh callbacks", async () => {
    const seenBodies: Array<{ operation: string }> = [];
    const server = await startStationEventsCacheRefreshServer({
      config: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        path: "/internal/cache/refresh",
        secret: "processor-secret",
      },
      logger: testLogger,
      async onRefresh(body) {
        seenBodies.push(body);
      },
    });

    assert.ok(server);

    try {
      const healthResponse = await fetch(`http://${server.host}:${server.port}/healthz`);
      assert.equal(healthResponse.status, 200);
      assert.equal(await healthResponse.text(), "ok");

      const response = await fetch(`http://${server.host}:${server.port}${server.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Processor processor-secret",
        },
        body: JSON.stringify({
          entity: "station_event",
          operation: "update",
          workspaceId: "workspace-1",
          stationId: "station-1",
          eventId: "event-1",
          occurredAt: new Date().toISOString(),
        }),
      });

      assert.equal(response.status, 202);
      assert.equal(seenBodies.length, 1);
      assert.equal(seenBodies[0]?.operation, "update");
    } finally {
      await server.close();
    }
  });
});
