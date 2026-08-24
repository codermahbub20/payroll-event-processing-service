# Testing Strategy

## The shape of the pyramid

```
                    ┌─────────────┐
                    │  e2e  (6)   │   HTTP → queue → worker → DB
                    ├─────────────┤
                  ┌─┤ integration │   one service, real Postgres + Redis
                  │ │    (134)    │
                  │ ├─────────────┤
                ┌─┴─┤    unit     │   pure functions, no I/O
                │   │    (112)    │
                └───┴─────────────┘
```

**252 tests total** — 112 unit, 134 integration, 6 e2e.

That is deliberately *not* the classic wide-base pyramid. The reason is that almost
every interesting property of this system is a property of the *boundaries*, not of the
functions:

- ordering lives in Redis Lua scripts;
- idempotency lives in a Postgres unique constraint;
- retry and stall behaviour live in BullMQ's own state machine;
- crash consistency lives in transaction boundaries.

None of those can be tested with a mock. A test that stubs Redis and asserts "we called
`acquire`" proves only that the code calls the function it calls — it would pass just as
happily if the Lua script were wrong. So the middle tier is deliberately heavy.

## Naming

Every suite is labelled in both the filename and the top-level `describe`:

| Tier | File suffix | `describe` prefix | Command |
|---|---|---|---|
| Unit | `*.spec.ts` (under `src/`) | `[unit]` | `pnpm test:unit` |
| Integration | `*.integration-spec.ts` | `[integration]` | `pnpm test:integration` |
| End-to-end | `*.e2e-spec.ts` | `[e2e]` | `pnpm test:e2e` |

Unit tests sit next to the code in `src/**/__tests__/`; integration and e2e live in
`test/`. The suffix drives the tier filter, so `pnpm test:unit` runs in ~2s with no
services running — fast enough for a watch loop.

## What goes where, and why

### Unit — pure logic, no I/O

Used only where a function has real decision-making and no dependencies worth wiring up:

- **DTO validation** (`create-event.dto.spec.ts`) — the polymorphic
  `eventType → payload` dispatch. 20 cases across the three event types plus the
  envelope. This is the required *"invalid events are rejected per event type"* scenario.
- **Business validation** (`validation.spec.ts`) — IBAN MOD-97 checksum against real
  IBANs from six countries, salary integer/ceiling rules, country and currency codes.
- **Idempotency key derivation** (`idempotency.spec.ts`) — determinism, canonical key
  ordering, prefix, column-length fit.
- **Error taxonomy and the simulated gateway** (`gateway-and-errors.spec.ts`) — with an
  injected RNG and clock, so failure-rate behaviour is deterministic.
- **Enum parity** (`enum-parity.spec.ts`) — asserts the Prisma and shared enums hold
  identical values, because `EventsService` casts between them and TypeScript cannot
  check that cast.

### Integration — one service against real infrastructure

Real Postgres (embedded) and real Redis (`redis-memory-server`) — **never mocks**. If
the thing under test is a database constraint or a Lua script, a fake proves nothing.

| Suite | Covers |
|---|---|
| `events.integration-spec.ts` | Valid submission returns 202 + persists PENDING; duplicate idempotency key returns the same event with 200 and enqueues nothing; concurrent identical submissions collapse to one row |
| `events-read.integration-spec.ts` | Detail and list shapes, filters, pagination, 404 |
| `retry-behaviour.integration-spec.ts` | Temporary failures retried to exhaustion → `FAILED_TEMPORARY`; permanent failure → `FAILED_PERMANENT` with **one** provider call |
| `result-persistence.integration-spec.ts` | The provider result lands verbatim in the ledger, is mirrored into history, and every event column is set correctly |
| `ordering.integration-spec.ts` | Same-employee events strictly serialised; different employees genuinely overlap in time |
| `crash-recovery.integration-spec.ts` | Redelivery after a crash does not re-apply the effect; stalled-job recovery; the recovery sweep |
| `health.integration-spec.ts` | Per-dependency probes, 503 when any is down, probe timeout |
| `exception-filter.integration-spec.ts` | Uniform error shape; stack traces logged but never returned |
| `health-server.integration-spec.ts` | Worker health endpoint against a genuinely unreachable database |
| `openapi-export.integration-spec.ts` | The committed `docs/openapi.json` matches what the server generates |

### End-to-end — the whole chain, nothing stubbed

Exactly one suite: [`submit-to-succeeded.e2e-spec.ts`](../apps/worker/test/submit-to-succeeded.e2e-spec.ts).

