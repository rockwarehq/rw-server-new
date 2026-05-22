import http, { type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

export interface StationEventsCacheRefreshConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
  secret: string;
}

export interface StartedStationEventsCacheRefreshServer {
  host: string;
  port: number;
  path: string;
  close(): Promise<void>;
}

interface CacheRefreshBody {
  entity: "station_event";
  operation: "create" | "update" | "toggle" | "delete";
  workspaceId: string;
  stationId: string;
  eventId: string;
  occurredAt: string;
}

function isCacheRefreshBody(value: unknown): value is CacheRefreshBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.entity === "station_event" &&
    (candidate.operation === "create" ||
      candidate.operation === "update" ||
      candidate.operation === "toggle" ||
      candidate.operation === "delete") &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.stationId === "string" &&
    typeof candidate.eventId === "string" &&
    typeof candidate.occurredAt === "string"
  );
}

function safeSecretEquals(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
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

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export async function startStationEventsCacheRefreshServer(args: {
  config: StationEventsCacheRefreshConfig;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  onRefresh(body: CacheRefreshBody): Promise<void>;
}): Promise<StartedStationEventsCacheRefreshServer | null> {
  if (!args.config.enabled) {
    return null;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/healthz") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("ok");
      return;
    }

    if (request.method === "POST" && url.pathname === args.config.path) {
      const authorizationHeader = request.headers.authorization;
      if (!authorizationHeader || !authorizationHeader.startsWith("Processor ")) {
        response.statusCode = 401;
        response.end("processor authorization required");
        return;
      }

      const providedSecret = authorizationHeader.slice("Processor ".length);
      if (!safeSecretEquals(args.config.secret, providedSecret)) {
        response.statusCode = 401;
        response.end("invalid processor secret");
        return;
      }

      let rawBody = "";
      try {
        rawBody = await readBody(request);
      } catch (error) {
        response.statusCode = 400;
        response.end(error instanceof Error ? error.message : String(error));
        return;
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        response.statusCode = 400;
        response.end("invalid_json");
        return;
      }

      if (!isCacheRefreshBody(parsedBody)) {
        response.statusCode = 400;
        response.end("invalid_payload");
        return;
      }

      try {
        await args.onRefresh(parsedBody);
        response.statusCode = 202;
        response.end("accepted");
      } catch (error) {
        args.logger.warn("station event cache refresh callback failed", {
          cache: "station-events",
          operation: parsedBody.operation,
          stationId: parsedBody.stationId,
          eventId: parsedBody.eventId,
          error: error instanceof Error ? error.message : String(error),
        });
        response.statusCode = 500;
        response.end("refresh_failed");
      }
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

  args.logger.info("station event cache refresh server listening", {
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
