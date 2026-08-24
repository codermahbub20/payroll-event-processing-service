import { PrismaClient } from "@payroll/database";
import {
  EmployeeOrdering,
  PayrollEventProducer,
  createRedisConnection,
} from "@payroll/queue";
import type { Redis } from "@payroll/queue";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";
import { randomUUID } from "node:crypto";
import { RedisMemoryServer } from "redis-memory-server";
import { PayrollWorker } from "../src/processor/payroll-worker";

/**
 * Ordering guarantees, verified against a REAL Redis and a REAL Postgres.
 *
 * The whole mechanism rests on Redis's atomic Lua execution and BullMQ's
 * blocking semantics, so an in-memory fake would prove nothing.
 */
describe("per-employee ordering (e2e)", () => {
  let redisServer: RedisMemoryServer;
  let redisUrl: string;
  let connection: Redis;
  let prisma: PrismaClient;
  let producer: PayrollEventProducer;
  let ordering: EmployeeOrdering;

  const createdEmployees: string[] = [];

  /** Records when each event started and finished, to assert interleaving. */
  interface Timeline {
    eventId: string;
    startedAt: number;
    finishedAt: number;
  }

  beforeAll(async () => {
    redisServer = new RedisMemoryServer({});
    const host = await redisServer.getHost();
    const port = await redisServer.getPort();
    redisUrl = `redis://${host}:${port}`;

    connection = createRedisConnection(redisUrl);
    producer = new PayrollEventProducer(connection);
    ordering = new EmployeeOrdering(connection);

    prisma = new PrismaClient({
      datasources: {
        db: {
          url:
            process.env.DATABASE_URL ??
            "postgresql://payroll:payroll@localhost:55432/payroll",
        },
      },
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    if (createdEmployees.length) {
      await prisma.payrollEvent.deleteMany({
        where: { employeeId: { in: createdEmployees } },
      });
    }
    await producer.close();
    await connection.quit();
    await prisma.$disconnect();
    await redisServer.stop();
  });

  beforeEach(async () => {
    // Each test gets a clean queue so a leftover job cannot skew ordering.
    await connection.flushall();
  });

  /** Inserts a PENDING event row and returns its id. */
  async function seedEvent(employeeId: string): Promise<string> {
    const event = await prisma.payrollEvent.create({
      data: {
        eventType: PayrollEventType.SALARY_CHANGE,
        employeeId,
        effectiveDate: new Date("2026-09-01"),
        payload: { newSalary: 7500000, currency: "EUR" },
        idempotencyKey: `ord-${randomUUID()}`,
        status: PayrollEventStatus.PENDING,
      },
      select: { id: true },
    });
    return event.id;
  }

  function newEmployee(): string {
    const id = randomUUID();
    createdEmployees.push(id);
    return id;
  }

  /**
   * Starts a worker whose effect records start/finish timestamps and takes a
   * fixed amount of time, so overlap is detectable.
   */
  function startWorker(
    timeline: Timeline[],
    workDurationMs: number,
    concurrency = 10,
  ): PayrollWorker {
    const inFlight = new Map<string, number>();

    return new PayrollWorker({
      redisUrl,
      prisma,
      concurrency,
      requeueDelayMs: 20,
      applyEffect: async (event) => {
        const startedAt = Date.now();
        inFlight.set(event.id, startedAt);
        await new Promise((resolve) => setTimeout(resolve, workDurationMs));
        timeline.push({
          eventId: event.id,
          startedAt: inFlight.get(event.id)!,
          finishedAt: Date.now(),
        });
        return { ok: true };
      },
    });
  }

  /** Polls until `count` entries are recorded, or throws on timeout. */
  async function waitForTimeline(
    timeline: Timeline[],
    count: number,
    timeoutMs = 30000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (timeline.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${count} events; got ${timeline.length}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  describe("same employee", () => {
    it("processes A fully before B starts", async () => {
      const employeeId = newEmployee();
      const eventA = await seedEvent(employeeId);
      const eventB = await seedEvent(employeeId);

      // Enqueue A then B, in that order.
      await producer.enqueue(eventA, employeeId);
      await producer.enqueue(eventB, employeeId);

      const timeline: Timeline[] = [];
      const worker = startWorker(timeline, 300);
      await worker.waitUntilReady();

      try {
        await waitForTimeline(timeline, 2);
      } finally {
        await worker.close();
      }

      const a = timeline.find((t) => t.eventId === eventA)!;
      const b = timeline.find((t) => t.eventId === eventB)!;

      expect(a).toBeDefined();
      expect(b).toBeDefined();

      // The core assertion: A must be entirely finished before B begins.
      expect(a.finishedAt).toBeLessThanOrEqual(b.startedAt);
      // And they must not overlap at all.
      expect(b.startedAt).toBeGreaterThanOrEqual(a.finishedAt);
    });

    it("preserves submission order across five events", async () => {
      const employeeId = newEmployee();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await seedEvent(employeeId));
      }

      for (const id of ids) {
        await producer.enqueue(id, employeeId);
      }

      const timeline: Timeline[] = [];
      const worker = startWorker(timeline, 60);
      await worker.waitUntilReady();

      try {
        await waitForTimeline(timeline, 5);
      } finally {
        await worker.close();
      }

      // Completion order must match submission order exactly.
      expect(timeline.map((t) => t.eventId)).toEqual(ids);

      // No two events for this employee may overlap in time.
      const sorted = [...timeline].sort((x, y) => x.startedAt - y.startedAt);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].startedAt).toBeGreaterThanOrEqual(
          sorted[i - 1].finishedAt,
        );
      }
    });

    it("advances to the next event after a failure, without wedging the queue", async () => {
      const employeeId = newEmployee();
      const failing = await seedEvent(employeeId);
      const following = await seedEvent(employeeId);

      await producer.enqueue(failing, employeeId);
      await producer.enqueue(following, employeeId);

      const processed: string[] = [];
      const worker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 10,
        requeueDelayMs: 20,
        applyEffect: async (event) => {
          processed.push(event.id);
          if (event.id === failing) {
            throw new Error("simulated downstream failure");
          }
          return { ok: true };
        },
      });
      await worker.waitUntilReady();

      try {
        const deadline = Date.now() + 30000;
        while (!processed.includes(following)) {
          if (Date.now() > deadline) throw new Error("second event never ran");
          await new Promise((r) => setTimeout(r, 25));
        }
      } finally {
        await worker.close();
      }

      // The failure must not block the employee: the lock is released in a
      // finally, so the next event still gets its turn.
      expect(processed).toContain(following);
      expect(processed.indexOf(failing)).toBeLessThan(
        processed.indexOf(following),
      );

      const failedRow = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: failing },
      });
      expect(failedRow.status).toBe(PayrollEventStatus.FAILED_TEMPORARY);
      expect(failedRow.lastError).toContain("simulated downstream failure");
    });
  });

  describe("different employees", () => {
    it("processes two employees' events concurrently", async () => {
      const employeeA = newEmployee();
      const employeeB = newEmployee();
      const eventA = await seedEvent(employeeA);
      const eventB = await seedEvent(employeeB);

      await producer.enqueue(eventA, employeeA);
      await producer.enqueue(eventB, employeeB);

      const timeline: Timeline[] = [];
      const worker = startWorker(timeline, 400);
      await worker.waitUntilReady();

      try {
        await waitForTimeline(timeline, 2);
      } finally {
        await worker.close();
      }

      const a = timeline.find((t) => t.eventId === eventA)!;
      const b = timeline.find((t) => t.eventId === eventB)!;

      // Different employees must NOT be serialised: their execution windows
      // have to overlap, or the lock is over-scoped and throughput collapses.
      const overlap =
        Math.min(a.finishedAt, b.finishedAt) -
        Math.max(a.startedAt, b.startedAt);
      expect(overlap).toBeGreaterThan(0);
    });

    it("runs many employees in parallel while ordering each one", async () => {
      const employeeCount = 5;
      const perEmployee = 3;
      const employees = Array.from({ length: employeeCount }, () =>
        newEmployee(),
      );

      // employeeId -> its event ids in submission order
      const expected = new Map<string, string[]>();
      for (const employeeId of employees) {
        const ids: string[] = [];
        for (let i = 0; i < perEmployee; i++) {
          ids.push(await seedEvent(employeeId));
        }
        expected.set(employeeId, ids);
      }

      // Interleave the enqueues so submission order is not accidentally
      // grouped by employee.
      for (let i = 0; i < perEmployee; i++) {
        for (const employeeId of employees) {
          await producer.enqueue(expected.get(employeeId)![i], employeeId);
        }
      }

      const timeline: Timeline[] = [];
      const worker = startWorker(timeline, 80, 10);
      await worker.waitUntilReady();

      try {
        await waitForTimeline(timeline, employeeCount * perEmployee, 60000);
      } finally {
        await worker.close();
      }

      // Per employee: strict submission order, and no overlap.
      const byEmployee = new Map<string, Timeline[]>();
      for (const entry of timeline) {
        const row = await prisma.payrollEvent.findUniqueOrThrow({
          where: { id: entry.eventId },
          select: { employeeId: true },
        });
        const list = byEmployee.get(row.employeeId) ?? [];
        list.push(entry);
        byEmployee.set(row.employeeId, list);
      }

      for (const employeeId of employees) {
        const entries = byEmployee.get(employeeId) ?? [];
        expect(entries.map((e) => e.eventId)).toEqual(
          expected.get(employeeId),
        );

        for (let i = 1; i < entries.length; i++) {
          expect(entries[i].startedAt).toBeGreaterThanOrEqual(
            entries[i - 1].finishedAt,
          );
        }
      }

      // Across employees, work must genuinely overlap — otherwise this is just
      // a slow serial queue that happens to produce the right order.
      const maxStart = Math.max(...timeline.map((t) => t.startedAt));
      const minFinish = Math.min(...timeline.map((t) => t.finishedAt));
      expect(maxStart).toBeLessThan(
        Math.max(...timeline.map((t) => t.finishedAt)),
      );
      expect(minFinish).toBeGreaterThan(
        Math.min(...timeline.map((t) => t.startedAt)),
      );

      // Serial execution would take at least count * duration; concurrency
      // must beat that comfortably.
      const wallClock =
        Math.max(...timeline.map((t) => t.finishedAt)) -
        Math.min(...timeline.map((t) => t.startedAt));
      const serialLowerBound = employeeCount * perEmployee * 80;
      expect(wallClock).toBeLessThan(serialLowerBound);
    });
  });

  describe("status transitions", () => {
    it("moves the event to PROCESSING and appends history on pickup", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);
      await producer.enqueue(eventId, employeeId);

      // Capture the status observed from inside the effect — by the time the
      // job finishes the row is already SUCCEEDED.
      let statusDuringWork: string | undefined;
      let historyDuringWork = 0;

      const worker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 10,
        applyEffect: async (event) => {
          const row = await prisma.payrollEvent.findUniqueOrThrow({
            where: { id: event.id },
          });
          statusDuringWork = row.status;
          historyDuringWork = await prisma.payrollEventHistory.count({
            where: { eventId: event.id },
          });
          return { ok: true };
        },
      });
      await worker.waitUntilReady();

      try {
        const deadline = Date.now() + 30000;
        while (statusDuringWork === undefined) {
          if (Date.now() > deadline) throw new Error("job never ran");
          await new Promise((r) => setTimeout(r, 25));
        }
        // Let the completion transition land.
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        await worker.close();
      }

      expect(statusDuringWork).toBe(PayrollEventStatus.PROCESSING);
      expect(historyDuringWork).toBeGreaterThanOrEqual(1);

      const final = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      expect(final.status).toBe(PayrollEventStatus.SUCCEEDED);
      expect(final.startedProcessingAt).not.toBeNull();
      expect(final.completedAt).not.toBeNull();
      expect(final.attemptCount).toBe(1);

      const history = await prisma.payrollEventHistory.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });
      expect(history.map((h) => h.newStatus)).toEqual([
        PayrollEventStatus.PROCESSING,
        PayrollEventStatus.SUCCEEDED,
      ]);
    });

    it("applies the business effect at most once across redelivery", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);

      let effectRuns = 0;
      const worker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 10,
        applyEffect: async () => {
          effectRuns += 1;
          return { ok: true };
        },
      });
      await worker.waitUntilReady();

      try {
        await producer.enqueue(eventId, employeeId);

        const deadline = Date.now() + 30000;
        while (effectRuns === 0) {
          if (Date.now() > deadline) throw new Error("effect never ran");
          await new Promise((r) => setTimeout(r, 25));
        }
        await new Promise((r) => setTimeout(r, 400));

        // Simulate an at-least-once redelivery of the same event.
        await connection.del(`payroll:employee:${employeeId}:queue`);
        await producer.enqueue(eventId, employeeId);
        await new Promise((r) => setTimeout(r, 1500));
      } finally {
        await worker.close();
      }

      // The applied_operations ledger must prevent a second application.
      expect(effectRuns).toBe(1);

      const ledger = await prisma.appliedOperation.findMany({
        where: { eventId },
      });
      expect(ledger).toHaveLength(1);
    });
  });

  describe("ordering primitives", () => {
    it("refuses the lock for an event that is not at the head", async () => {
      const employeeId = newEmployee();
      const first = randomUUID();
      const second = randomUUID();

      await ordering.register(employeeId, first);
      await ordering.register(employeeId, second);

      expect(await ordering.acquire(employeeId, second)).toBe(false);
      expect(await ordering.acquire(employeeId, first)).toBe(true);
    });

    it("is re-entrant for the same event", async () => {
      const employeeId = newEmployee();
      const eventId = randomUUID();
      await ordering.register(employeeId, eventId);

      expect(await ordering.acquire(employeeId, eventId)).toBe(true);
      // A retry of the same event must not deadlock against its own lock.
      expect(await ordering.acquire(employeeId, eventId)).toBe(true);
    });

    it("advances to the next event on release", async () => {
      const employeeId = newEmployee();
      const first = randomUUID();
      const second = randomUUID();
      await ordering.register(employeeId, first);
      await ordering.register(employeeId, second);

      await ordering.acquire(employeeId, first);
      const next = await ordering.release(employeeId, first);

      expect(next).toBe(second);
      expect(await ordering.lockHolder(employeeId)).toBeNull();
      expect(await ordering.acquire(employeeId, second)).toBe(true);
    });

    it("does not double-register a redelivered event", async () => {
      const employeeId = newEmployee();
      const eventId = randomUUID();

      expect(await ordering.register(employeeId, eventId)).toBe(1);
      // Second registration returns null (already present) and must not add a
      // duplicate entry, which would leave the queue permanently blocked.
      expect(await ordering.register(employeeId, eventId)).toBeNull();
      expect(await ordering.pending(employeeId)).toEqual([eventId]);
    });

    it("only lets one of many concurrent acquirers win", async () => {
      const employeeId = newEmployee();
      const eventId = randomUUID();
      await ordering.register(employeeId, eventId);

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          ordering.acquire(employeeId, `other-${randomUUID()}`),
        ),
      );

      // None of them are at the head, so all must be refused.
      expect(results.every((r) => r === false)).toBe(true);
    });

    it("isolates locks between employees", async () => {
      const employeeA = newEmployee();
      const employeeB = newEmployee();
      const eventA = randomUUID();
      const eventB = randomUUID();

      await ordering.register(employeeA, eventA);
      await ordering.register(employeeB, eventB);

      // Holding A's lock must not affect B.
      expect(await ordering.acquire(employeeA, eventA)).toBe(true);
      expect(await ordering.acquire(employeeB, eventB)).toBe(true);
    });
  });
});
