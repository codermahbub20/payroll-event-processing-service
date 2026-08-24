# Database Design

Schema for the Payroll Event Processing Service. Source of truth is
[schema.prisma](../packages/database/prisma/schema.prisma); the generated SQL lives in
[migrations/](../packages/database/prisma/migrations/).

## Why Prisma

Evaluated against TypeORM and Drizzle:

| | Prisma | TypeORM | Drizzle |
|---|---|---|---|
| Migrations | Generated, reviewable SQL checked into git | Generated but frequently needs hand-repair | Generated SQL, good |
| Type safety | Types derived from schema, no drift possible | Decorators can silently diverge from DB | Excellent, schema-as-code |
| `jsonb` / enums | First-class | Workable | First-class |
| Transactions | `$transaction` with isolation levels | Supported | Supported |
| `FOR UPDATE SKIP LOCKED` | **Requires `$queryRaw`** | Supported in query builder | Supported |

**Chose Prisma.** The decisive factors were migration quality and the fact that its
generated types flow straight into `packages/shared` with no chance of the TypeScript
enum drifting from the Postgres enum — which is exactly the failure mode that turns a
status-machine bug into a silent data-corruption bug. TypeORM's migration generator
needs too much manual repair to trust in a payroll system; Drizzle is technically the
closest fit (its raw-SQL ergonomics would win on the queue-claim query) but the
ecosystem is younger, which is a harder sell for financial infrastructure.

The one real cost — Prisma can't express `SELECT ... FOR UPDATE SKIP LOCKED` in the
query builder — is paid in the worker step with a single `$queryRaw` for the claim
query. That is a contained, well-understood exception rather than a pervasive
limitation, and the schema below is designed to support it.

---

## Tables

### `payroll_events`

The core record — one row per submitted payroll change.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | Generated client-side so the API can log an ID before the insert commits |
| `event_type` | `payroll_event_type` | `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE` |
| `employee_id` | `uuid` | No FK — employees live in another service |
| `effective_date` | `date` | Deliberately `date`, not `timestamptz`: "effective Sept 1" is a calendar fact, not an instant, and must not shift under timezone conversion |
| `payload` | `jsonb` | Type-specific fields; shapes are in `packages/shared` |
| `status` | `payroll_event_status` | See state machine below |
| `idempotency_key` | `varchar(255)` UNIQUE | Client-supplied dedup key |
| `version` | `integer` | Optimistic-lock counter |
| `attempt_count` | `integer` | Retry bookkeeping |
| `next_attempt_at` | `timestamptz` | When a `FAILED_TEMPORARY` event becomes eligible again |
| `last_error` | `text` | Denormalized latest error for cheap triage |
| `created_at` / `updated_at` | `timestamptz` | |
| `started_processing_at` / `completed_at` | `timestamptz` | Nullable; yields queue-latency and processing-duration metrics without a join |

**Why an enum instead of a lookup table.** The status set is small, fixed, and
changes only with a code deploy. A Postgres enum makes an invalid status
*unrepresentable* rather than merely unreferenced, and it costs 4 bytes instead of a
join. The tradeoff — adding a value needs a migration — is a feature here: a new
payroll event type should be a reviewed change, not a runtime `INSERT`.

**Why `jsonb` for the payload.** The three event types have disjoint field sets. The
alternatives were a wide sparse table (most columns `NULL`, no meaningful constraints)
or three separate tables (breaking single-queue ordering and forcing a three-way union
on every read). `jsonb` keeps one ordered queue while letting each type carry its own
shape, validated at the API boundary by the DTOs in `packages/shared`. It is `jsonb`
rather than `json` so it can be indexed later if payload queries emerge.

#### Status state machine

```
                  ┌──────────────────────────────┐
                  ▼                              │ (retry, when next_attempt_at is due)
(new) ──▶ PENDING ──▶ PROCESSING ──┬──▶ SUCCEEDED          [terminal]
                                   ├──▶ FAILED_TEMPORARY ──┘
                                   └──▶ FAILED_PERMANENT   [terminal]
```

The temporary/permanent split is the important distinction: a downstream 503 or
timeout is retryable, whereas a validation failure or a 4xx never will be. Collapsing
them into one `FAILED` status means either retrying things that can never succeed
(burning the queue) or dropping things that would have succeeded on a second attempt.

---

### `payroll_event_history`

Append-only audit log — one row per status transition. Never updated, never deleted.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `event_id` | `uuid` FK → `payroll_events` | `ON DELETE CASCADE` |
| `previous_status` | `payroll_event_status` NULL | `NULL` on the creation row (`null → PENDING`) |
| `new_status` | `payroll_event_status` | |
| `details` | `jsonb` NULL | Error + stack on failure, downstream response on success |
| `actor` | `varchar(255)` NULL | `api`, `worker:<id>`, `admin:<user>` |
| `created_at` | `timestamptz` | |

**Why a separate table rather than status columns on the event.** `payroll_events.status`
holds only the *current* state; it cannot answer "how many times did this fail, and
with what error each time?" For payroll — where a mis-applied bank-account change is a
real-money incident — reconstructing the full timeline is a compliance requirement, not
a debugging nicety.

**Why append-only.** An audit log that can be updated is not an audit log. Keeping it
insert-only means the trail cannot be quietly rewritten, and it sidesteps write
contention entirely: inserts never block each other, whereas repeatedly updating one
mutable audit row would serialize every worker on the same page.

**Why `details` is `jsonb`.** Failure context differs per event type and per downstream
system. A fixed `error_message` column would either lose structure (HTTP status,
retry-after, provider error code) or need a migration each time a new field mattered.