```
HTTP POST /events
  → API validates, persists, enqueues via the REAL BullEventQueue
  → real BullMQ over real Redis
  → real worker consumes, calls the provider
  → status becomes SUCCEEDED in real Postgres
  → HTTP GET /events/:id observes it
```

This exists because every other suite stubs one side of the API↔worker boundary: the API
tests inject a recording queue, and the worker tests call the producer directly. Neither
can catch a mismatch in queue name, job payload shape, or enum values. This suite is the
only place where a contract drift between the two services fails a test.

It is kept deliberately small — 6 cases covering the happy path per event type, the
duplicate-submission path, list visibility, and per-employee ordering observed
end-to-end. e2e tests are the slowest and the most prone to flaking, so they cover
*wiring*, while behaviour is pinned one tier down.

## Required-scenario coverage

| Scenario | Tier | Where |
|---|---|---|
| Valid event submitted | integration | `events.integration-spec.ts` |
| Invalid events rejected per type | unit | `create-event.dto.spec.ts` |
| Accepted event processed end to end | **e2e** | `submit-to-succeeded.e2e-spec.ts` |
| Processing results persisted | integration | `result-persistence.integration-spec.ts` |
| Temporary failures retried, then handled | integration | `retry-behaviour.integration-spec.ts` |
| Permanent failure immediate and clear | integration | `retry-behaviour.integration-spec.ts` |
| Duplicates create no duplicate operation | integration + e2e | `events.integration-spec.ts`, `submit-to-succeeded.e2e-spec.ts` |
| Ordering per employee / concurrency across | integration | `ordering.integration-spec.ts` |
| Crash redelivery does not duplicate effect | integration | `crash-recovery.integration-spec.ts` |

## Coverage thresholds

`pnpm test:coverage` (or per package). Current state:

| | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| **api** | 99.2% | 87.6% | 98.0% | 99.6% |
| **worker** | 95.5% | 82.2% | 89.2% | 96.9% |

Thresholds are set **per file on the modules that make decisions**, not as a package
average. An average lets a handful of thin, fully-covered files mask a gap in the code
that actually decides whether money moves:

| Module | Statements floor |
|---|---|
| `worker/processing/validation.ts` | 95% |
| `worker/processor/event-processor.ts` | 85% |
| `worker/processor/recovery-sweep.ts` | 80% |
| `api/events/events.service.ts` | 85% |
| `api/events/dto/create-event.dto.ts` | 90% |
| `api/common/all-exceptions.filter.ts` | 85% |
| everything else (global floor) | 75% |

### What is excluded, and why

Per the brief — no chasing 100% on boilerplate:

- **`main.ts`, `*.module.ts`** — composition roots. Running them proves Nest works.
- **`event-response.dto.ts`** — declarations with `@ApiProperty` and no behaviour. Their
  correctness is asserted against the generated OpenAPI document instead, which is the
  artefact that can actually be wrong.
- **`nest-json-logger.ts`** — a thin adapter onto Nest's `LoggerService` interface.
- **`bull-event-queue.ts`** — the real BullMQ producer. API tests inject a fake by design
  (they must not require a broker), so its genuine behaviour is proven by the e2e suite
  driving it against real Redis. Counting it against the API's coverage would push
  toward a bad test — one that mocks ioredis and asserts nothing real.

One threshold is set *below* the default deliberately: `errors.ts` branches sit at 70%
because the remainder are constructor default parameters (`context = {}`) that every
real call site supplies explicitly. Covering them would mean asserting that a default is
a default.

## Test infrastructure

**Postgres**: an embedded instance on port 55432 (`embedded-postgres`), started once for
the run. **Redis**: `redis-memory-server`, which downloads a real Redis-compatible
binary — not an in-memory JS fake, because BullMQ depends on Lua scripting, blocking
commands and atomic transactions that a fake does not implement.

Docker was unavailable in the development environment, so testcontainers was not an
option; the embedded servers give the same guarantee (real engines, real semantics) with
no daemon.

Integration and e2e suites run with `--runInBand`: they share one database, and parallel
workers would interleave writes and make ordering assertions meaningless. Each suite
scopes its data to freshly generated `employeeId`s and deletes them in `afterAll`, so
suites do not observe each other's rows.

`--forceExit` is used on the worker's integration/e2e scripts only. The crash-recovery
suite deliberately abandons Redis connections — that *is* the crash being simulated — so
BullMQ's stalled-check timers can outlive the run by about a second.
`--detectOpenHandles` confirmed there is no genuine leak.

## Running

```bash
pnpm test              # everything
pnpm test:unit         # fast, no services needed
pnpm test:integration  # needs Postgres; Redis is started per suite
pnpm test:e2e          # the full chain
pnpm test:coverage     # with thresholds enforced
```
