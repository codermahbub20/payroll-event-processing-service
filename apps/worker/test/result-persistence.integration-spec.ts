import { PrismaClient } from "@payroll/database";
import { EmployeeOrdering, createRedisConnection } from "@payroll/queue";
import type { Redis } from "@payroll/queue";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";
import { randomUUID } from "node:crypto";
import { startRedis, type RedisFixture } from "./redis-fixture";
import { EventProcessor } from "../src/processor/event-processor";

/**
 * Scenario: "processing results are persisted correctly".
 *
 * The other suites assert that an event *reaches* a status. This one asserts
 * what actually lands in the three tables — the provider's result object, the
 * audit entry, and the at-most-once ledger — because a status flag alone does
 * not prove the outcome was recorded in a way anyone can audit later.
 */
describe("[integration] processing result persistence", () => {
  let redisFixture: RedisFixture;
  let connection: Redis;
  let ordering: EmployeeOrdering;
  let prisma: PrismaClient;
  const employees: string[] = [];

  beforeAll(async () => {
    redisFixture = await startRedis();

    connection = createRedisConnection(redisFixture.url);
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
    if (employees.length) {
      await prisma.payrollEvent.deleteMany({
        where: { employeeId: { in: employees } },
      });
    }
    await connection.quit();
    await prisma.$disconnect();
    await redisFixture.stop();
  });

  beforeEach(async () => {
    await connection.flushall();
  });

  function newEmployee(): string {
    const id = randomUUID();
    employees.push(id);
    return id;
  }

  async function seed(
    employeeId: string,
    eventType = PayrollEventType.SALARY_CHANGE,
    payload: unknown = { newSalary: 7500000, currency: "EUR" },
  ): Promise<string> {
    const event = await prisma.payrollEvent.create({
      data: {
        eventType,
        employeeId,
        effectiveDate: new Date("2026-09-01"),
        payload: payload as never,
        idempotencyKey: `persist-${randomUUID()}`,
        status: PayrollEventStatus.PENDING,
      },
      select: { id: true },
    });
    return event.id;
  }

  function fakeJob(eventId: string, employeeId: string) {
    return {
      data: { eventId, employeeId },
      attemptsMade: 0,
      opts: { attempts: 3 },
      name: "payroll-events",
      moveToDelayed: async () => {
        throw new Error("unexpected defer");
      },
    } as never;
  }

  it("stores the provider result verbatim in the applied_operations ledger", async () => {
    const employeeId = newEmployee();
    const eventId = await seed(employeeId);

    const providerResult = {
      appliedAt: "2026-08-24T10:00:00.000Z",
      confirmationId: "pay_persisted_check",
      latencyMs: 1234,
    };

    const processor = new EventProcessor(prisma, ordering, {
      gateway: { apply: async () => providerResult },
    });

    await ordering.register(employeeId, eventId);
    await processor.process(fakeJob(eventId, employeeId));

    const ledger = await prisma.appliedOperation.findMany({
      where: { eventId },
    });

    expect(ledger).toHaveLength(1);
    expect(ledger[0].operationKey).toBe("apply-payroll-change");
    // The full result is stored, not just a success flag — a later audit needs
    // the provider's own reference to reconcile against.
    expect(ledger[0].result).toEqual(providerResult);
    expect(ledger[0].appliedAt).toBeInstanceOf(Date);
  });

  it("mirrors the result into the audit history entry", async () => {
    const employeeId = newEmployee();
    const eventId = await seed(employeeId);

    const processor = new EventProcessor(prisma, ordering, {
      gateway: {
        apply: async () => ({
          appliedAt: "2026-08-24T11:00:00.000Z",
          confirmationId: "pay_history_check",
          latencyMs: 42,
        }),
      },
    });

    await ordering.register(employeeId, eventId);
    await processor.process(fakeJob(eventId, employeeId));

    const history = await prisma.payrollEventHistory.findMany({
      where: { eventId },
      orderBy: { createdAt: "asc" },
    });

    const succeeded = history.find(
      (h) => h.newStatus === PayrollEventStatus.SUCCEEDED,
    );
    expect(succeeded).toBeDefined();
    expect(succeeded!.previousStatus).toBe(PayrollEventStatus.PROCESSING);
    expect(succeeded!.actor).toBe("worker");
    expect(succeeded!.details).toMatchObject({
      confirmationId: "pay_history_check",
    });
  });

  it("records the complete set of event columns on success", async () => {
    const employeeId = newEmployee();
    const eventId = await seed(employeeId);

    const before = Date.now();
    const processor = new EventProcessor(prisma, ordering, {
      gateway: {
        apply: async () => ({
          appliedAt: new Date().toISOString(),
          confirmationId: "pay_columns",
          latencyMs: 1,
        }),
      },
    });

    await ordering.register(employeeId, eventId);
    await processor.process(fakeJob(eventId, employeeId));

    const row = await prisma.payrollEvent.findUniqueOrThrow({
      where: { id: eventId },
    });

    expect(row.status).toBe(PayrollEventStatus.SUCCEEDED);
    expect(row.attemptCount).toBe(1);
    expect(row.startedProcessingAt).not.toBeNull();
    expect(row.completedAt).not.toBeNull();
    // A successful run must clear any stale error from an earlier attempt.
    expect(row.lastError).toBeNull();
    expect(row.nextAttemptAt).toBeNull();
    // Optimistic-lock counter advanced (PROCESSING then SUCCEEDED).
    expect(row.version).toBeGreaterThanOrEqual(2);

    expect(row.completedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.completedAt!.getTime()).toBeGreaterThanOrEqual(
      row.startedProcessingAt!.getTime(),
    );
  });

  it("persists the failure reason and code on a permanent failure", async () => {
    const employeeId = newEmployee();
    // Invalid business data: fails validation before the provider is reached.
    const eventId = await seed(employeeId, PayrollEventType.SALARY_CHANGE, {
      newSalary: -5000,
      currency: "EUR",
    });

    const processor = new EventProcessor(prisma, ordering, {
      gateway: {
        apply: async () => {
          throw new Error("provider must not be reached");
        },
      },
    });

    await ordering.register(employeeId, eventId);
    await expect(
      processor.process(fakeJob(eventId, employeeId)),
    ).rejects.toBeDefined();

    const row = await prisma.payrollEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    expect(row.status).toBe(PayrollEventStatus.FAILED_PERMANENT);
    expect(row.lastError).toContain("positive");

    const history = await prisma.payrollEventHistory.findMany({
      where: { eventId },
      orderBy: { createdAt: "asc" },
    });
    const failed = history[history.length - 1];
    expect(failed.newStatus).toBe(PayrollEventStatus.FAILED_PERMANENT);
    // The structured code is what an operator filters on; the message is for
    // humans. Both are recorded.
    expect(failed.details).toMatchObject({
      code: "BUSINESS_VALIDATION_FAILED",
    });

    // Nothing was applied, so the ledger must stay empty.
    expect(
      await prisma.appliedOperation.count({ where: { eventId } }),
    ).toBe(0);
  });

  it("keeps the payload intact through the jsonb round trip", async () => {
    const employeeId = newEmployee();
    const payload = {
      street: "Hauptstrasse 1",
      city: "Berlin",
      postalCode: "10115",
      country: "DE",
    };
    const eventId = await seed(
      employeeId,
      PayrollEventType.ADDRESS_CHANGE,
      payload,
    );

    const processor = new EventProcessor(prisma, ordering, {
      gateway: {
        apply: async () => ({
          appliedAt: new Date().toISOString(),
          confirmationId: "pay_payload",
          latencyMs: 1,
        }),
      },
    });

    await ordering.register(employeeId, eventId);
    await processor.process(fakeJob(eventId, employeeId));

    const row = await prisma.payrollEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    expect(row.payload).toEqual(payload);
  });
});
