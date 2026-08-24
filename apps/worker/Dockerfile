# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
# Pin pnpm. `corepack enable` on its own resolves to the newest pnpm, which is
# 11.x and requires the node:sqlite builtin that Node 20 does not ship — the
# build then dies with ERR_UNKNOWN_BUILTIN_MODULE. Corepack cannot read the
# `packageManager` field here because package.json is not yet in this layer,
# so the version is stated explicitly. Keep it in step with package.json.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /workspace

# ---- deps: install full workspace deps (needed to resolve workspace:* links) ----
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/frontend/package.json apps/frontend/package.json
# --ignore-scripts: some devDependencies build native binaries in their
# postinstall (redis-memory-server compiles Redis from source), which fails on
# alpine — no 'make' — and is pointless here since no image runs tests. The one
# postinstall that DOES matter, Prisma's client generation, is invoked
# explicitly by the database package's build script below.
RUN pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts

# ---- build: compile shared + database + worker ----
FROM base AS build
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/apps/worker/node_modules ./apps/worker/node_modules
# packages/shared is deliberately absent: it has no runtime dependencies, so
# pnpm creates no node_modules for it and COPY would fail with "not found".
COPY --from=deps /workspace/packages/database/node_modules ./packages/database/node_modules
COPY --from=deps /workspace/packages/queue/node_modules ./packages/queue/node_modules
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY packages/queue packages/queue
COPY apps/worker apps/worker
RUN pnpm --filter @payroll/shared build
RUN pnpm --filter @payroll/database build
RUN pnpm --filter @payroll/queue build
RUN pnpm --filter @payroll/worker build

# ---- prune: install production-only deps ----
FROM base AS prod-deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --prod --frozen-lockfile --filter @payroll/worker... || pnpm install --prod --filter @payroll/worker...

# ---- runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /workspace

COPY --from=prod-deps /workspace/node_modules ./node_modules
COPY --from=prod-deps /workspace/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=prod-deps /workspace/packages/database/node_modules ./packages/database/node_modules
COPY --from=prod-deps /workspace/packages/queue/node_modules ./packages/queue/node_modules
COPY --from=build /workspace/packages/shared/dist ./packages/shared/dist
COPY --from=build /workspace/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /workspace/packages/database/dist ./packages/database/dist
COPY --from=build /workspace/packages/database/package.json ./packages/database/package.json
COPY --from=build /workspace/packages/queue/dist ./packages/queue/dist
COPY --from=build /workspace/packages/queue/package.json ./packages/queue/package.json
COPY --from=build /workspace/packages/database/prisma ./packages/database/prisma
# The generated Prisma client lives in node_modules/.prisma; carry it over so
# the runtime image does not need the Prisma CLI to regenerate it.
COPY --from=build /workspace/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /workspace/apps/worker/dist ./apps/worker/dist
COPY --from=build /workspace/apps/worker/package.json ./apps/worker/package.json

WORKDIR /workspace/apps/worker
CMD ["node", "dist/main.js"]
