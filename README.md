# rw-server-new (working name — will replace `rw-server`)

Monorepo consolidating `rw-server` and `rw-processor` into one workspace with
two deployables per tenant:

- **`apps/api`** — Fastify/oRPC HTTP server plus in-process BullMQ workers
  (stale-gateway-check, replay-reconcile, station-detect, dev-cycle-simulator).
  Today it boots ALL background workers in-process (matching the old
  `SINGLE_PROCESS=1` mode); workers move out to `apps/workers` one at a time
  during cutover.
- **`apps/workers`** — single binary, three startup modes selected by
  `--worker <name>`:
  - `rollups` — metric-bucket-ensure, metrics combined-tick, archive,
    shift-bucket-create, shift-change.
  - `processor` — MQTT ingest (ported from `rw-processor`, still being
    integrated — see `apps/workers/src/workers/processor/index.ts`).
  - `processor-consumer` — station-event-execution (was
    `rw-server/src/cycle-worker.ts`).

The two worker modes that read from BullMQ (`rollups`, `processor-consumer`)
import their worker registrations from `@rw/api/...` — no source duplication,
just different startup composition.

Shared:

- **`packages/db`** — Prisma schema (lifted from `rw-server/prisma/`),
  migrations, generated client. `createPrismaClient(role)` factory sizes the
  pool per-process. `classifyDbTimeout()` lives here too.
- **`packages/runtime`** — events-bus (Redis pub/sub bridge), BullMQ tuning,
  logger, http-host (healthz/readyz/metrics tiny server), lifecycle (SIGTERM +
  drain timeout), shared job-payload types.

## Layout

```
rw-server-new/
├── pnpm-workspace.yaml
├── tsconfig.base.json + tsconfig.json (root project references)
├── apps/
│   ├── api/      (Dockerfile + fly/base.toml + fly/tenants/{sim,dixie,dev}.toml)
│   └── workers/  (Dockerfile + fly/base.toml + fly/tenants/{sim,dixie,dev}.toml)
├── packages/
│   ├── db/       (schema + migrations + generated client)
│   └── runtime/  (shared runtime)
└── scripts/
    └── fly-deploy.ts
```

## Workspace commands

```sh
pnpm install
pnpm build                              # tsc -b across all packages
pnpm db:generate                        # prisma generate
pnpm db:migrate                         # prisma migrate deploy
pnpm db:migrate:dev                     # prisma migrate dev
pnpm db:seed
pnpm fly:generate --app api sim         # write apps/api/fly.generated.toml
pnpm fly:deploy   --app workers dixie   # validate secrets, deploy workers
```

## Deployment

Each tenant has **two fly apps** — one for `api`, one for `workers`. App
names come from the `app = '...'` line in each tenant toml. Tenant configs
live at `apps/api/fly/tenants/<tenant>.toml` and
`apps/workers/fly/tenants/<tenant>.toml`.

### Tenant matrix

| Tenant | api app | workers app | api domain | MQTT broker |
|---|---|---|---|---|
| dev | `rw-dev-api` | `dev-processor` ¹ | `dev-api.rockware.io` | `dev-mqtt.rockware.io` |
| sim | `sim-api` | `sim-workers` | `sim-api.rockware.io` | `sim-mqtt.fly.dev` |
| dixie | `dixie-api` | `dixie-workers` | `dixie-api.rockware.io` | `dixie-mqtt.fly.dev` |

¹ Dev temporarily reuses the suspended `dev-processor` fly app (preserves
existing DNS / secrets during cutover). Rename to `rw-dev-workers` when
convenient.

### Migrations run inside fly

Both apps' `base.toml` declares:

```toml
[deploy]
release_command = 'pnpm -w db:migrate'
```

Fly spins up a temporary machine before each rollout, runs the migration
against `DATABASE_URL_MIGRATION` (a direct/non-pgbouncer endpoint set as a
fly secret), and aborts the deploy if it fails. **No separate migration
step in CI or locally** — just `flyctl deploy`.

### First deploy for a new tenant