---

### `applied_operations` — the at-most-once ledger

This is the table that makes **at-least-once delivery** safe to combine with
**at-most-once business effect**.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `event_id` | `uuid` FK → `payroll_events` | `ON DELETE CASCADE` |
| `operation_key` | `varchar(255)` | Which effect this row covers |
| `result` | `jsonb` NULL | Stored outcome, replayed on duplicate delivery |
| `applied_at` | `timestamptz` | |
| | **UNIQUE `(event_id, operation_key)`** | The actual guarantee |

#### The problem it solves

Any reliable queue redelivers. A worker can apply a payroll change, then crash before
marking the event `SUCCEEDED` — so the event is redelivered and the change is applied
twice. For a bank-account change that is a duplicate write; for a salary change it can
be a duplicated payment. Marking the event complete *before* doing the work just trades
double-application for silent data loss.

#### How it works

The side effect and its ledger row are written in **one transaction**:

```ts
await prisma.$transaction(async (tx) => {
  await tx.appliedOperation.create({
    data: { eventId, operationKey: "push-to-payroll-provider", result },
  });                                    // ← throws P2002 if already applied
  await applyBusinessEffect(tx, event);  // ← the actual change
});
```

Either both commit or neither does. On redelivery the insert violates the unique
constraint, the transaction aborts, and the worker treats `P2002` as "already done" —
reading back the stored `result` so the retry is observably identical to the original.
Correctness rests on a database constraint, not on application logic remembering to
check first, so it holds even if two workers race on the same event simultaneously.

#### Why `operation_key` rather than one row per event

A single event may drive several distinct effects (push to the payroll provider, notify
the employee, write to the ledger). Keying only on `event_id` means a crash between
effect #2 and #3 forces a choice between redoing #1–#2 or skipping #3. One row per
effect makes each independently idempotent, so a retry resumes at the first unapplied
operation.

#### Why not the alternatives

- **A `processed` boolean on `payroll_events`.** The flag and the effect commit
  separately, which is precisely the crash window described above.
- **Relying on `idempotency_key`.** Different layer: it dedups *inbound HTTP requests*
  (client retries a `POST`), whereas `applied_operations` dedups *outbound side effects*
  (queue redelivers a message). Both are needed — they guard opposite ends of the pipeline.

---

## Indexes

| Index | Table | Purpose |
|---|---|---|
| `uq_payroll_events_idempotency_key` | `payroll_events` | **Unique.** Dedups retried HTTP submissions. Enforced by the DB so two concurrent retries cannot both insert. |
| `ix_payroll_events_employee_created` | `payroll_events` | `(employee_id, created_at)` — backs per-employee FIFO ordering. Column order matters: equality on `employee_id` first, then `created_at` for an index-ordered scan with no sort step. |
| `ix_payroll_events_status` | `payroll_events` | Operational queries — stuck `PROCESSING`, accumulating `FAILED_*`. |
| `ix_payroll_events_status_next_attempt` | `payroll_events` | `(status, next_attempt_at)` — retry sweeps find due events without scanning every failed row. |
| `ix_payroll_event_history_event_created` | `payroll_event_history` | `(event_id, created_at)` — returns one event's timeline in order. |
| `uq_applied_operations_event_operation` | `applied_operations` | **Unique.** The at-most-once guarantee itself. |
| `ix_applied_operations_event` | `applied_operations` | Fetching all operations applied for an event. |

### Ordering guarantee

Events for a given employee must be processed in submission order — an address change
followed by a correction must not land reversed. `(employee_id, created_at)` supports
claiming the oldest unprocessed event per employee. Ordering is *per employee*, not
global, so different employees still process in parallel.

Two mechanisms keep concurrent workers from breaking this:

1. **`version` (optimistic locking).** Claiming is
   `UPDATE ... WHERE id = ? AND status = 'PENDING' AND version = ?`. Exactly one of two
   racing workers gets `rowCount = 1`; the loser re-polls. *(Verified against a live
   Postgres: two concurrent claims → one winner.)*
2. **`FOR UPDATE SKIP LOCKED`** in the worker's claim query, so workers pull disjoint
   events instead of contending on the same row.

`started_processing_at` additionally makes stuck events recoverable: a sweep can find
rows that have been `PROCESSING` for longer than the visibility timeout and reset them —
safely, because `applied_operations` guarantees replay won't duplicate the effect.

---

## Migrations & scripts

```bash
pnpm db:migrate            # prisma migrate deploy   — apply pending (production)
pnpm db:migrate:dev        # prisma migrate dev      — create + apply (development)
pnpm db:migrate:generate   # prisma migrate dev --create-only — SQL without applying
pnpm db:seed               # empty for now
pnpm db:generate           # regenerate the Prisma client
pnpm db:studio             # browse data
```

Under `docker compose up`, a one-shot `migrate` service runs `prisma migrate deploy`
before `api` and `worker` start (`depends_on: service_completed_successfully`), so
neither ever serves traffic against an outdated schema.

## Verification status

The initial migration was applied to a real PostgreSQL 18 instance and
`prisma migrate diff --from-migrations --to-schema-datamodel` reported
**"No difference detected"** — the checked-in SQL provably reproduces the schema.
All seven index/constraint definitions, both enums, and the behavioral guarantees
(idempotency-key dedup, at-most-once ledger, transactional rollback, single-writer
claim, per-employee ordering, audit trail, FK cascade) were verified against live
Postgres. `docker compose up` itself has not been run — Docker was unavailable in the
development environment.
