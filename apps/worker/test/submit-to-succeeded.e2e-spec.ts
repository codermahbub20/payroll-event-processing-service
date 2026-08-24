import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaClient } from "@payroll/database";
import { createRedisConnection } from "@payroll/queue";
import type { Redis } from "@payroll/queue";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";
import { randomUUID } from "node:crypto";
import { startRedis, type RedisFixture } from "./redis-fixture";
import request from "supertest";
import { buildValidationPipe } from "../../api/src/common/validation";
import { EventsController } from "../../api/src/events/events.controller";
import { EventsService } from "../../api/src/events/events.service";
import { PrismaService } from "../../api/src/prisma/prisma.service";
import { BullEventQueue } from "../../api/src/queue/bull-event-queue";
import { EVENT_QUEUE } from "../../api/src/queue/event-queue.constants";
import { PayrollWorker } from "../src/processor/payroll-worker";

/**
 * TRUE END-TO-END: the full chain, no shortcuts.
 *
 *   HTTP POST /events  ->  API validates + persists + enqueues
 *                      ->  real BullMQ over real Redis
 *                      ->  real worker consumes and calls the provider
 *                      ->  status becomes SUCCEEDED in real Postgres
 *                      ->  HTTP GET /events/:id observes it
 *
 * Every other suite stubs one side of that boundary: the API tests inject a
 * recording queue, and the worker tests call the producer directly. This is
 * the only test that proves the two halves actually agree in production —
 * queue name, job payload shape, enum values and status transitions all have
 * to line up for it to pass.
 *
 * It uses the REAL BullEventQueue (not a stub), so a mismatch between what the
 * API enqueues and what the worker expects fails here rather than in staging.
 */
