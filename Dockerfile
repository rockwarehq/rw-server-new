# syntax=docker/dockerfile:1.6
# Multi-target build for the rw-server-new monorepo.
#
# Build:   docker build --target api     -t <tenant>-api     .
#          docker build --target workers -t <tenant>-workers .
# Deploy:  flyctl deploy --build-target api     -c apps/api/fly.generated.toml
#          flyctl deploy --build-target workers -c apps/workers/fly.generated.toml

# ─────────────────────────────────────────────────────────────────────────────
# Shared base
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24.13.0-alpine AS base
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate


# ─────────────────────────────────────────────────────────────────────────────
# 1. Install ALL workspace deps + generate Prisma client
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json .npmrc ./
COPY packages/db/package.json packages/db/
COPY packages/services/package.json packages/services/
COPY packages/infra/package.json packages/infra/
COPY apps/api/package.json apps/api/
COPY apps/workers/package.json apps/workers/

COPY packages/db/schema packages/db/schema/
COPY packages/db/prisma.config.ts packages/db/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

RUN pnpm db:generate


# ─────────────────────────────────────────────────────────────────────────────
# 2. Compile TypeScript across the workspace
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY packages packages
COPY apps apps
RUN pnpm build


# ─────────────────────────────────────────────────────────────────────────────
# 3a. Production deps for api (pruned to @rw/api's transitive set)
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS prod-deps-api
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/services/package.json packages/services/
COPY packages/infra/package.json packages/infra/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter '@rw/api...'


# ─────────────────────────────────────────────────────────────────────────────
# 3b. Production deps for workers (pruned to @rw/workers's transitive set)
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS prod-deps-workers
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/workers/package.json apps/workers/
COPY packages/db/package.json packages/db/
COPY packages/services/package.json packages/services/
COPY packages/infra/package.json packages/infra/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter '@rw/workers...'


# ─────────────────────────────────────────────────────────────────────────────
# 4a. api runtime image
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS api
ENV NODE_ENV=production

COPY --from=prod-deps-api /repo/node_modules ./node_modules
COPY --from=prod-deps-api /repo/apps/api/node_modules apps/api/node_modules
COPY --from=prod-deps-api /repo/packages/db/node_modules packages/db/node_modules
COPY --from=prod-deps-api /repo/packages/services/node_modules packages/services/node_modules
COPY --from=prod-deps-api /repo/packages/infra/node_modules packages/infra/node_modules

COPY --from=build /repo/packages/db/dist packages/db/dist
COPY --from=build /repo/packages/db/src/generated packages/db/src/generated
COPY --from=build /repo/packages/db/schema packages/db/schema
COPY --from=build /repo/packages/db/migrations packages/db/migrations
COPY --from=build /repo/packages/db/prisma.config.ts packages/db/
COPY --from=build /repo/packages/db/package.json packages/db/
COPY --from=build /repo/packages/services/dist packages/services/dist
COPY --from=build /repo/packages/services/package.json packages/services/
COPY --from=build /repo/packages/infra/dist packages/infra/dist
COPY --from=build /repo/packages/infra/package.json packages/infra/
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/package.json apps/api/

# Workspace metadata so fly's [deploy] release_command can run
# `pnpm -w db:migrate` (which resolves to `pnpm --filter @rw/db prisma:migrate`).
COPY --from=build /repo/pnpm-workspace.yaml /repo/package.json ./

WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]


# ─────────────────────────────────────────────────────────────────────────────
# 4b. workers runtime image — fly process groups override CMD with --worker
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS workers
ENV NODE_ENV=production

COPY --from=prod-deps-workers /repo/node_modules ./node_modules
COPY --from=prod-deps-workers /repo/apps/workers/node_modules apps/workers/node_modules
COPY --from=prod-deps-workers /repo/packages/db/node_modules packages/db/node_modules
COPY --from=prod-deps-workers /repo/packages/services/node_modules packages/services/node_modules
COPY --from=prod-deps-workers /repo/packages/infra/node_modules packages/infra/node_modules

COPY --from=build /repo/packages/db/dist packages/db/dist
COPY --from=build /repo/packages/db/src/generated packages/db/src/generated
COPY --from=build /repo/packages/db/schema packages/db/schema
# migrations/ is needed by fly's [deploy] release_command ('pnpm db:migrate')
# which runs in a temporary machine from this image before main rollout.
COPY --from=build /repo/packages/db/migrations packages/db/migrations
COPY --from=build /repo/packages/db/prisma.config.ts packages/db/
COPY --from=build /repo/packages/db/package.json packages/db/
COPY --from=build /repo/packages/services/dist packages/services/dist
COPY --from=build /repo/packages/services/package.json packages/services/
COPY --from=build /repo/packages/infra/dist packages/infra/dist
COPY --from=build /repo/packages/infra/package.json packages/infra/
COPY --from=build /repo/apps/workers/dist apps/workers/dist
COPY --from=build /repo/apps/workers/package.json apps/workers/

# Workspace metadata for `pnpm db:migrate` (run by fly's release_command).
COPY --from=build /repo/pnpm-workspace.yaml /repo/package.json ./

WORKDIR /repo/apps/workers
EXPOSE 9465
CMD ["node", "dist/main.js", "--worker", "rollups"]
