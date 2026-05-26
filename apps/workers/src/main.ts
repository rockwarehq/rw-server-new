// Workers binary. Dispatches on --worker flag to one of three modules.

process.env.TZ = "UTC";

import "dotenv/config";
import { startHostServer, onShutdown } from "@rw/runtime";
import { createPrismaClient } from "@rw/db";

type WorkerName = "rollups" | "processor" | "processor-consumer";
const WORKER_NAMES: readonly WorkerName[] = ["rollups", "processor", "processor-consumer"];

function parseFlag(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function loadWorker(name: WorkerName): Promise<{ start: () => Promise<void>; stop: () => Promise<void> }> {
  switch (name) {
    case "rollups": {
      const m = await import("./rollups.js");
      return { start: m.startRollups, stop: m.stopRollups };
    }
    case "processor": {
      const m = await import("./processor/index.js");
      return { start: m.startProcessor, stop: m.stopProcessor };
    }
    case "processor-consumer": {
      const m = await import("./processor-consumer.js");
      return { start: m.startProcessorConsumer, stop: m.stopProcessorConsumer };
    }
  }
}

async function main(): Promise<void> {
  const requested = parseFlag("--worker") ?? process.env.WORKER ?? null;
  if (!requested || !(WORKER_NAMES as readonly string[]).includes(requested)) {
    console.error(`[workers] usage: --worker <${WORKER_NAMES.join("|")}>`);
    console.error(`[workers] received: ${requested}`);
    process.exit(1);
  }

  const name = requested as WorkerName;

  // Per-mode DATABASE_URL override. Rollups want a DIRECT (port 5432, not
  // pgbouncer at 6432) connection because the rollup tick runs long CTE
  // queries that pgbouncer transaction-mode either breaks or holds open for
  // the whole transaction (defeating the pool). Other modes (processor,
  // processor-consumer) keep using the shared pooled DATABASE_URL.
  //
  // If DATABASE_URL_ROLLUPS is unset, rollups falls back to DATABASE_URL —
  // fine for local dev where both endpoints are the same Postgres.
  const ROLE_DB_URL: Partial<Record<WorkerName, string | undefined>> = {
    rollups: process.env.DATABASE_URL_ROLLUPS,
  };
  const override = ROLE_DB_URL[name];
  if (override) {
    process.env.DATABASE_URL = override;
    console.log(`[workers] DATABASE_URL_${name.toUpperCase().replaceAll("-", "_")} override applied`);
  }

  // Initialize Prisma with this worker's role BEFORE dynamic-importing the
  // worker module. The worker imports @rw/services transitively, which calls
  // createPrismaClient("api") at module-eval. The first call wins on pool
  // sizing, so we have to win the race here with the actual role.
  createPrismaClient(name);

  const entry = await loadWorker(name);

  const port = Number.parseInt(process.env.PORT ?? "", 10) || 9465;
  let ready = false;

  const host = startHostServer({
    port,
    isReady: () => ready,
    isHealthy: () => true,
  });

  console.log(`[workers] starting ${name} on port ${port}`);
  await entry.start();
  ready = true;
  console.log(`[workers] ${name} ready`);

  onShutdown(async () => {
    console.log(`[workers] stopping ${name}`);
    ready = false;
    await entry.stop();
    await host.close();
  });
}

main().catch((err) => {
  console.error("[workers] failed to start:", err);
  process.exit(1);
});