```sh
# 1. Create both fly apps on the rockware org
flyctl apps create <tenant>-api      --org rockware
flyctl apps create <tenant>-workers  --org rockware

# 2. Set required secrets on each. Lists live in
#    apps/{api,workers}/fly/tenants/<tenant>.toml under [_meta].required_secrets.
#    PROCESSOR_SHARED_SECRET and REDIS_URL MUST be identical on the two apps.
flyctl secrets set -a <tenant>-api \
  DATABASE_URL='postgresql://...pooled/...' \
  DATABASE_URL_MIGRATION='postgresql://...direct/...' \
  REDIS_URL='...' \
  JWT_SECRET='...' \
  RESEND_API_KEY='...' \
  PROCESSOR_SHARED_SECRET='...' \
  MQTT_GATEWAY_REALY_URL='...' MQTT_GATEWAY_REALY_USER='...' MQTT_GATEWAY_REALY_PASSWORD='...'

flyctl secrets set -a <tenant>-workers \
  DATABASE_URL='postgresql://...pooled/...' \
  DATABASE_URL_ROLLUPS='postgresql://...direct/...' \
  DATABASE_URL_MIGRATION='postgresql://...direct/...' \
  REDIS_URL='...' \
  PROCESSOR_SHARED_SECRET='...' \
  MQTT_PASSWORD='...'

# 3. Pin machine count per workers process group (fly.toml has no count field).
#    Set once; subsequent deploys preserve it.
flyctl scale count -a <tenant>-workers rollups=1 processor=1 processor_consumer=1 --yes

# 4. Deploy api first (so workers/processor can reach api on boot)
pnpm fly:deploy --app api      <tenant>
pnpm fly:deploy --app workers  <tenant>
```

### Routine deploys

