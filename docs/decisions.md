# Design Decisions

Running log of non-obvious choices and the reasoning behind them.
Database schema rationale lives in [database-design.md](./database-design.md).

---

## 1. Idempotency key: client header, falling back to a content hash

`POST /events` accepts an optional `Idempotency-Key` header. When absent, the key is
derived as:

```
derived:sha256(canonical_json({ employeeId, eventType, effectiveDate, payload }))
```

### Why content-hashing rather than a random server-side key

The whole point of the key is to survive a *retry*. A random key generated per request
is different on every attempt, so a client that times out and retries would create a
second event — the exact duplicate the mechanism exists to prevent. Only a value derived
from stable request content is identical across retries of the same logical submission.

### Why these four fields

They are the complete business identity of the change: *who* (`employeeId`), *what kind*
(`eventType`), *when it applies* (`effectiveDate`), and *the actual values* (`payload`).
Two requests agreeing on all four are the same instruction; any difference is a genuinely
different one.

Deliberately excluded: timestamps, request IDs, auth headers, and anything else that
varies between attempts at the same submission.

### Why the JSON is canonicalized

`JSON.stringify` preserves insertion order, so `{newSalary, currency}` and
`{currency, newSalary}` would hash differently despite being the same instruction. Keys
are sorted recursively before hashing, so serialization order cannot cause a spurious
duplicate. *(Covered by tests in both the unit and integration suites.)*

### Why the `derived:` prefix

It keeps server-derived keys distinguishable from client-supplied ones in the database.
When investigating a duplicate-submission incident, "did the client send a key or did we
compute one?" is the first question, and the prefix answers it without a join or a guess.

### The tradeoff being accepted

Content-hashing makes **identical resubmission** un-representable. A client that
deliberately wants to submit the same salary change twice (same employee, same date,
same amount) cannot do so without supplying its own distinct `Idempotency-Key`.

This is the correct default for payroll: an accidental double-submission is a
real-money incident, whereas a genuine duplicate is rare and has an explicit escape
hatch. Note the fallback only applies when the client sends **no** header — clients that
manage their own keys are unaffected.

### Why the key is a header, not a body field

It is transport-level retry metadata, not part of the payroll instruction. Keeping it in
the header means a retrying client reuses the value verbatim without reserializing the
body — and the body stays exactly what gets hashed.

---

## 2. Enqueue strictly after the transaction commits

`EventsService.submit` persists the event and its opening audit row in one transaction,
then enqueues the BullMQ job **after** that transaction commits.

### Why not enqueue inside the transaction

The worker is a separate process and frequently faster than the commit. Enqueueing
before commit creates two failure modes:

1. The worker picks up the job and queries for an event id **not yet visible** to its
   session — the row exists only inside our uncommitted transaction. It sees "not
   found" and fails a perfectly valid event.
2. The transaction **rolls back**. The job now points at a row that will never exist —
   a poison message referencing a phantom event.

### Why after-commit is the safe ordering

It inverts the failure mode into a recoverable one. If the enqueue fails, the event is
already durably `PENDING` in Postgres, and the worker's sweep for stale `PENDING` rows
picks it up. At-least-once delivery is recoverable; a job pointing at a non-existent row
is not.

This is the standard reliability tradeoff: prefer *duplicate work* (which
`applied_operations` already makes safe — see
[database-design.md](./database-design.md)) over *lost work*.

### Why a failed enqueue still returns 202

The event is committed, so the client's submission genuinely was accepted. Returning 500
would invite a retry that the idempotency key would collapse anyway, while falsely
telling the client their change was lost. The failure is logged at `error` level and the
row remains `PENDING` for the sweep. *(Covered by an integration test.)*

### Why the job carries only `{ eventId, employeeId }`

The worker re-reads the authoritative row from Postgres. Embedding a payload snapshot in
the job risks acting on stale data if the event changed after enqueue, and duplicates
the source of truth.

`employeeId` is the one exception: it is the partition key for per-employee ordering
(§8), and the ordering lock must be acquired *before* any database read — so it has to
travel on the job itself.

### Why `jobId = eventId`

Makes the enqueue itself idempotent. If the API crashes between commit and the queue
ack, a re-enqueue is collapsed by BullMQ rather than producing a second job.

---

## 3. Polymorphic validation without `@Type({ discriminator })`

Payload validation dispatches on `eventType` via a custom `ValidateBy` validator
(`IsValidPayloadForEventType`) rather than class-transformer's built-in discriminator.

### Why the built-in mechanism was rejected

It reads the discriminator from a property **inside** the nested object, whereas ours
lives on the parent envelope. Probed directly before committing to the design:

