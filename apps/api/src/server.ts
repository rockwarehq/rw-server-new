import Fastify from "fastify";
import type { JsonSchemaToTsProvider } from "@fastify/type-provider-json-schema-to-ts";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";

import closeWithGrace from "close-with-grace";
import type { IServerOptions } from "./types.js";
import type { SerializerSchemaOptions } from "./types/fastify.js";
import { stopStaleGatewayCheck } from "@rw/services/queues/background-workers";
import { stopQueues } from "@rw/services/queues/station-detection";
import { stopMetricBucketQueues } from "@rw/services/queues/metric-buckets";
import { authPlugin } from "./services/auth/index.js";
import swaggerPlugin from "./plugins/swagger.js";
import rateLimitPlugin from "./plugins/ratelimit.js";
import api from "./api/index.js";
import edge from "./edge.js";
import { RPCHandler } from "@orpc/server/fastify";
import { router } from "./rpc/index.js";

// Per-request unhandled rejections (most commonly AbortError from clients
// disconnecting mid-stream on RPC subscriptions) shouldn't take the whole
// process down. Register a logger so Node doesn't escalate to an uncaught
// exception, and below we tell close-with-grace to skip this event so it
// doesn't trigger a graceful shutdown either. uncaughtException is still
// handled by close-with-grace, since those are usually truly fatal.
let unhandledRejectionLoggerInstalled = false;

export function createServer(options: IServerOptions) {
  const server = Fastify({ logger: true }).withTypeProvider<
    JsonSchemaToTsProvider<{ SerializerSchemaOptions: SerializerSchemaOptions }>
  >();

  // Register plugins
  server.register(cors, {
    origin: true, // Allow all origins in development (configure for production)
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });
  server.register(sensible);
  server.register(rateLimitPlugin);
  server.register(swaggerPlugin);
  server.register(authPlugin);

  // Admin API
  server.register(api);

  // Edge API (gateway-to-server protocol)
  server.register(edge, { prefix: "/edge" });

  // oRPC handler
  const rpcHandler = new RPCHandler(router);

  server.all("/rpc/*", async (req, reply) => {
    try {
      const { matched } = await rpcHandler.handle(req, reply, {
        prefix: "/rpc",
        context: {
          request: req,
          iam: req.iam,
        },
      });

      if (!matched) {
        reply.status(404).send({ error: "Procedure not found" });
      }
    } catch (err) {
      // Client disconnected mid-response: oRPC's standard-server-node aborts
      // its writer and rejects with AbortError. The socket is already closed,
      // so there's nothing to respond with — just swallow it. Letting it
      // escape triggers close-with-grace's unhandledRejection handler and
      // kills the process.
      if ((err as { name?: string })?.name === "AbortError") return;
      throw err;
    }
  });

  if (!unhandledRejectionLoggerInstalled) {
    unhandledRejectionLoggerInstalled = true;
    process.on("unhandledRejection", (reason) => {
      server.log.error({ err: reason }, "unhandled promise rejection");
    });
  }

  closeWithGrace({ delay: options.graceDelay, skip: ["unhandledRejection"] }, async ({ signal, err }) => {
    if (err) {
      server.log.error({ err }, "server closing with error");
    } else {
      server.log.info(`${signal} received, server closing`);
    }
    await Promise.all([server.close(), stopQueues(), stopMetricBucketQueues(), stopStaleGatewayCheck()]);
  });

  const start = async () => {
    try {
      await server.listen({ port: options.port, host: options.host });
      console.log("listening on port", options.port);
    } catch (err) {
      server.log.error(err);
      process.exit(1);
    }
  };

  return { server, start };
}
