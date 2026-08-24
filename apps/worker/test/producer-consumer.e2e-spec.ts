import { PrismaClient } from "@payroll/database";
import { PayrollEventProducer, createRedisConnection } from "@payroll/queue";
import type { Redis } from "@payroll/queue";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";
import { randomUUID } from "node:crypto";
import { RedisMemoryServer } from "redis-memory-server";
import { PayrollWorker } from "../src/processor/payroll-worker";

/**
 * End-to-end across the process boundary: the API's producer and the worker's
 * consumer, talking over a real Redis and a real Postgres.
 *
 * The ordering suite exercises the worker in isolation; this one proves the
 * two halves actually agree on the queue name and job payload contract.
 */
describe("producer -> consumer (e2e)", () => {
  let redisServer: RedisMemoryServer;
  let redisUrl: string;
  let connection: Redis;
  let producer: PayrollEventProducer;
  let prisma: PrismaClient;
  const employees: string[] = [];

  beforeAll(async () => {
    redisServer = new RedisMemoryServer({});
    const host = await redisServer.getHost();
    const port = await redisServer.getPort();
    redisUrl = `redis://${host}:${port}`;

    connection = createRedisConnection(redisUrl);
    producer = new PayrollEventProducer(connection);

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
    if (employees.length) {
      await prisma.payrollEvent.deleteMany({
        where: { employeeId: { in: employees } },
      });
    }
    await producer.close();
    await connection.quit();
    await prisma.$disconnect();
    await redisServer.stop();
  });

  it("carries an event from producer to worker and to a terminal status", async () => {
    const employeeId = randomUUID();
    employees.push(employeeId);

    const event = await prisma.payrollEvent.create({
      data: {
        eventType: PayrollEventType.BANK_ACCOUNT_CHANGE,
        employeeId,
        effectiveDate: new Date("2026-09-01"),
        payload: { iban: "DE89370400440532013000" },
        idempotencyKey: `pc-${randomUUID()}`,
        status: PayrollEventStatus.PENDING,
      },
      select: { id: true },
    });

    const processed: string[] = [];
    const worker = new PayrollWorker({
      redisUrl,
      prisma,
      concurrency: 10,
      applyEffect: async (e) => {
        processed.push(e.id);
        return { providerRef: "ref-1" };
      },
    });
    await worker.waitUntilReady();

    try {
      // Exactly the call the API's BullEventQueue makes.
      await producer.enqueue(event.id, employeeId);

      const deadline = Date.now() + 30000;
      while (!processed.includes(event.id)) {
        if (Date.now() > deadline) throw new Error("event never processed");
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      await worker.close();
    }

    const final = await prisma.payrollEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(final.status).toBe(PayrollEventStatus.SUCCEEDED);
    expect(final.completedAt).not.toBeNull();

    const history = await prisma.payrollEventHistory.findMany({
      where: { eventId: event.id },
      orderBy: { createdAt: "asc" },
    });
    expect(history.map((h) => h.newStatus)).toEqual([
      PayrollEventStatus.PROCESSING,
      PayrollEventStatus.SUCCEEDED,
    ]);

    // The success result is recorded in the audit trail.
    expect(history[1].details).toMatchObject({ providerRef: "ref-1" });
  });

  it("collapses a duplicate enqueue of the same event into one job", async () => {
    const employeeId = randomUUID();
    employees.push(employeeId);

    const event = await prisma.payrollEvent.create({
      data: {
        eventType: PayrollEventType.SALARY_CHANGE,
        employeeId,
        effectiveDate: new Date("2026-09-01"),
        payload: { newSalary: 7500000, currency: "EUR" },
        idempotencyKey: `pc-dup-${randomUUID()}`,
        status: PayrollEventStatus.PENDING,
      },
      select: { id: true },
    });

    // Two enqueues of the same event, as an at-least-once retry would produce.
    await producer.enqueue(event.id, employeeId);
    await producer.enqueue(event.id, employeeId);

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
      const deadline = Date.now() + 30000;
      while (effectRuns === 0) {
        if (Date.now() > deadline) throw new Error("event never processed");
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      await worker.close();
    }

    // jobId = eventId dedups at the queue, and the ledger backstops it.
    expect(effectRuns).toBe(1);
    expect(
      await prisma.appliedOperation.count({ where: { eventId: event.id } }),
    ).toBe(1);
  });
});
