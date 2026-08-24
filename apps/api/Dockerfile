# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
RUN corepack enable
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
RUN pnpm install --frozen-lockfile || pnpm install

# ---- build: compile shared + database + api ----
FROM base AS build
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /workspace/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /workspace/packages/database/node_modules ./packages/database/node_modules
COPY --from=deps /workspace/packages/queue/node_modules ./packages/queue/node_modules
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY packages/queue packages/queue
COPY apps/api apps/api
RUN pnpm --filter @payroll/shared build
RUN pnpm --filter @payroll/database build
RUN pnpm --filter @payroll/queue build
RUN pnpm --filter @payroll/api build

# ---- prune: install production-only deps ----
FROM base AS prod-deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --prod --frozen-lockfile --filter @payroll/api... || pnpm install --prod --filter @payroll/api...

# ---- runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /workspace

COPY --from=prod-deps /workspace/node_modules ./node_modules
COPY --from=prod-deps /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /workspace/packages/shared/node_modules ./packages/shared/node_modules
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
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json

WORKDIR /workspace/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]

# ---- migrate: schema-migration runner used by the `migrate` compose service ----
# Keeps the full (dev-inclusive) dependency tree so the Prisma CLI is present.
# Not used to serve traffic, so image leanness matters less here.
FROM base AS migrate
ENV NODE_ENV=production
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/database ./packages/database
COPY package.json pnpm-workspace.yaml ./
WORKDIR /workspace/packages/database
CMD ["npx", "prisma", "migrate", "deploy"]
