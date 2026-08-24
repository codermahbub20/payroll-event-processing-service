# API Examples

Copy-pasteable `curl` commands for every endpoint.

Interactive docs: **http://localhost:3000/api/docs**
Raw spec: [`openapi.json`](./openapi.json) (regenerate with `pnpm docs:export`)

```bash
# Used throughout. Override if the API runs elsewhere.
BASE_URL=http://localhost:3000
EMPLOYEE_ID=3f6d0a2c-9c3a-4a1e-9f4a-2b8d6c1e5a70
```

---

## Health

### `GET /health`

Returns **200** when Postgres, Redis and BullMQ are all reachable, **503** when any
is down. The body is the same shape either way, so the breakdown is available
whichever code you get.

```bash
curl -i "$BASE_URL/health"
```

<details>
<summary>200 — all dependencies up</summary>

```json
{
  "status": "ok",
  "timestamp": "2026-08-24T10:15:00.000Z",
  "uptimeSeconds": 3600,
  "checks": {
    "postgres": { "status": "up", "latencyMs": 3 },
    "redis": { "status": "up", "latencyMs": 1 },
    "queue": {
      "status": "up",
      "latencyMs": 1,
      "details": { "counts": { "waiting": 0, "active": 2, "completed": 148, "failed": 1 } }
    }
  }
}
```
</details>

<details>
<summary>503 — Redis down</summary>

```json
{
  "status": "degraded",
  "timestamp": "2026-08-24T10:15:00.000Z",
  "uptimeSeconds": 3600,
  "checks": {
    "postgres": { "status": "up", "latencyMs": 3 },
    "redis": { "status": "down", "latencyMs": 2, "error": "connect ECONNREFUSED 127.0.0.1:6379" },
    "queue": { "status": "down", "latencyMs": 2, "error": "connect ECONNREFUSED 127.0.0.1:6379" }
  }
}
```
</details>

Scripted check (exit code reflects health):

```bash
curl -fsS -o /dev/null "$BASE_URL/health" && echo healthy || echo unhealthy
```

---

## Submit events

### `POST /events` — BANK_ACCOUNT_CHANGE

The IBAN is validated with a real ISO 7064 MOD-97 checksum, not a regex.

```bash
curl -i -X POST "$BASE_URL/events" \
  -H 'Content-Type: application/json' \
  -d '{
    "eventType": "BANK_ACCOUNT_CHANGE",
    "employeeId": "'"$EMPLOYEE_ID"'",
    "effectiveDate": "2026-09-01",
    "payload": { "iban": "DE89370400440532013000" }
  }'
```

```
HTTP/1.1 202 Accepted
{"id":"9c3a4a1e-2b8d-4c1e-9f4a-3f6d0a2c5a70","status":"PENDING","duplicate":false}
```

### `POST /events` — ADDRESS_CHANGE

`country` must be an ISO 3166-1 alpha-2 code.

```bash
curl -i -X POST "$BASE_URL/events" \
  -H 'Content-Type: application/json' \
  -d '{
    "eventType": "ADDRESS_CHANGE",
    "employeeId": "'"$EMPLOYEE_ID"'",
    "effectiveDate": "2026-09-01",
    "payload": {
      "street": "Hauptstrasse 1",
      "city": "Berlin",
      "postalCode": "10115",
      "country": "DE"
    }
  }'
```

### `POST /events` — SALARY_CHANGE

> **`newSalary` is in integer MINOR units (cents).** 75,000.00 EUR is `7500000`.
> Floats are rejected: binary floating point cannot represent most decimal
> amounts exactly, and silent rounding on payroll is a real-money defect.

```bash
curl -i -X POST "$BASE_URL/events" \
  -H 'Content-Type: application/json' \
  -d '{
    "eventType": "SALARY_CHANGE",
    "employeeId": "'"$EMPLOYEE_ID"'",
    "effectiveDate": "2026-10-01",
    "payload": { "newSalary": 7500000, "currency": "EUR" }
  }'
```

---

## Idempotency

### Duplicate submission with an explicit key

The first request creates the event (**202**). The second, with the same
`Idempotency-Key`, returns the **same event id** with **200** and enqueues no new
work.

```bash
KEY="demo-$(date +%s)"
BODY='{
  "eventType": "SALARY_CHANGE",
  "employeeId": "'"$EMPLOYEE_ID"'",
  "effectiveDate": "2026-10-01",
  "payload": { "newSalary": 8000000, "currency": "EUR" }
}'

echo "--- first submission ---"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE_URL/events" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d "$BODY"

echo "--- retry with the same key ---"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE_URL/events" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d "$BODY"
```

```
--- first submission ---
{"id":"9c3a4a1e-2b8d-4c1e-9f4a-3f6d0a2c5a70","status":"PENDING","duplicate":false}
HTTP 202
--- retry with the same key ---
{"id":"9c3a4a1e-2b8d-4c1e-9f4a-3f6d0a2c5a70","status":"PENDING","duplicate":true}
HTTP 200
```

Same `id`, `duplicate: true`, and **one** row in the database.