describe("[e2e] submit via API -> worker processes -> SUCCEEDED", () => {
  let redisFixture: RedisFixture;
  let redisUrl: string;
  let app: INestApplication;
  let worker: PayrollWorker;
  let prisma: PrismaClient;
  let apiQueue: BullEventQueue;
  let connection: Redis;

  const employees: string[] = [];

  const DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://payroll:payroll@localhost:55432/payroll";

  beforeAll(async () => {
    redisFixture = await startRedis();
    redisUrl = redisFixture.url;

    prisma = new PrismaClient({
      datasources: { db: { url: DATABASE_URL } },
    });
    await prisma.$connect();

    connection = createRedisConnection(redisUrl);

    // The real producer the API uses in production — not a test double.
    apiQueue = new BullEventQueue(redisUrl);

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        EventsService,
        PrismaService,
        { provide: EVENT_QUEUE, useValue: apiQueue },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(buildValidationPipe());
    await app.init();

    // Deterministic provider: this test is about the pipeline wiring, not the
    // retry logic (covered in retry-behaviour.integration-spec.ts).
    worker = new PayrollWorker({
      redisUrl,
      prisma,
      concurrency: 5,
      gateway: {
        apply: async () => ({
          appliedAt: new Date().toISOString(),
          confirmationId: `pay_e2e_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          latencyMs: 5,
        }),
      },
    });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    // app.close() runs Nest's lifecycle hooks, which includes
    // BullEventQueue.onModuleDestroy — calling it again here would throw
    // "Connection is closed".
    await app.close();

    if (employees.length) {
      await prisma.payrollEvent.deleteMany({
        where: { employeeId: { in: employees } },
      });
    }
    await connection.quit();
    await prisma.$disconnect();
    await redisFixture.stop();
  });

  function newEmployee(): string {
    const id = randomUUID();
    employees.push(id);
    return id;
  }

  /** Polls the HTTP detail endpoint until the event reaches a terminal status. */
  async function waitForTerminal(
    eventId: string,
    timeoutMs = 30000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const res = await request(app.getHttpServer()).get(`/events/${eventId}`);
      const body = res.body as { status: PayrollEventStatus };

      if (
        body.status === PayrollEventStatus.SUCCEEDED ||
        body.status === PayrollEventStatus.FAILED_PERMANENT ||
        body.status === PayrollEventStatus.FAILED_TEMPORARY
      ) {
        return res.body as Record<string, unknown>;
      }

      if (Date.now() > deadline) {
        throw new Error(
          `event ${eventId} never reached a terminal status (last: ${body.status})`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("carries a BANK_ACCOUNT_CHANGE from HTTP submission to SUCCEEDED", async () => {
    const employeeId = newEmployee();

    // 1. Submit over HTTP, exactly as a client would.
    const submitted = await request(app.getHttpServer())
      .post("/events")
      .send({
        eventType: PayrollEventType.BANK_ACCOUNT_CHANGE,
        employeeId,
        effectiveDate: "2026-09-01",
        payload: { iban: "DE89370400440532013000" },
      })
      .expect(202);

    expect(submitted.body.status).toBe(PayrollEventStatus.PENDING);
    const eventId = submitted.body.id as string;

    // 2. The worker picks it up off the real queue and processes it.
    const detail = await waitForTerminal(eventId);

    // 3. It ends SUCCEEDED, observed through the public API.
    expect(detail.status).toBe(PayrollEventStatus.SUCCEEDED);
    expect(detail.startedProcessingAt).not.toBeNull();
    expect(detail.completedAt).not.toBeNull();
    expect(detail.lastError).toBeNull();

    // 4. The provider's result is persisted and surfaced.
    const result = detail.result as { details: Record<string, unknown> } | null;
    expect(result).not.toBeNull();
    expect(String(result!.details.confirmationId)).toMatch(/^pay_e2e_/);

    // 5. The audit trail records the full lifecycle.
    const history = detail.history as { newStatus: string }[];
    expect(history.map((h) => h.newStatus)).toEqual([
      PayrollEventStatus.PENDING,
      PayrollEventStatus.PROCESSING,
      PayrollEventStatus.SUCCEEDED,
    ]);

    // 6. The business effect was ledgered exactly once.
    expect(
      await prisma.appliedOperation.count({ where: { eventId } }),
    ).toBe(1);
  });

  it.each([
    [
      PayrollEventType.ADDRESS_CHANGE,
      {
        street: "Hauptstrasse 1",
        city: "Berlin",
        postalCode: "10115",
        country: "DE",
      },
    ],
    [PayrollEventType.SALARY_CHANGE, { newSalary: 7500000, currency: "EUR" }],
  ])("carries a %s through the same chain", async (eventType, payload) => {
    const employeeId = newEmployee();

    const submitted = await request(app.getHttpServer())
      .post("/events")
      .send({
        eventType,
        employeeId,
        effectiveDate: "2026-10-01",
        payload,
      })
      .expect(202);

    const detail = await waitForTerminal(submitted.body.id as string);

    expect(detail.status).toBe(PayrollEventStatus.SUCCEEDED);
    // The payload survives the round trip through jsonb unchanged.
    expect(detail.payload).toEqual(payload);
  });

  it("appears in the list endpoint with its final status", async () => {
    const employeeId = newEmployee();

    const submitted = await request(app.getHttpServer())
      .post("/events")
      .send({
        eventType: PayrollEventType.SALARY_CHANGE,
        employeeId,
        effectiveDate: "2026-11-01",
        payload: { newSalary: 6000000, currency: "EUR" },
      })
      .expect(202);

    await waitForTerminal(submitted.body.id as string);

    const listed = await request(app.getHttpServer())
      .get("/events")
      .query({ employeeId, status: PayrollEventStatus.SUCCEEDED })
      .expect(200);

    expect(listed.body.meta.total).toBe(1);
    expect(listed.body.data[0].id).toBe(submitted.body.id);
  });

  it("processes a duplicate submission once, end to end", async () => {
    const employeeId = newEmployee();
    const key = `e2e-${randomUUID()}`;
    const body = {
      eventType: PayrollEventType.SALARY_CHANGE,
      employeeId,
      effectiveDate: "2026-12-01",
      payload: { newSalary: 8500000, currency: "EUR" },
    };

    const first = await request(app.getHttpServer())
      .post("/events")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(202);

    const second = await request(app.getHttpServer())
      .post("/events")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.duplicate).toBe(true);

    await waitForTerminal(first.body.id as string);

    // The whole point: one row, one queue job, one business operation — even
    // though the client submitted twice.
    expect(await prisma.payrollEvent.count({ where: { employeeId } })).toBe(1);
    expect(
      await prisma.appliedOperation.count({
        where: { eventId: first.body.id as string },
      }),
    ).toBe(1);
  });

  it("keeps same-employee events in submission order through the real pipeline", async () => {
    const employeeId = newEmployee();
    const submittedIds: string[] = [];

    // Three events for ONE employee, submitted over HTTP back to back.
    for (const amount of [1000000, 2000000, 3000000]) {
      const res = await request(app.getHttpServer())
        .post("/events")
        .send({
          eventType: PayrollEventType.SALARY_CHANGE,
          employeeId,
          effectiveDate: "2026-12-01",
          payload: { newSalary: amount, currency: "EUR" },
        })
        .expect(202);
      submittedIds.push(res.body.id as string);
    }

    for (const id of submittedIds) await waitForTerminal(id);

    const rows = await prisma.payrollEvent.findMany({
      where: { employeeId },
      orderBy: { createdAt: "asc" },
      select: { id: true, startedProcessingAt: true, completedAt: true },
    });

    expect(rows.map((r) => r.id)).toEqual(submittedIds);

    // Each event must have finished before the next one started — the
    // per-employee ordering guarantee, observed end to end rather than
    // through the ordering primitives directly.
    for (let i = 1; i < rows.length; i++) {
      const previousDone = rows[i - 1].completedAt!.getTime();
      const currentStart = rows[i].startedProcessingAt!.getTime();
      expect(currentStart).toBeGreaterThanOrEqual(previousDone);
    }
  });
});