From your laptop (uses Docker + flyctl, pushes to fly's registry):

```sh
pnpm fly:deploy --app api      <tenant>
pnpm fly:deploy --app workers  <tenant>
```

Or via GitHub Actions — workflow file at `.github/workflows/fly-deploy.yml`,
trigger via the "Deploy to Fly.io" workflow → Run workflow → pick `tenant`
and `app=both` (or `api`/`workers` to deploy one side only). Only repo
secret needed: `FLY_API_TOKEN`.

### Deploying API

`apps/api` is the Fastify/oRPC HTTP server plus four in-process BullMQ
workers (stale-gateway-check, replay-reconcile, station-detect,
dev-cycle-simulator).

- **Port**: bound to `[::]:3000` (IPv6 dual-stack; required for cross-app
  traffic on fly's 6PN network — see [Fly IPv6 binding](#fly-cross-app-traffic-is-ipv6))
- **Public domain**: `<tenant>-api.rockware.io` (TLS via fly's auto-cert)
- **Internal address**: `<tenant>-api.internal:3000` (workers reach api here)
- **In-process workers**: yes — these stay co-located with the HTTP server
- **Bridges**: `events-bus` + `metrics-bus` in `both` mode (publish own
  events to Redis + subscribe to others' — safe for horizontal scaling)

To scale api horizontally:

```sh
flyctl scale count -a <tenant>-api app=2 --yes
```

SSE subscribers route via fly proxy to one machine; the `both`-mode buses
make sure cross-machine events still reach every client.

### Deploying Workers

`apps/workers` is one binary, three process groups (one per `--worker`
flag). Each group is a separate machine — fly's `[processes]` section in
`workers/fly/base.toml` defines the commands.

| Group | Command | Role |
|---|---|---|
| `rollups` | `--worker rollups` | metric-bucket-ensure, combined tick, archive, shift-bucket-create, shift-change |
| `processor` | `--worker processor` | MQTT ingest (subscribes to tenant's broker) |
| `processor_consumer` | `--worker processor-consumer` | station-event-execution BullMQ consumer |

- **Internal-only**: no public HTTP, no domain. Only `<tenant>-workers.internal:9465`
  for healthz (and 9468 for cache-refresh once enabled).
- **Per-mode DB URL**: rollups uses `DATABASE_URL_ROLLUPS` (direct, no
  pgbouncer) because the CTE-heavy rollup tick doesn't play with
  transaction-mode pgbouncer. Other modes use `DATABASE_URL` (pooled).
- **Machine count**: set explicitly via `flyctl scale count` (no toml field).
  See "Recovering a stopped machine" if a process group drops to a stopped
  machine.

Per-group scaling examples:

```sh
# More processor_consumer machines for higher cycle throughput
flyctl scale count -a <tenant>-workers processor_consumer=2 --yes

# Rollups stays at 1 — there's no benefit to multiple rollups machines
# (the combined tick is a singleton). Don't scale this up.
```

### Recovering a stopped machine

When a machine hits fly's 10-restart-loop limit it enters a "give-up"
state. Subsequent `flyctl deploy` runs update its image but **don't
restart it**. Recovery:

```sh
flyctl machines list -a <tenant>-workers           # find STATE: stopped
flyctl machine start <id> -a <tenant>-workers
```

Or destroy and let scale-count recreate it fresh:

```sh
flyctl machine destroy <id> -a <tenant>-workers --force
flyctl scale count -a <tenant>-workers <group>=1 --yes
```

### Postgres `max_connections` budget when scaling

Per-tenant peak connections at 1 machine of each group, default pool sizes:

```
api(5) + rollups(10) + processor(5) + processor-consumer(10) = 30
```

10 of those are direct (rollups bypassing pgbouncer); the other 20 go
through pgbouncer's server pool. With PSDB dev (`max_connections=25`),
that doesn't fit — dev uses `DB_POOL_SIZE='5'` in `workers/fly/tenants/dev.toml`
to halve everything (~20 total, leaves room for the migration's 1 direct
connection). Prod tenants on larger DBs can use defaults.

When you scale `processor_consumer=2` in prod, that adds 10 more pgbouncer
client connections — usually fine because pgbouncer's server pool stays
bounded by its own config.

### Fly cross-app traffic is IPv6

Apps reach each other on fly's 6PN private network via `<app>.internal`
DNS — which resolves to **IPv6 only**. The api binds to `'::'` (IPv6
dual-stack, accepts both IPv4 and IPv6 via Linux's `IPV6_V6ONLY=0` default).
Binding to `'0.0.0.0'` would silently break cross-app traffic — fly's own
health checks come from an IPv4 NAT range and still pass, masking the bug.

If you see `fetch failed` in workers logs trying to reach api, this is
almost certainly the cause. See `apps/api/src/config.ts` and
`packages/runtime/src/http-host.ts`.

### Verify after deploy

```sh
# Health check (api)
curl https://<tenant>-api.rockware.io/health

# Bus initialization (api should log mode=both, workers mode=publisher)
flyctl logs -a <tenant>-api      | grep -E "(events|metrics)-bus.*mode="
flyctl logs -a <tenant>-workers  | grep -E "(events|metrics)-bus.*mode="

# Rollup tick cadence (should be ~5s intervals)
flyctl logs -a <tenant>-workers  | grep "metrics:tick.*stations in"

# MQTT → triggerEvent flow (cycle pipeline working)
flyctl logs -a <tenant>-api      | grep "/rpc/station/triggerEvent"
```

## Status

- Phase 0 (skeleton + shared packages): done.
- Phase 1 (lift rw-server into `apps/api` with `@rw/db` / `@rw/runtime` rewiring): done.
- Phase 2 (apps/workers binary + all three modes — rollups + processor + processor-consumer): done.
- fly.io configs (base + dev/sim/dixie tenants) + multi-target Dockerfile + workspace fly-deploy.ts: done.
- GitHub Actions deploy workflow + biome lint config: done.
- Dev deploy live on `rw-dev-api` + `dev-processor` — pipeline verified end-to-end:
  MQTT → processor → api `triggerEvent` → BullMQ → processor-consumer → cycle.complete.
- SSE bridges (`events-bus` + `metrics-bus`) operating in `both` mode on api,
  `publisher` mode on workers — safe for horizontal api scaling.

Next:

- First deploys of sim and dixie tenants (configs ready in `fly/tenants/`).
- Cache-refresh server: pick a port that doesn't collide with healthz (e.g.,
  9468), expose in workers `[[services]]`, set `PROCESSOR_CACHE_REFRESH_URL`
  on api side, flip `STATION_EVENTS_CACHE_REFRESH_ENABLED='true'` per tenant.
- Per-tenant `max_connections` review (PSDB dev's 25-conn cap is tight; prod
  tenants likely have more headroom — confirm before raising worker pool sizes).
- Port the CI workflow from rw-server (`ci.yml` — lint + unit + component
  + integration tests).

See `/home/michael/.claude/plans/i-d-like-to-moved-jaunty-flamingo.md` for the
original migration plan.