### Duplicate detection without a key

With no `Idempotency-Key` header, one is derived from
`sha256(employeeId + eventType + effectiveDate + payload)`. Sending the identical
body twice is therefore *also* deduplicated:

```bash
BODY='{
  "eventType": "ADDRESS_CHANGE",
  "employeeId": "'"$EMPLOYEE_ID"'",
  "effectiveDate": "2026-11-01",
  "payload": { "street": "Musterweg 5", "city": "Hamburg", "postalCode": "20095", "country": "DE" }
}'

curl -s -w ' <- HTTP %{http_code}\n' -X POST "$BASE_URL/events" -H 'Content-Type: application/json' -d "$BODY"
curl -s -w ' <- HTTP %{http_code}\n' -X POST "$BASE_URL/events" -H 'Content-Type: application/json' -d "$BODY"
```

```
{"id":"…","status":"PENDING","duplicate":false} <- HTTP 202
{"id":"…","status":"PENDING","duplicate":true}  <- HTTP 200
```

The JSON is canonicalised before hashing, so key order does not matter —
`{"newSalary":1,"currency":"EUR"}` and `{"currency":"EUR","newSalary":1}` produce the
same key.

**Consequence to be aware of:** an intentional identical resubmission (same employee,
same date, same amount) needs its own distinct `Idempotency-Key`. That trade-off is
deliberate — see `docs/decisions.md` §1.

---

## Read events

### `GET /events/{id}`

Full detail including the payload and the complete status timeline. `failure` and
`result` surface the most recent failing/succeeding transitions so you do not have to
scan `history`.

```bash
EVENT_ID=9c3a4a1e-2b8d-4c1e-9f4a-3f6d0a2c5a70
curl -s "$BASE_URL/events/$EVENT_ID" | jq
```

<details>
<summary>200 — a processed event</summary>

```json
{
  "id": "9c3a4a1e-2b8d-4c1e-9f4a-3f6d0a2c5a70",
  "eventType": "SALARY_CHANGE",
  "employeeId": "3f6d0a2c-9c3a-4a1e-9f4a-2b8d6c1e5a70",
  "effectiveDate": "2026-10-01",
  "status": "SUCCEEDED",
  "payload": { "newSalary": 7500000, "currency": "EUR" },
  "idempotencyKey": "derived:3ce6d9c4b37ea9033570…",
  "attemptCount": 1,
  "createdAt": "2026-08-24T10:00:00.000Z",
  "startedProcessingAt": "2026-08-24T10:00:01.000Z",
  "completedAt": "2026-08-24T10:00:03.000Z",
  "lastError": null,
  "failure": null,
  "result": {
    "newStatus": "SUCCEEDED",
    "details": { "confirmationId": "pay_a1b2c3d4e5f6a7b8c9d0", "appliedAt": "2026-08-24T10:00:03.000Z" },
    "actor": "worker",
    "createdAt": "2026-08-24T10:00:03.000Z"
  },
  "history": [
    { "previousStatus": null, "newStatus": "PENDING", "actor": "api", "createdAt": "2026-08-24T10:00:00.000Z" },
    { "previousStatus": "PENDING", "newStatus": "PROCESSING", "actor": "worker", "createdAt": "2026-08-24T10:00:01.000Z" },
    { "previousStatus": "PROCESSING", "newStatus": "SUCCEEDED", "actor": "worker", "createdAt": "2026-08-24T10:00:03.000Z" }
  ]
}
```

Note `effectiveDate` is a calendar date (`2026-10-01`), not a timestamp — so a client
west of UTC cannot render it as the previous day.
</details>

### `GET /events` — list, filter, paginate

All filters are optional and combine with AND.

```bash
# Everything, newest first
curl -s "$BASE_URL/events" | jq

# One employee
curl -s "$BASE_URL/events?employeeId=$EMPLOYEE_ID" | jq

# Everything that needs attention
curl -s "$BASE_URL/events?status=FAILED_PERMANENT" | jq

# Combined filters + pagination
curl -s "$BASE_URL/events?employeeId=$EMPLOYEE_ID&status=SUCCEEDED&eventType=SALARY_CHANGE&page=1&pageSize=20" | jq
```

<details>
<summary>200 — page envelope</summary>

```json
{
  "data": [
    {
      "id": "9c3a4a1e-…",
      "eventType": "SALARY_CHANGE",
      "employeeId": "3f6d0a2c-…",
      "effectiveDate": "2026-10-01",
      "status": "SUCCEEDED",
      "attemptCount": 1,
      "createdAt": "2026-08-24T10:00:00.000Z",
      "startedProcessingAt": "2026-08-24T10:00:01.000Z",
      "completedAt": "2026-08-24T10:00:03.000Z"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false }
}
```

List rows omit `payload` deliberately — a 100-row page carrying full bank details
would be slow and needlessly expose PII in a view that only renders status.
</details>

**Valid filter values**