| Case | Result |
|---|---|
| Discriminator on parent only (our shape) | payload stays a plain `Object` — **all nested rules silently skipped** |
| Discriminator inside the payload | correctly instantiated |
| Unknown discriminator value | plain `Object` — **silently unvalidated** |

Both failing cases **fail open**: an invalid or unknown-typed payload passes validation
and reaches the service layer unchecked. On a payroll write path that is not an
acceptable default. The alternative — requiring clients to duplicate `eventType` inside
the payload — pushes an implementation detail into the public API.

The explicit validator dispatches from a single `PAYLOAD_DTO_BY_EVENT_TYPE` map, which
is also what the service uses, so the two cannot disagree.

### Why unknown fields are rejected rather than stripped

Both the global pipe (`forbidNonWhitelisted`) and the nested payload validation reject
unrecognised properties. A silently dropped field on a payroll change is worse than a
rejected request: the client believes a value was recorded when it was not. This also
means a payload carrying another event type's fields (e.g. `SALARY_CHANGE` with an
`iban`) is a 400 rather than a partially-applied change.

---

## 4. Status codes: 202 for new, 200 for duplicate

- **202 Accepted** — event persisted and queued; processing has not happened yet.
  `202` (not `201`) because the resource is not yet in its final state.
- **200 OK** — the idempotency key was already known. The existing event is returned and
  **no new job is enqueued**.
- **400 Bad Request** — validation failure, including unknown `eventType`.

### Why 400 rather than 422 for unknown `eventType`

