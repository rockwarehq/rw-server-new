// Role-keyed Prisma client factory.
//
// Each app/worker calls createPrismaClient(role) at boot. Pool size is chosen
// by role so total connections across all processes stay within the Postgres
// max_connections budget. DB_POOL_SIZE env var overrides if set.
//
// Total per tenant baseline:
//   api(5) + rollups(10) + processor(5) + processor-consumer(10) = 30

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";

export type DbRole = "api" | "rollups" | "processor" | "processor-consumer";

const DEFAULT_POOL: Record<DbRole, number> = {
  api: 5,
  rollups: 10,
  processor: 5,
  "processor-consumer": 10,
};

let cached: PrismaClient | null = null;

export function createPrismaClient(role: DbRole): PrismaClient {
  if (cached) return cached;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const poolSize = Number.parseInt(process.env.DB_POOL_SIZE ?? "", 10) || DEFAULT_POOL[role];

  // Client- and socket-level safety nets. Server-side GUCs were attempted via
  // the connection-string `?options=...` mechanism but PlanetScale's PG proxy
  // rejects unknown startup params with SQLSTATE 08P01, crashing on deploy.
  // keepAlive turns on TCP keepalive probes; query_timeout is the pg-node
  // per-query timer (best-effort cancel + destroy socket on expiry).
  const adapter = new PrismaPg({
    connectionString: url,
    max: poolSize,
    keepAlive: true,
    keepAliveInitialDelayMillis: 300_000,
    query_timeout: 600_000,
  });

  console.log(`[db] role=${role} pool=${poolSize}`);

  cached = new PrismaClient({ adapter });
  return cached;
}

export { PrismaClient } from "./generated/client.js";

// Lazy Prisma singleton.
//
// The host process (apps/api/main.ts, apps/workers/main.ts) calls
// createPrismaClient(role) at boot and seeds the cache above. The proxy's
// `get` trap defers resolution until first property access, so by the time
// any consumer touches `prisma.user.findMany(...)` the host has already
// initialized the cache with the correct role + pool size. The "api" role
// passed here is ignored — createPrismaClient short-circuits on the cache.
const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_, prop, receiver) {
    return Reflect.get(createPrismaClient("api"), prop, receiver);
  },
});
export default prisma;