| Parameter | Values |
|---|---|
| `status` | `PENDING`, `PROCESSING`, `SUCCEEDED`, `FAILED_TEMPORARY`, `FAILED_PERMANENT` |
| `eventType` | `BANK_ACCOUNT_CHANGE`, `ADDRESS_CHANGE`, `SALARY_CHANGE` |
| `page` | integer ≥ 1 (default 1) |
| `pageSize` | integer 1–100 (default 20) |

---

## Error responses

Every error uses the same shape: `statusCode`, `error`, `message`, `timestamp`, `path`,
plus `details` for validation failures. Stack traces are never returned.

### 400 — missing required payload fields

```bash
curl -s -X POST "$BASE_URL/events" \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"ADDRESS_CHANGE","employeeId":"'"$EMPLOYEE_ID"'","effectiveDate":"2026-09-01","payload":{"city":"Berlin"}}'
```

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "timestamp": "2026-08-24T10:15:00.000Z",
  "path": "/events",
  "details": ["payload: payload is invalid for eventType ADDRESS_CHANGE: street is required; postalCode is required; country is required"]
}
```

### 400 — unknown eventType

Reported as 400, not 422, so clients handle one status code for every request-shape
problem.

```bash
curl -s -X POST "$BASE_URL/events" \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"PROMOTION","employeeId":"'"$EMPLOYEE_ID"'","effectiveDate":"2026-09-01","payload":{}}'
```

```json
{
  "statusCode": 400,
  "details": ["eventType: eventType must be one of: BANK_ACCOUNT_CHANGE, ADDRESS_CHANGE, SALARY_CHANGE"]
}
```

### 400 — payload belongs to a different event type

A field from another type is rejected rather than silently dropped: believing a value
was recorded when it was not is worse than a rejected request.

```bash
curl -s -X POST "$BASE_URL/events" \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"SALARY_CHANGE","employeeId":"'"$EMPLOYEE_ID"'","effectiveDate":"2026-09-01","payload":{"iban":"DE89370400440532013000"}}'
```

```json
{
  "statusCode": 400,
  "details": ["payload: payload is invalid for eventType SALARY_CHANGE: property iban should not exist; newSalary is required; currency is required"]
}
```

### 400 — invalid IBAN checksum

Shape-valid but checksum-invalid. Only a real MOD-97 check catches this.

```bash
curl -s -X POST "$BASE_URL/events" \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"BANK_ACCOUNT_CHANGE","employeeId":"'"$EMPLOYEE_ID"'","effectiveDate":"2026-09-01","payload":{"iban":"DE89370400440532013001"}}'
```

### 404 — unknown event id

```bash
curl -s "$BASE_URL/events/11111111-2222-4333-8444-555555555555"
```

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Event 11111111-2222-4333-8444-555555555555 not found",
  "timestamp": "2026-08-24T10:15:00.000Z",
  "path": "/events/11111111-2222-4333-8444-555555555555"
}
```

### 400 — malformed id

```bash
curl -s "$BASE_URL/events/not-a-uuid"
```

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "details": ["id: id must be a valid UUID"],
  "path": "/events/not-a-uuid"
}
```

---

## End-to-end walkthrough

Submit an event, then watch it move through the pipeline:

```bash
# 1. Submit
RESPONSE=$(curl -s -X POST "$BASE_URL/events" \
  -H 'Content-Type: application/json' \
  -d '{
    "eventType": "SALARY_CHANGE",
    "employeeId": "'"$EMPLOYEE_ID"'",
    "effectiveDate": "2026-12-01",
    "payload": { "newSalary": 9000000, "currency": "EUR" }
  }')
EVENT_ID=$(echo "$RESPONSE" | jq -r .id)
echo "submitted $EVENT_ID"

# 2. Poll until terminal. The worker's simulated provider takes 500–3000ms and
#    fails ~20% of the time, so expect PROCESSING and possible retries.
for i in $(seq 1 20); do
  STATUS=$(curl -s "$BASE_URL/events/$EVENT_ID" | jq -r .status)
  echo "  $STATUS"
  case "$STATUS" in SUCCEEDED|FAILED_PERMANENT|FAILED_TEMPORARY) break ;; esac
  sleep 1
done

# 3. Inspect the full timeline
curl -s "$BASE_URL/events/$EVENT_ID" | jq '{status, attemptCount, lastError, history}'
```

### Per-employee ordering

Events for the *same* employee process strictly in submission order; different
employees run concurrently. Submit three for one employee and the `history`
timestamps will not overlap:

```bash
for AMOUNT in 5000000 6000000 7000000; do
  curl -s -o /dev/null -X POST "$BASE_URL/events" \
    -H 'Content-Type: application/json' \
    -d '{
      "eventType": "SALARY_CHANGE",
      "employeeId": "'"$EMPLOYEE_ID"'",
      "effectiveDate": "2026-12-01",
      "payload": { "newSalary": '"$AMOUNT"', "currency": "EUR" }
    }'
done

curl -s "$BASE_URL/events?employeeId=$EMPLOYEE_ID&pageSize=10" \
  | jq '.data | sort_by(.createdAt) | .[] | {createdAt, startedProcessingAt, completedAt, status}'
```
