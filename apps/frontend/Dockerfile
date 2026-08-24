# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
# Pin pnpm. `corepack enable` on its own resolves to the newest pnpm, which is
# 11.x and requires the node:sqlite builtin that Node 20 does not ship — the
# build then dies with ERR_UNKNOWN_BUILTIN_MODULE. Corepack cannot read the
# `packageManager` field here because package.json is not yet in this layer,
# so the version is stated explicitly. Keep it in step with package.json.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /workspace

# ---- deps ----
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/queue/package.json packages/queue/package.json
# --ignore-scripts: some devDependencies build native binaries in their
# postinstall (redis-memory-server compiles Redis from source), which fails on
# alpine — no 'make' — and is pointless here since no image runs tests. The
# frontend build needs no postinstall step of its own.
RUN pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts

# ---- build ----
FROM base AS build
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/apps/frontend/node_modules ./apps/frontend/node_modules
COPY tsconfig.base.json ./
# The Vite config aliases @payroll/shared to its TypeScript source (the built
# output is CommonJS, which Rollup cannot tree-shake named exports from), so
# the source has to be present at build time.
COPY packages/shared packages/shared
COPY apps/frontend apps/frontend

# Vite inlines VITE_* variables at BUILD time, not runtime, so this has to be a
# build arg. Left empty by default, which makes the app call /api on its own
# origin and lets the nginx proxy below handle it.
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @payroll/frontend build

# ---- runtime: static file server ----
FROM nginx:1.27-alpine AS runtime
# Replaces the default server block: adds the SPA fallback and the API proxy.
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/frontend/dist /usr/share/nginx/html
EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