The requirement allowed either. `400` is used consistently for *all* request-shape
problems, with the specific field failure in `details`:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "details": ["eventType: eventType must be one of: BANK_ACCOUNT_CHANGE, ADDRESS_CHANGE, SALARY_CHANGE"]
}
```

An unknown `eventType` is not semantically different from any other invalid enum value,
so splitting it into a separate status would force clients to handle two codes for one
class of error. The `details` array is what a client actually needs to fix the request.

### Why the duplicate flag is in the body

Clients that care can distinguish `200` from `202` by status code, but `duplicate: true`
makes the outcome explicit in logs and test assertions without inspecting the status.

---

## 5. Monetary amounts as integer minor units

`SALARY_CHANGE.newSalary` is validated as a positive **integer in minor units** (cents),
not a float.

Binary floating point cannot represent most decimal amounts exactly (`0.1 + 0.2 !==
0.3`), and silent rounding in a payroll system is a real-money defect. Integer minor
units sidestep the problem entirely and match how payment providers model amounts.

Similarly, `iban` is validated with a real IBAN checksum rather than a loose string: a
malformed account number reaching the payroll provider is a failed or — worse —
misdirected payment, and the check is cheap at the API boundary.

---

## 6. Read endpoints: derived `failure` / `result` fields

`GET /events/:id` returns the full `history` timeline **and** two derived fields,
`failure` and `result`, holding the most recent failing and succeeding transitions.

The timeline alone would be sufficient — but every consumer (the frontend list, an
on-call engineer, a support tool) wants the same thing first: *what went wrong, most
recently*. Making each caller re-implement "reverse the array, find the first
`FAILED_*`" invites subtly different answers, and the obvious naive version — taking the
**first** failure — is wrong for an event that failed, retried, and failed again with a
different error.

Both fields are derived from the **latest** matching transition, and there is a test
seeding two distinct failures specifically to pin that ordering.

`lastError` on the event row is kept as well: it is the denormalised message for cheap
triage without joining history, whereas `failure.details` carries the full structured
context.

### List rows omit `payload`

`GET /events` returns `EventSummaryDto` without the payload; only the detail endpoint
includes it. Payloads are unbounded `jsonb`, and a 100-row page carrying full bank/address
details would be both slow and a needless exposure of PII in a view that only renders
status and dates.

### Pagination ordering

Rows are ordered `createdAt DESC, id DESC`. The `id` tiebreak matters: without it, two
events sharing a `created_at` have no deterministic order between queries, so the same
row can appear on two consecutive pages while another is skipped entirely.

---

## 7. OpenAPI: `@ApiResponse` over `@ApiCreatedResponse` for 202

`POST /events` returns **202** (new) or **200** (duplicate) and never 201.

`@ApiCreatedResponse({ status: 202 })` does **not** work — the decorator hardcodes 201
and ignores the override. This was caught by inspecting the generated document, which
showed `200, 201, 400` while the endpoint actually returns `200, 202, 400`. The fix is
the generic `@ApiResponse({ status: HttpStatus.ACCEPTED })`.

This is the failure mode that makes documentation-by-decorator risky: the wrong decorator
compiles cleanly, passes every endpoint test, and only manifests as documentation that
lies about the API. `test/swagger.e2e-spec.ts` therefore asserts the generated document
directly — that the documented status codes match reality, that no `$ref` is dangling,
and that the polymorphic `payload` renders as a `oneOf` over all three payload schemas.

The payload union needs `@ApiExtraModels` on the controller: those DTOs are reachable
only through the runtime discriminator, never as a directly-typed parameter, so Swagger's
type scanning cannot find them and their `$ref`s would otherwise dangle.

### Uniform error bodies

`ParseUUIDPipe` has its own error shape (`{message, error, statusCode}`, no `details`),
which differs from the global validation pipe's. It is given an `exceptionFactory` that
matches, so every 400 this API emits has one parseable shape.

---

## 8. Per-employee ordering: Redis sequence lock, not BullMQ Flows

**Requirement:** events for the same `employeeId` must process in acceptance order;
events for different employees must run concurrently.

**Chosen: strategy (a)** — one `payroll-events` queue, plus a per-employee FIFO list and
lock in Redis.

### Why not Flows (strategy b)

Flows are the wrong shape for this problem, in three compounding ways:

1. **The dependency direction is inverted.** BullMQ processes children *before* parents.
   Chaining B as a dependent of A therefore runs **B first** — the opposite of what is
   wanted. Getting A→B ordering requires making A the child of B, i.e. building the tree
   backwards from the newest event.

2. **A flow tree must be constructed knowing all its children.** Our events arrive one at
   a time over HTTP, with no way to know whether another event for that employee is
   seconds away. Appending to an existing tree means tearing it down and rebuilding it
   on every submission — not atomic against a worker already consuming it.

3. **Unbounded chain growth.** An employee submitting events all day accumulates an
   ever-deeper tree that is never fully retired, because the root cannot complete until
   every descendant has.

Flows are designed for fan-in/fan-out with a *known* child set (map-reduce, batch
completion). They are not a substitute for an open-ended, append-only ordered stream.

### How the sequence lock works

Two Redis structures per employee, both manipulated by Lua scripts so each
check-then-act is atomic:

| Key | Type | Purpose |
|---|---|---|
| `payroll:employee:<id>:queue` | list | FIFO of accepted event ids |
| `payroll:employee:<id>:lock` | string (TTL) | id of the event currently being processed |

- **Producer** appends the event id to the FIFO *before* adding the BullMQ job, so
  accepted order is durable even if the enqueue then fails.
- **Consumer** may only process an event when it is at the **head** of the FIFO and the
  lock is free. Otherwise the job is deferred.
- **On completion** (success *or* failure) the lock is released and the head popped in
  one atomic step, advancing the employee.

Atomicity is the whole point: two workers evaluating "is the lock free?" as separate
round trips would both see *yes* and both proceed. Every check-then-act therefore lives
inside a Lua script.

### Concurrency and ordering are decoupled

The worker runs `concurrency: 10`. Ordering does **not** come from limiting concurrency —
that would serialise *all* employees and destroy throughput. It comes from the lock,
which is scoped per employee. Ten different employees can be in flight simultaneously
while each one's events are strictly serialised.

### Deferral uses `moveToDelayed`, not re-`add`

A job whose turn has not come is deferred with `job.moveToDelayed()` followed by
throwing `DelayedError`.

The obvious alternative — re-`add`ing the job with the same `jobId` — is **silently
broken**. BullMQ refuses to re-add a `jobId` that is currently active or completed, and
it does so without error: `add()` returns a plausible-looking `Job` object while nothing
is actually queued, so the event vanishes. This was found by probing BullMQ directly
against a real Redis: the first event of each employee processed and everything after it
disappeared.

`moveToDelayed` is the right primitive because it:
- keeps the **same** job, so `jobId === eventId` still dedups redeliveries;
- does **not** consume a retry attempt (`DelayedError` signals a deliberate reschedule,
  not a failure), so waiting one's turn can never exhaust retries and land a valid event
  in the DLQ.

### Failure handling

The lock is released in a `finally`. Without that, one failing event would block every
later event for that employee until the TTL expired. There is a test asserting a failed
event does not wedge its employee's queue.

### Trade-offs accepted

- **Polling cost.** A waiting job re-checks every ~50 ms rather than being woken. This
  burns some Redis round trips under a deep per-employee backlog. Acceptable because the
  expected depth per employee is very small (an employee rarely has more than one or two
  in-flight payroll changes); a notification-driven wake-up is the optimisation if that
  ever stops being true.
- **Lock TTL vs. long jobs.** The lock has a 30 s TTL so a dead worker cannot block an
  employee forever. A legitimately long job would lose it, so the TTL is refreshed on an
  interval for the duration of the work.
- **A second source of truth.** Ordering state lives in Redis while events live in
  Postgres. If Redis is lost, ordering state is lost — surviving events are still
  `PENDING` in Postgres and recoverable, but their relative order within an employee
  would be rebuilt from `created_at` rather than the FIFO. That is the accepted cost of
  not putting a lock table in the hot path of every job.

---

## 9. Failure classification: `UnrecoverableError`, not `job.discard()`

Permanent failures stop retrying by throwing BullMQ's `UnrecoverableError`.

Both mechanisms work — verified against a real Redis that `UnrecoverableError` produces
exactly **1** attempt where a plain `Error` produces the full **3**. `UnrecoverableError`
is preferred because:

- **It propagates.** Business validation fails several frames deep inside
  `applyBusinessEffect`. An exception unwinds naturally; `discard()` would require
  threading the `job` object down to every site that might decide "permanent".
- **It keeps the decision in one place.** `discard()` *marks* the job then still needs a
  throw to end the attempt, so the intent lives in two statements that can drift apart.
  One throw carries both the outcome and the reason.
- **It reads correctly in the queue.** The job lands in `failed` with the real error
  message, which is what an operator inspecting the DLQ needs.

### The three-way outcome

| Situation | Event status | Retries |
|---|---|---|
| Business validation failed | `FAILED_PERMANENT` | none — `UnrecoverableError` |
| Provider returned a non-retryable error | `FAILED_PERMANENT` | none — `UnrecoverableError` |
| Retryable error, budget remains | stays `PROCESSING` | BullMQ retries with backoff |
| Retryable error, budget spent | `FAILED_TEMPORARY` | stopped, but re-triggerable |

**Why the row stays `PROCESSING` between retries.** Flapping it to `FAILED_TEMPORARY`
and back on every attempt would make the audit trail unreadable and break any "how many
events are currently failing?" dashboard — the count would spike and settle on every
transient blip. The attempt genuinely *is* still in flight. Each attempt still writes a
history row (with `willRetry: true`), so nothing is lost from the audit trail.

**Why `FAILED_TEMPORARY` is distinct from `FAILED_PERMANENT`.** It means "we gave up for
now", not "this can never work". It stays eligible for a manual re-trigger or a
scheduled sweep, which is why `completedAt` is deliberately left null for it and stamped
for `FAILED_PERMANENT`.

### Unknown errors are treated as retryable

An unrecognised exception is more likely transient infrastructure than permanently bad
data. The retry budget bounds the cost of guessing wrong; failing permanently on an
unknown error would silently discard recoverable payroll changes.

### Validation runs again in the worker

The API already validated the payload at submission, and the worker validates again
before the provider call. This is not redundant:

- events can sit queued for a long time, and the rules that matter are those in force
  when the change is *applied*;
- rows can be written by paths that never touch the DTO layer (backfills, migrations,
  manual repair);
- these are *business* rules (IBAN checksums, salary ceilings) rather than request-shape
  rules, and belong beside the code that acts on them.

The IBAN check is the real ISO 7064 MOD-97-10 algorithm, not a regex — verified against
valid IBANs from six countries (including 15-character Norwegian and alphanumeric
French/UK forms) and confirmed to reject single-digit corruptions that a shape check
would wave through. Salary carries a sanity ceiling because a value above it is far more
likely a unit error (major units sent as minor) than a real raise, and that mistake is
expensive to unwind.

### `attemptsMade` is 0-based during execution

Verified directly: a 3-attempt job observes `attemptsMade` as `0, 1, 2`. Logs and the
"is this the last attempt?" check therefore use `attemptsMade + 1`. An easy off-by-one
that would either mis-report attempt numbers or give up one retry early.

### Structured logs

Every lifecycle transition emits one JSON line carrying `eventId`, `employeeId`,
`eventType`, `attempt`, `maxAttempts`, and — on failures — `errorCode` and `willRetry`:

```json
{"timestamp":"...","level":"warn","event":"processing_failed_temporary",
 "eventId":"...","employeeId":"...","eventType":"SALARY_CHANGE",
 "attempt":2,"maxAttempts":3,"errorCode":"DOWNSTREAM_UNAVAILABLE","willRetry":true}
```

Written straight to stdout rather than through Nest's `Logger`, whose formatter would
wrap the JSON in ANSI colour codes and a prefix — making it unparseable by a log
aggregator.

---

## 10. Enum parity between Prisma and the shared package

Prisma generates its enums as string-literal unions; `@payroll/shared` exports real
TypeScript enums. The values are identical but the types are not mutually assignable, so
`EventsService` converts at the persistence boundary and the Prisma types stay out of
the public API.

Because that conversion is a cast, TypeScript cannot verify it. `enum-parity.spec.ts`
asserts both enums hold exactly the same values, so adding a value to `schema.prisma`
without mirroring it in `packages/shared` fails a test rather than surfacing as a runtime
bug on the write path.
