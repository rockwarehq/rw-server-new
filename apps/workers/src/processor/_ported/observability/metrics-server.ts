import http, { type Server } from "node:http";

import { getMetricsContentType, renderMetricsText } from "../pipeline/metrics.js";
import type { Logger } from "../pipeline/types.js";

export interface MetricsServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
}

export interface StartedMetricsServer {
  host: string;
  port: number;
  path: string;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startMetricsServer(args: {
  config: MetricsServerConfig;
  logger: Logger;
}): Promise<StartedMetricsServer | null> {
  if (!args.config.enabled) {
    args.logger.info("metrics server disabled");
    return null;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === args.config.path) {
      try {
        const body = await renderMetricsText();
        response.statusCode = 200;
        response.setHeader("Content-Type", getMetricsContentType());
        response.end(body);
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("ok");
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.config.port, args.config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addressInfo = server.address();
  const port = typeof addressInfo === "object" && addressInfo ? addressInfo.port : args.config.port;

  args.logger.info("metrics server listening", {
    host: args.config.host,
    port,
    path: args.config.path,
  });

  return {
    host: args.config.host,
    port,
    path: args.config.path,
    close: () => closeServer(server),
  };
}
