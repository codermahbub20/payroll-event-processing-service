# Payroll Event Processing Service

Asynchronous processing of payroll change events — submit an event over HTTP, a worker
applies it against a (simulated) payroll provider, and the UI shows the state change
happen live.

| | |
|---|---|
| **API** | NestJS · http://localhost:3000 · docs at `/api/docs` |
| **Worker** | BullMQ consumer · health on :3001 |
| **Frontend** | Vite + React · http://localhost:5173 |
| **Storage** | PostgreSQL (events + audit) · Redis (queue + ordering locks) |

Design rationale lives in [`docs/decisions.md`](./docs/decisions.md) and
[`docs/database-design.md`](./docs/database-design.md). Copy-pasteable requests are in
[`docs/api-examples.md`](./docs/api-examples.md).

---

## Getting Started

### Everything at once (Docker)

```bash
cp .env.example .env
docker compose up --build
```

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API | http://localhost:3000 |
| Swagger UI | http://localhost:3000/api/docs |
| API health | http://localhost:3000/health |

Migrations run automatically: a one-shot `migrate` service applies them before `api` and
`worker` start.

### Locally, without Docker

Requires Node 20+, pnpm 9+, and Postgres + Redis reachable.

```bash
pnpm install
pnpm db:migrate          # apply migrations
pnpm --filter @payroll/shared build
pnpm --filter @payroll/database build
pnpm --filter @payroll/queue build

pnpm dev:api             # terminal 1 — http://localhost:3000
pnpm dev:worker          # terminal 2
pnpm dev:frontend        # terminal 3 — http://localhost:5173
```

---

## Frontend

Three screens: **Submit**, **Events list**, **Event detail**.

The detail page polls `GET /events/:id` every 2 seconds while the event is `PENDING` or
`PROCESSING`, so a reviewer can watch an event move `PENDING → PROCESSING → SUCCEEDED`
without refreshing. Polling stops automatically once the status is terminal.

### Standalone (`npm run dev`)

```bash
cd apps/frontend
pnpm install          # or: npm install
pnpm dev              # or: npm run dev  →  http://localhost:5173
```

The dev server proxies `/api/*` to `http://localhost:3000`, so **the API must be running
separately** (see above). No CORS configuration is needed — the browser only ever talks
to one origin.

Point it at an API on a different host with:

```bash
VITE_API_TARGET=http://localhost:3060 pnpm dev
```

Other commands:

```bash
pnpm build      # production bundle into dist/
pnpm preview    # serve that bundle on :4173, same proxy behaviour
npx tsc --noEmit  # typecheck
```

### Via docker-compose

```bash
docker compose up --build frontend
```

The frontend image is a multi-stage build: Vite compiles the bundle, then nginx serves
the static output. Its nginx config does two things the static files cannot:

- **SPA fallback** — `/events/:id` is a client-side route with no file on disk, so
  unmatched paths return `index.html`. Without this a deep link or a page refresh 404s.
- **API proxy** — `/api/*` is forwarded to the `api` service with the prefix stripped, so
  the browser talks to one origin in production too.

Override the API origin at build time if the two are served from different hosts:

```bash
docker compose build --build-arg VITE_API_BASE_URL=https://api.example.com frontend
```

### Why the `/api` prefix

The SPA owns `/events` and `/events/:id` in the address bar, and so does the API. Calls
go through `/api/*` (stripped by the proxy) so that navigating to
`http://localhost:5173/events` renders the app rather than returning raw JSON. The one
exception is `/api/docs`, proxied verbatim because the API really does serve Swagger UI
there.

---

## Trying it end to end

1. Open http://localhost:5173/submit
2. Pick an event type — the form fields change to match it.
3. Use the example employee ID, fill the fields, submit.
4. Follow the **"Watch it process →"** link in the success message.
5. The detail page shows a live indicator and the status flips to `SUCCEEDED` (or a
   failure) within a few seconds as the worker picks it up.

The worker's simulated provider takes 500–3000 ms and fails ~20% of the time
(retryable) plus ~5% permanently. Make it deterministic for a demo:

```bash
SIMULATED_TEMPORARY_FAILURE_RATE=0 SIMULATED_PERMANENT_FAILURE_RATE=0 pnpm dev:worker
```

To see the failure UI instead, submit a salary above the ceiling (e.g. `200000000`) —
that fails business validation permanently and renders the red banner with the reason.

---

## Repository layout

```
apps/
  api/         NestJS HTTP API — validation, idempotency, OpenAPI
  worker/      BullMQ consumer — ordering, retries, crash recovery
  frontend/    Vite + React UI
packages/
  shared/      Types, enums, job contracts, structured logger
  database/    Prisma schema, migrations, client
  queue/       BullMQ producer + per-employee ordering primitives
docs/          decisions.md, database-design.md, api-examples.md, openapi.json
```

## Common commands

```bash
pnpm build                # build every package
pnpm test                 # run all test suites
pnpm db:migrate           # apply migrations
pnpm db:studio            # browse the database
pnpm docs:export          # regenerate docs/openapi.json
```

## Environment

Copy `.env.example` to `.env`. The values that matter most:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `REDIS_URL` | Queue + ordering locks |
| `WORKER_CONCURRENCY` | Parallel jobs across *different* employees (default 10) |
| `SIMULATED_*_FAILURE_RATE` | Tune or disable simulated provider failures |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
