import { PrismaClient } from "@payroll/database";
import { PayrollEventProducer, createRedisConnection } from "@payroll/queue";
import type { Redis } from "@payroll/queue";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";
import { randomUUID } from "node:crypto";
import { startRedis, type RedisFixture } from "./redis-fixture";
import {
  PermanentProcessingError,
  TemporaryProcessingError,
} from "../src/processing/errors";
import { SimulatedPayrollGateway } from "../src/processing/payroll-gateway";
import {
  StructuredLogger,
  type ProcessingLogFields,
} from "../src/processing/structured-logger";
import { PayrollWorker } from "../src/processor/payroll-worker";

/**
 * Retry and failure-classification behaviour, against a real Redis and a real
 * Postgres. The retry mechanics live in BullMQ's Lua scripts, so a fake queue
 * would prove nothing about them.
 */
describe("[integration] retry and failure classification", () => {
  const ATTEMPTS = 3;

  let redisFixture: RedisFixture;
  let redisUrl: string;
  let connection: Redis;
  let producer: PayrollEventProducer;
  let prisma: PrismaClient;
  const employees: string[] = [];

  beforeAll(async () => {
    redisFixture = await startRedis();
    redisUrl = redisFixture.url;

    connection = createRedisConnection(redisUrl);
    producer = new PayrollEventProducer(connection, {
      attempts: ATTEMPTS,
      // Short backoff keeps the test fast while still exercising the
      // exponential path (~40ms then ~80ms).
      backoffMs: 40,
    });

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

  async function seedEvent(
    employeeId: string,
    overrides: {
      eventType?: PayrollEventType;
      payload?: unknown;
    } = {},
  ): Promise<string> {
    const event = await prisma.payrollEvent.create({
      data: {
        eventType: overrides.eventType ?? PayrollEventType.SALARY_CHANGE,
        employeeId,
        effectiveDate: new Date("2026-09-01"),
        payload: (overrides.payload ?? {
          newSalary: 7500000,
          currency: "EUR",
        }) as never,
        idempotencyKey: `retry-${randomUUID()}`,
        status: PayrollEventStatus.PENDING,
      },
      select: { id: true },
    });
    return event.id;
  }

  /** Waits until the event reaches a status in `wanted`, or throws. */
  async function waitForStatus(
    eventId: string,
    wanted: PayrollEventStatus[],
    timeoutMs = 30000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
        select: { status: true },
      });
      if (wanted.includes(row.status as PayrollEventStatus)) return row.status;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${wanted.join("/")}; still ${row.status}`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  describe("100% temporary failure rate", () => {
    it("exhausts the retry budget then lands FAILED_TEMPORARY", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);

      let gatewayCalls = 0;
      const logs: ProcessingLogFields[] = [];

      const worker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 10,
        gateway: {
          apply: async () => {
            gatewayCalls += 1;
            throw new TemporaryProcessingError(
              "payroll provider returned 503 Service Unavailable",
              "DOWNSTREAM_UNAVAILABLE",
            );
          },
        },
        logger: new StructuredLogger({
          write: (line) => logs.push(JSON.parse(line)),
        }),
      });
      await worker.waitUntilReady();

      try {
        await producer.enqueue(eventId, employeeId);
        await waitForStatus(eventId, [PayrollEventStatus.FAILED_TEMPORARY]);
      } finally {
        await worker.close();
      }

      // BullMQ retried the full budget before giving up.
      expect(gatewayCalls).toBe(ATTEMPTS);

      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      expect(row.status).toBe(PayrollEventStatus.FAILED_TEMPORARY);
      expect(row.attemptCount).toBe(ATTEMPTS);
      expect(row.lastError).toContain("503");
      // FAILED_TEMPORARY is not terminal-terminal: it stays eligible for a
      // later re-trigger, so completedAt must remain unset.
      expect(row.completedAt).toBeNull();

      // The effect never applied, so the ledger must stay empty.
      expect(
        await prisma.appliedOperation.count({ where: { eventId } }),
      ).toBe(0);
    });

    it("records every attempt in the audit trail with the error reason", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);

      const worker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 10,
        gateway: {
          apply: async () => {
            throw new TemporaryProcessingError(
              "payroll provider timed out after 30s",
              "DOWNSTREAM_TIMEOUT",
            );
          },
        },
      });
      await worker.waitUntilReady();

      try {
        await producer.enqueue(eventId, employeeId);
        await waitForStatus(eventId, [PayrollEventStatus.FAILED_TEMPORARY]);
      } finally {
        await worker.close();
      }

      const history = await prisma.payrollEventHistory.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });

      // One PROCESSING entry per attempt, plus a retry note per non-final
      // attempt, plus the final FAILED_TEMPORARY.
      const finalEntry = history[history.length - 1];
      expect(finalEntry.newStatus).toBe(PayrollEventStatus.FAILED_TEMPORARY);
      expect(finalEntry.details).toMatchObject({
        error: expect.stringContaining("timed out"),
        code: "DOWNSTREAM_TIMEOUT",
        exhausted: true,
      });

      // Intermediate attempts are auditable too.
      const retryNotes = history.filter(
        (h) =>
          (h.details as Record<string, unknown> | null)?.willRetry === true,
      );
      expect(retryNotes.length).toBe(ATTEMPTS - 1);
    });

    it("emits structured logs naming the attempt and retry intent", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);
      const logs: ProcessingLogFields[] = [];

      const worker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 10,
        gateway: {
          apply: async () => {
            throw new TemporaryProcessingError("503", "DOWNSTREAM_UNAVAILABLE");
          },
        },
        logger: new StructuredLogger({
          write: (line) => logs.push(JSON.parse(line)),
        }),
      });
      await worker.waitUntilReady();

      try {
        await producer.enqueue(eventId, employeeId);
        await waitForStatus(eventId, [PayrollEventStatus.FAILED_TEMPORARY]);
      } finally {
        await worker.close();
      }

      const started = logs.filter((l) => l.event === "processing_started");
      const failed = logs.filter(
        (l) => l.event === "processing_failed_temporary",
      );

      expect(started).toHaveLength(ATTEMPTS);
      expect(failed).toHaveLength(ATTEMPTS);

      // Attempt numbers are 1-based and monotonic.
      expect(started.map((l) => l.attempt)).toEqual([1, 2, 3]);

      // Only the final failure reports the budget as spent.
      expect(failed.map((l) => l.willRetry)).toEqual([true, true, false]);

      for (const line of [...started, ...failed]) {
        expect(line.eventId).toBe(eventId);
        expect(line.employeeId).toBe(employeeId);
        expect(line.eventType).toBe(PayrollEventType.SALARY_CHANGE);
        expect(line.maxAttempts).toBe(ATTEMPTS);
      }
    });
  });

  describe("permanent failure", () => {
    it("fails immediately with no retries on a non-retryable provider error", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);

      let gatewayCalls = 0;
      const worker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 10,
        gateway: {
          apply: async () => {
            gatewayCalls += 1;
            throw new PermanentProcessingError(
              "employee not found in payroll system",
              "EMPLOYEE_NOT_FOUND",
            );
          },
        },
      });
      await worker.waitUntilReady();

      try {
        await producer.enqueue(eventId, employeeId);
        await waitForStatus(eventId, [PayrollEventStatus.FAILED_PERMANENT]);
        // Give any (incorrect) retry time to appear before asserting.
        await new Promise((r) => setTimeout(r, 800));
      } finally {
        await worker.close();
      }

      // The whole point: exactly one call, despite attempts=3.
      expect(gatewayCalls).toBe(1);

      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      expect(row.status).toBe(PayrollEventStatus.FAILED_PERMANENT);
      expect(row.attemptCount).toBe(1);
      expect(row.lastError).toContain("employee not found");
      // Permanent failure IS terminal, so completion is stamped.
      expect(row.completedAt).not.toBeNull();
    });

    it("fails permanently on business validation without calling the provider", async () => {
      const employeeId = newEmployee();
      // Negative salary: invalid business data that no retry can fix.
      const eventId = await seedEvent(employeeId, {
        payload: { newSalary: -5000, currency: "EUR" },
      });

      let gatewayCalls = 0;
      const logs: ProcessingLogFields[] = [];
      const worker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 10,
        gateway: {
          apply: async () => {
            gatewayCalls += 1;
            return {
              appliedAt: new Date().toISOString(),
              confirmationId: "should-not-happen",
              latencyMs: 0,
            };
          },
        },
        logger: new StructuredLogger({
          write: (line) => logs.push(JSON.parse(line)),
        }),
      });
      await worker.waitUntilReady();

      try {
        await producer.enqueue(eventId, employeeId);
        await waitForStatus(eventId, [PayrollEventStatus.FAILED_PERMANENT]);
        await new Promise((r) => setTimeout(r, 800));
      } finally {
        await worker.close();
      }

      // Validation runs before the provider call, so it is never reached.
      expect(gatewayCalls).toBe(0);

      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      expect(row.status).toBe(PayrollEventStatus.FAILED_PERMANENT);
      expect(row.attemptCount).toBe(1);

      const permanentLog = logs.find(
        (l) => l.event === "processing_failed_permanent",
      );
      expect(permanentLog).toBeDefined();
      expect(permanentLog!.errorCode).toBe("BUSINESS_VALIDATION_FAILED");
      expect(permanentLog!.willRetry).toBe(false);
      expect(permanentLog!.violations).toEqual(
        expect.arrayContaining([expect.stringContaining("positive")]),
      );

      const history = await prisma.payrollEventHistory.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });
      const final = history[history.length - 1];
      expect(final.newStatus).toBe(PayrollEventStatus.FAILED_PERMANENT);
      expect(final.details).toMatchObject({
        code: "BUSINESS_VALIDATION_FAILED",
      });
    });

    it("rejects an invalid IBAN permanently", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId, {
        eventType: PayrollEventType.BANK_ACCOUNT_CHANGE,
        // Valid shape, wrong checksum — only a real MOD-97 check catches this.
        payload: { iban: "DE89370400440532013001" },
      });

      const worker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 10,
        gateway: {
          apply: async () => {
            throw new Error("provider should not be reached");
          },
        },
      });
      await worker.waitUntilReady();

      try {
        await producer.enqueue(eventId, employeeId);
        await waitForStatus(eventId, [PayrollEventStatus.FAILED_PERMANENT]);
      } finally {
        await worker.close();
      }

      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      expect(row.status).toBe(PayrollEventStatus.FAILED_PERMANENT);
      expect(row.lastError).toContain("checksum");
    });
  });

  describe("success path", () => {
    it("stores the provider result and marks SUCCEEDED", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);
      const logs: ProcessingLogFields[] = [];

      const worker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 10,
        gateway: new SimulatedPayrollGateway({
          temporaryFailureRate: 0,
          permanentFailureRate: 0,
          sleep: async () => undefined,
        }),
        logger: new StructuredLogger({
          write: (line) => logs.push(JSON.parse(line)),
        }),
      });
      await worker.waitUntilReady();

      try {
        await producer.enqueue(eventId, employeeId);
        await waitForStatus(eventId, [PayrollEventStatus.SUCCEEDED]);
      } finally {
        await worker.close();
      }

      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      expect(row.status).toBe(PayrollEventStatus.SUCCEEDED);
      expect(row.completedAt).not.toBeNull();
      expect(row.lastError).toBeNull();

      // The result object is persisted in both the ledger and the audit trail.
      const ledger = await prisma.appliedOperation.findMany({
        where: { eventId },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].result).toMatchObject({
        confirmationId: expect.stringMatching(/^pay_/),
        appliedAt: expect.any(String),
      });

      const history = await prisma.payrollEventHistory.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });
      const final = history[history.length - 1];
      expect(final.newStatus).toBe(PayrollEventStatus.SUCCEEDED);
      expect(final.details).toMatchObject({
        confirmationId: expect.stringMatching(/^pay_/),
      });

      const success = logs.find((l) => l.event === "processing_succeeded");
      expect(success).toMatchObject({
        eventId,
        employeeId,
        attempt: 1,
        confirmationId: expect.stringMatching(/^pay_/),
      });
      expect(typeof success!.durationMs).toBe("number");
    });

    it("succeeds on a later attempt after transient failures", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);

      let calls = 0;
      const worker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 10,
        gateway: {
          apply: async () => {
            calls += 1;
            if (calls < ATTEMPTS) {
              throw new TemporaryProcessingError("503", "DOWNSTREAM_UNAVAILABLE");
            }
            return {
              appliedAt: new Date().toISOString(),
              confirmationId: "pay_recovered",
              latencyMs: 1,
            };
          },
        },
      });
      await worker.waitUntilReady();

      try {
        await producer.enqueue(eventId, employeeId);
        await waitForStatus(eventId, [PayrollEventStatus.SUCCEEDED]);
      } finally {
        await worker.close();
      }

      expect(calls).toBe(ATTEMPTS);

      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      expect(row.status).toBe(PayrollEventStatus.SUCCEEDED);
      // A recovered event clears its error rather than leaving a stale one.
      expect(row.lastError).toBeNull();
    });
  });
});
