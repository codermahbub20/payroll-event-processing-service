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
import {
  StructuredLogger,
  type ProcessingLogFields,
} from "../src/processing/structured-logger";
import { EventProcessor } from "../src/processor/event-processor";
import { PayrollWorker } from "../src/processor/payroll-worker";
import {
  RecoverySweep,
  ScheduledRecoverySweep,
} from "../src/processor/recovery-sweep";

/**
 * Crash-consistency guarantees, against a real Redis and a real Postgres.
 *
 * The scenario under test: the payroll operation succeeds and the DB write
 * lands, then the worker dies before acknowledging the job, so BullMQ
 * redelivers the event. Reprocessing must not re-apply the business effect.
 */
describe("crash recovery and duplicate delivery (e2e)", () => {
  let redisServer: RedisMemoryServer;
  let redisUrl: string;
  let connection: Redis;
  let producer: PayrollEventProducer;
  let ordering: EmployeeOrdering;
  let prisma: PrismaClient;
  const employees: string[] = [];

  beforeAll(async () => {
    redisServer = new RedisMemoryServer({});
    const host = await redisServer.getHost();
    const port = await redisServer.getPort();
    redisUrl = `redis://${host}:${port}`;

    connection = createRedisConnection(redisUrl);
    producer = new PayrollEventProducer(connection, { attempts: 3, backoffMs: 40 });
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
    await producer.close();
    await connection.quit();
    await prisma.$disconnect();
    await redisServer.stop();
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
    overrides: Partial<{
      status: PayrollEventStatus;
      startedProcessingAt: Date | null;
      attemptCount: number;
    }> = {},
  ): Promise<string> {
    const event = await prisma.payrollEvent.create({
      data: {
        eventType: PayrollEventType.SALARY_CHANGE,
        employeeId,
        effectiveDate: new Date("2026-09-01"),
        payload: { newSalary: 7500000, currency: "EUR" } as never,
        idempotencyKey: `crash-${randomUUID()}`,
        status: overrides.status ?? PayrollEventStatus.PENDING,
        startedProcessingAt: overrides.startedProcessingAt ?? null,
        attemptCount: overrides.attemptCount ?? 0,
      },
      select: { id: true },
    });
    return event.id;
  }

  /**
   * Minimal Job stand-in, so the processor can be driven directly without a
   * queue — which is how a crash-then-redeliver is simulated deterministically.
   *
   * `moveToDelayed` throws rather than resolving: the real BullMQ contract is
   * that the handler then throws DelayedError, so a silent no-op here would
   * let a deferred job hang the test instead of failing it.
   */
  function fakeJob(eventId: string, employeeId: string, attemptsMade = 0) {
    return {
      data: { eventId, employeeId },
      attemptsMade,
      opts: { attempts: 3 },
      name: "payroll-events",
      moveToDelayed: async () => {
        throw new Error(
          "fakeJob.moveToDelayed called: the event was not at the head of its queue",
        );
      },
    } as never;
  }

  describe("crash after DB write, before job ack", () => {
    it("does not re-call the provider when the event is already SUCCEEDED", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);

      let providerCalls = 0;
      const logs: ProcessingLogFields[] = [];
      const gateway = {
        apply: async () => {
          providerCalls += 1;
          return {
            appliedAt: new Date().toISOString(),
            confirmationId: "pay_first_delivery",
            latencyMs: 1,
          };
        },
      };

      const processor = new EventProcessor(prisma, ordering, {
        gateway,
        logger: new StructuredLogger({
          write: (line) => logs.push(JSON.parse(line)),
        }),
      });

      // Delivery 1: completes fully.
      await ordering.register(employeeId, eventId);
      await processor.process(fakeJob(eventId, employeeId));

      expect(providerCalls).toBe(1);
      const afterFirst = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      expect(afterFirst.status).toBe(PayrollEventStatus.SUCCEEDED);

      // Delivery 2: the same event redelivered, as BullMQ would after a crash
      // that lost the ack.
      await ordering.register(employeeId, eventId);
      const second = await processor.process(fakeJob(eventId, employeeId));

      // THE core assertion: the external system is never called again.
      expect(providerCalls).toBe(1);
      expect(second).toMatchObject({
        status: PayrollEventStatus.SUCCEEDED,
        alreadyApplied: true,
      });

      const skipLog = logs.find(
        (l) => l.event === "duplicate_delivery_skipped",
      );
      expect(skipLog).toBeDefined();
      expect(skipLog!.message).toContain("duplicate delivery detected");
      expect(skipLog!.reason).toBe("already_terminal");
    });

    it("does not corrupt the history log on redelivery", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);

      const processor = new EventProcessor(prisma, ordering, {
        gateway: {
          apply: async () => ({
            appliedAt: new Date().toISOString(),
            confirmationId: "pay_once",
            latencyMs: 1,
          }),
        },
      });

      await ordering.register(employeeId, eventId);
      await processor.process(fakeJob(eventId, employeeId));

      const historyAfterFirst = await prisma.payrollEventHistory.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });

      // Three redeliveries.
      for (let i = 0; i < 3; i++) {
        await ordering.register(employeeId, eventId);
        await processor.process(fakeJob(eventId, employeeId));
      }

      const historyAfterRedeliveries =
        await prisma.payrollEventHistory.findMany({
          where: { eventId },
          orderBy: { createdAt: "asc" },
        });

      // The audit trail must be byte-identical: no phantom PROCESSING or
      // duplicate SUCCEEDED entries from deliveries that did no work.
      expect(historyAfterRedeliveries).toHaveLength(historyAfterFirst.length);
      expect(historyAfterRedeliveries.map((h) => h.newStatus)).toEqual([
        PayrollEventStatus.PROCESSING,
        PayrollEventStatus.SUCCEEDED,
      ]);

      // And exactly one ledger row.
      expect(
        await prisma.appliedOperation.count({ where: { eventId } }),
      ).toBe(1);
    });

    it("finishes the transition when the crash landed after the ledger write", async () => {
      // The nastiest window: the provider was called and the ledger row
      // committed, then the process died before the event reached SUCCEEDED.
      // The row is left PROCESSING with the effect already applied.
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId, {
        status: PayrollEventStatus.PROCESSING,
        startedProcessingAt: new Date(),
        attemptCount: 1,
      });

      await prisma.appliedOperation.create({
        data: {
          eventId,
          operationKey: "apply-payroll-change",
          result: {
            appliedAt: "2026-08-24T10:00:00.000Z",
            confirmationId: "pay_from_dead_worker",
            latencyMs: 42,
          } as never,
        },
      });

      let providerCalls = 0;
      const logs: ProcessingLogFields[] = [];
      const processor = new EventProcessor(prisma, ordering, {
        gateway: {
          apply: async () => {
            providerCalls += 1;
            return {
              appliedAt: new Date().toISOString(),
              confirmationId: "pay_SHOULD_NOT_HAPPEN",
              latencyMs: 1,
            };
          },
        },
        logger: new StructuredLogger({
          write: (line) => logs.push(JSON.parse(line)),
        }),
      });

      await ordering.register(employeeId, eventId);
      await processor.process(fakeJob(eventId, employeeId));

      // The provider must NOT be called again — the ledger proves it ran.
      expect(providerCalls).toBe(0);

      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      // The redelivery completes the transition the dead worker never made.
      expect(row.status).toBe(PayrollEventStatus.SUCCEEDED);
      expect(row.completedAt).not.toBeNull();

      // The ORIGINAL confirmation is preserved, not a freshly generated one.
      const history = await prisma.payrollEventHistory.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });
      const succeeded = history.find(
        (h) => h.newStatus === PayrollEventStatus.SUCCEEDED,
      );
      expect(succeeded!.details).toMatchObject({
        confirmationId: "pay_from_dead_worker",
      });

      expect(
        await prisma.appliedOperation.count({ where: { eventId } }),
      ).toBe(1);

      const skipLog = logs.find(
        (l) => l.event === "duplicate_delivery_skipped",
      );
      expect(skipLog!.reason).toBe("effect_already_applied");
    });

    it("short-circuits a redelivered FAILED_PERMANENT event", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId, {
        status: PayrollEventStatus.FAILED_PERMANENT,
      });

      let providerCalls = 0;
      const processor = new EventProcessor(prisma, ordering, {
        gateway: {
          apply: async () => {
            providerCalls += 1;
            return {
              appliedAt: new Date().toISOString(),
              confirmationId: "nope",
              latencyMs: 1,
            };
          },
        },
      });

      await ordering.register(employeeId, eventId);
      const result = await processor.process(fakeJob(eventId, employeeId));

      expect(providerCalls).toBe(0);
      expect(result).toMatchObject({
        status: PayrollEventStatus.FAILED_PERMANENT,
        alreadyApplied: true,
      });
      // No history was appended by the no-op delivery.
      expect(
        await prisma.payrollEventHistory.count({ where: { eventId } }),
      ).toBe(0);
    });

    it("keeps the effect single across many sequential redeliveries", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);

      let providerCalls = 0;
      const processor = new EventProcessor(prisma, ordering, {
        gateway: {
          apply: async () => {
            providerCalls += 1;
            return {
              appliedAt: new Date().toISOString(),
              confirmationId: `pay_${providerCalls}`,
              latencyMs: 1,
            };
          },
        },
      });

      // Ten deliveries of the same event, as a flapping worker plus stalled
      // detection could produce. Only the first does any work.
      for (let i = 0; i < 10; i++) {
        await ordering.register(employeeId, eventId);
        await processor.process(fakeJob(eventId, employeeId));
      }

      expect(providerCalls).toBe(1);
      expect(
        await prisma.appliedOperation.count({ where: { eventId } }),
      ).toBe(1);
      expect(
        await prisma.payrollEventHistory.count({ where: { eventId } }),
      ).toBe(2);
    });
  });

  describe("atomicity of the success commit", () => {
    it("leaves no partial state when the transaction fails", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);

      // Force the commit to fail by deleting the event mid-flight, so the
      // update inside the transaction cannot find its row.
      const processor = new EventProcessor(prisma, ordering, {
        gateway: {
          apply: async () => {
            await prisma.payrollEvent.delete({ where: { id: eventId } });
            return {
              appliedAt: new Date().toISOString(),
              confirmationId: "pay_doomed",
              latencyMs: 1,
            };
          },
        },
      });

      await ordering.register(employeeId, eventId);
      await expect(
        processor.process(fakeJob(eventId, employeeId)),
      ).rejects.toBeDefined();

      // The ledger row is written in the SAME transaction as the status
      // change, so a failed commit must leave nothing behind.
      expect(
        await prisma.appliedOperation.count({ where: { eventId } }),
      ).toBe(0);
    });
  });

  describe("BullMQ stalled-job recovery", () => {
    it("redelivers a job whose worker died mid-processing", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId);

      const deliveries: string[] = [];

      // Worker A hangs forever, simulating a crashed process that never
      // renews its lock or acks the job.
      const crashingWorker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 1,
        lockDuration: 600,
        stalledInterval: 300,
        maxStalledCount: 3,
        gateway: {
          apply: async () => {
            deliveries.push("A");
            await new Promise(() => {}); // never resolves
            throw new Error("unreachable");
          },
        },
      });
      await crashingWorker.waitUntilReady();

      await producer.enqueue(eventId, employeeId);

      // Wait until A has the job.
      const deadline = Date.now() + 20000;
      while (deliveries.length === 0) {
        if (Date.now() > deadline) throw new Error("worker A never got the job");
        await new Promise((r) => setTimeout(r, 25));
      }

      // Hard-kill A without draining, exactly as a crash would.
      await crashingWorker.close(true);

      // Worker B should be handed the stalled job.
      const recoveringWorker = new PayrollWorker({
        redisUrl,
        prisma,
        concurrency: 1,
        lockDuration: 600,
        stalledInterval: 300,
        maxStalledCount: 3,
        gateway: {
          apply: async () => {
            deliveries.push("B");
            return {
              appliedAt: new Date().toISOString(),
              confirmationId: "pay_recovered_by_b",
              latencyMs: 1,
            };
          },
        },
      });
      await recoveringWorker.waitUntilReady();

      try {
        const statusDeadline = Date.now() + 30000;
        for (;;) {
          const row = await prisma.payrollEvent.findUniqueOrThrow({
            where: { id: eventId },
            select: { status: true },
          });
          if (row.status === PayrollEventStatus.SUCCEEDED) break;
          if (Date.now() > statusDeadline) {
            throw new Error(`stalled job never recovered; status ${row.status}`);
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        await recoveringWorker.close();
      }

      // The job was picked up by A, stalled, and completed by B.
      expect(deliveries).toContain("A");
      expect(deliveries).toContain("B");

      // Despite two deliveries, the effect applied exactly once.
      expect(
        await prisma.appliedOperation.count({ where: { eventId } }),
      ).toBe(1);
    });
  });

  describe("recovery sweep", () => {
    it("re-enqueues an event abandoned in PROCESSING", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId, {
        status: PayrollEventStatus.PROCESSING,
        // Stuck for 10 minutes.
        startedProcessingAt: new Date(Date.now() - 10 * 60_000),
        attemptCount: 1,
      });

      const logs: ProcessingLogFields[] = [];
      const sweep = new RecoverySweep(prisma, producer, ordering, {
        stuckTimeoutMs: 5 * 60_000,
        logger: new StructuredLogger({
          write: (line) => logs.push(JSON.parse(line)),
        }),
      });

      const result = await sweep.run();

      expect(result.scanned).toBe(1);
      expect(result.reEnqueued).toBe(1);
      expect(result.markedFailed).toBe(0);

      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      // Returned to PENDING so a worker will pick it up again.
      expect(row.status).toBe(PayrollEventStatus.PENDING);
      expect(row.startedProcessingAt).toBeNull();

      // The recovery is auditable.
      const history = await prisma.payrollEventHistory.findMany({
        where: { eventId },
      });
      expect(history[0].actor).toBe("recovery-sweep");
      expect(history[0].details).toMatchObject({
        reason: "stuck_in_processing",
      });

      // And a job really was queued.
      const job = await producer.getQueue().getJob(eventId);
      expect(job).toBeDefined();

      const log = logs.find((l) => l.event === "stuck_event_recovered");
      expect(log!.action).toBe("re_enqueued");
    });

    it("ignores events that are still within the timeout", async () => {
      const employeeId = newEmployee();
      await seedEvent(employeeId, {
        status: PayrollEventStatus.PROCESSING,
        startedProcessingAt: new Date(Date.now() - 30_000),
      });

      const sweep = new RecoverySweep(prisma, producer, ordering, {
        stuckTimeoutMs: 5 * 60_000,
      });

      expect((await sweep.run()).scanned).toBe(0);
    });

    it("ignores events in a terminal status", async () => {
      const employeeId = newEmployee();
      await seedEvent(employeeId, {
        status: PayrollEventStatus.SUCCEEDED,
        startedProcessingAt: new Date(Date.now() - 60 * 60_000),
      });

      const sweep = new RecoverySweep(prisma, producer, ordering, {
        stuckTimeoutMs: 5 * 60_000,
      });

      expect((await sweep.run()).scanned).toBe(0);
    });

    it("parks an event that has been recovered too many times", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId, {
        status: PayrollEventStatus.PROCESSING,
        startedProcessingAt: new Date(Date.now() - 10 * 60_000),
        // At the ceiling: a poison event that keeps killing its worker.
        attemptCount: RecoverySweep.MAX_RECOVERY_ATTEMPTS,
      });

      const sweep = new RecoverySweep(prisma, producer, ordering, {
        stuckTimeoutMs: 5 * 60_000,
      });

      const result = await sweep.run();
      expect(result.markedFailed).toBe(1);
      expect(result.reEnqueued).toBe(0);

      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      // Parked for a human rather than cycling forever.
      expect(row.status).toBe(PayrollEventStatus.FAILED_TEMPORARY);
      expect(row.lastError).toContain("abandoned in PROCESSING");
    });

    it("releases the dead worker's ordering lock so the retry can proceed", async () => {
      const employeeId = newEmployee();
      const eventId = await seedEvent(employeeId, {
        status: PayrollEventStatus.PROCESSING,
        startedProcessingAt: new Date(Date.now() - 10 * 60_000),
      });

      // Simulate the dead worker still holding the employee's lock.
      await ordering.register(employeeId, eventId);
      await ordering.acquire(employeeId, eventId);
      expect(await ordering.lockHolder(employeeId)).toBe(eventId);

      const sweep = new RecoverySweep(prisma, producer, ordering, {
        stuckTimeoutMs: 5 * 60_000,
      });
      await sweep.run();

      // Without this the re-enqueued job would defer forever, waiting on a
      // lock held by a process that no longer exists.
      expect(await ordering.lockHolder(employeeId)).toBeNull();
    });

    it("is safe to run repeatedly", async () => {
      const employeeId = newEmployee();
      await seedEvent(employeeId, {
        status: PayrollEventStatus.PROCESSING,
        startedProcessingAt: new Date(Date.now() - 10 * 60_000),
      });

      const sweep = new RecoverySweep(prisma, producer, ordering, {
        stuckTimeoutMs: 5 * 60_000,
      });

      expect((await sweep.run()).reEnqueued).toBe(1);
      // The row is PENDING now, so a second pass finds nothing — several
      // worker replicas sweeping concurrently is harmless.
      expect((await sweep.run()).scanned).toBe(0);
    });

    it("runs once on start and can be stopped", async () => {
      const employeeId = newEmployee();
      await seedEvent(employeeId, {
        status: PayrollEventStatus.PROCESSING,
        startedProcessingAt: new Date(Date.now() - 10 * 60_000),
      });

      const sweep = new RecoverySweep(prisma, producer, ordering, {
        stuckTimeoutMs: 5 * 60_000,
      });
      const scheduled = new ScheduledRecoverySweep(sweep, 60_000);

      try {
        // The startup pass catches events left behind by a previous crash.
        const first = await scheduled.start();
        expect(first.reEnqueued).toBe(1);
      } finally {
        scheduled.stop();
      }
    });
  });
});
