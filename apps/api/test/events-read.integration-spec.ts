import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { buildValidationPipe } from "../src/common/validation";
import { EventsController } from "../src/events/events.controller";
import { EventsService } from "../src/events/events.service";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  EVENT_QUEUE,
  EventQueueProducer,
  PayrollEventJobData,
} from "../src/queue/event-queue.constants";

class NoopQueue implements EventQueueProducer {
  async enqueueEvent(_data: PayrollEventJobData): Promise<void> {
    /* no broker needed for read-path tests */
  }

  /** Always healthy: these suites exercise the event path, not health. */
  async checkHealth() {
    return { configured: true, redis: true, queue: true };
  }
}

describe("[integration] GET /events and GET /events/:id", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // Two employees so employeeId filtering is provably scoped.
  const employeeA = randomUUID();
  const employeeB = randomUUID();
  const employeeIds = [employeeA, employeeB];

  // Populated in beforeAll; referenced across the detail tests.
  let pendingEventId: string;
  let failedEventId: string;
  let succeededEventId: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        EventsService,
        PrismaService,
        { provide: EVENT_QUEUE, useValue: new NoopQueue() },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(buildValidationPipe());
    await app.init();
    prisma = moduleRef.get(PrismaService);

    // Clear any residue from a previous run so counts are deterministic.
    await prisma.payrollEvent.deleteMany({
      where: { employeeId: { in: employeeIds } },
    });

    // --- Seed a known fixture set -----------------------------------------
    // Employee A: one PENDING bank change.
    const pending = await prisma.payrollEvent.create({
      data: {
        eventType: PayrollEventType.BANK_ACCOUNT_CHANGE,
        employeeId: employeeA,
        effectiveDate: new Date("2026-09-01"),
        payload: { iban: "DE89370400440532013000" },
        idempotencyKey: `t-pending-${randomUUID()}`,
        status: PayrollEventStatus.PENDING,
        history: {
          create: {
            previousStatus: null,
            newStatus: PayrollEventStatus.PENDING,
            actor: "api",
          },
        },
      },
    });
    pendingEventId = pending.id;

    // Employee A: one FAILED_TEMPORARY salary change that failed TWICE, so the
    // detail endpoint can be checked to surface the LATEST failure.
    const failed = await prisma.payrollEvent.create({
      data: {
        eventType: PayrollEventType.SALARY_CHANGE,
        employeeId: employeeA,
        effectiveDate: new Date("2026-10-01"),
        payload: { newSalary: 8000000, currency: "EUR" },
        idempotencyKey: `t-failed-${randomUUID()}`,
        status: PayrollEventStatus.FAILED_TEMPORARY,
        attemptCount: 2,
        lastError: "downstream 503 (attempt 2)",
        startedProcessingAt: new Date("2026-08-24T10:00:00Z"),
        nextAttemptAt: new Date("2026-08-24T10:05:00Z"),
      },
    });
    failedEventId = failed.id;

    // Written sequentially so created_at ordering is unambiguous.
    for (const entry of [
      {
        previousStatus: null,
        newStatus: PayrollEventStatus.PENDING,
        actor: "api",
        details: undefined,
      },
      {
        previousStatus: PayrollEventStatus.PENDING,
        newStatus: PayrollEventStatus.PROCESSING,
        actor: "worker:1",
        details: undefined,
      },
      {
        previousStatus: PayrollEventStatus.PROCESSING,
        newStatus: PayrollEventStatus.FAILED_TEMPORARY,
        actor: "worker:1",
        details: { error: "downstream 503 (attempt 1)", attempt: 1 },
      },
      {
        previousStatus: PayrollEventStatus.FAILED_TEMPORARY,
        newStatus: PayrollEventStatus.PROCESSING,
        actor: "worker:2",
        details: undefined,
      },
      {
        previousStatus: PayrollEventStatus.PROCESSING,
        newStatus: PayrollEventStatus.FAILED_TEMPORARY,
        actor: "worker:2",
        details: { error: "downstream 503 (attempt 2)", attempt: 2 },
      },
    ]) {
      await prisma.payrollEventHistory.create({
        data: { eventId: failed.id, ...entry },
      });
    }

    // Employee B: one SUCCEEDED address change.
    const succeeded = await prisma.payrollEvent.create({
      data: {
        eventType: PayrollEventType.ADDRESS_CHANGE,
        employeeId: employeeB,
        effectiveDate: new Date("2026-11-01"),
        payload: {
          street: "Hauptstrasse 1",
          city: "Berlin",
          postalCode: "10115",
          country: "DE",
        },
        idempotencyKey: `t-ok-${randomUUID()}`,
        status: PayrollEventStatus.SUCCEEDED,
        attemptCount: 1,
        startedProcessingAt: new Date("2026-08-24T09:00:00Z"),
        completedAt: new Date("2026-08-24T09:00:05Z"),
      },
    });
    succeededEventId = succeeded.id;

    for (const entry of [
      {
        previousStatus: null,
        newStatus: PayrollEventStatus.PENDING,
        actor: "api",
        details: undefined,
      },
      {
        previousStatus: PayrollEventStatus.PENDING,
        newStatus: PayrollEventStatus.PROCESSING,
        actor: "worker:1",
        details: undefined,
      },
      {
        previousStatus: PayrollEventStatus.PROCESSING,
        newStatus: PayrollEventStatus.SUCCEEDED,
        actor: "worker:1",
        details: { providerRef: "ref-abc-123" },
      },
    ]) {
      await prisma.payrollEventHistory.create({
        data: { eventId: succeeded.id, ...entry },
      });
    }
  });

  afterAll(async () => {
    await prisma.payrollEvent.deleteMany({
      where: { employeeId: { in: employeeIds } },
    });
    await app.close();
  });

  describe("GET /events/:id", () => {
    it("returns the full detail shape for a PENDING event", async () => {
      const res = await request(app.getHttpServer())
        .get(`/events/${pendingEventId}`)
        .expect(200);

      expect(res.body).toMatchObject({
        id: pendingEventId,
        eventType: PayrollEventType.BANK_ACCOUNT_CHANGE,
        employeeId: employeeA,
        status: PayrollEventStatus.PENDING,
        payload: { iban: "DE89370400440532013000" },
        startedProcessingAt: null,
        completedAt: null,
        attemptCount: 0,
      });

      // Never-failed, never-succeeded event: both derived fields are null.
      expect(res.body.failure).toBeNull();
      expect(res.body.result).toBeNull();
      expect(res.body.lastError).toBeNull();
    });

    it("serialises effectiveDate as a calendar date, not a timestamp", async () => {
      const res = await request(app.getHttpServer())
        .get(`/events/${pendingEventId}`)
        .expect(200);

      // A full ISO timestamp here would let a client west of UTC render the
      // previous day — the exact drift the `date` column type avoids.
      expect(res.body.effectiveDate).toBe("2026-09-01");
    });

    it("exposes ISO-8601 timestamps", async () => {
      const res = await request(app.getHttpServer())
        .get(`/events/${succeededEventId}`)
        .expect(200);

      expect(res.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(res.body.startedProcessingAt).toBe("2026-08-24T09:00:00.000Z");
      expect(res.body.completedAt).toBe("2026-08-24T09:00:05.000Z");
    });

    it("returns the full transition timeline, oldest first", async () => {
      const res = await request(app.getHttpServer())
        .get(`/events/${failedEventId}`)
        .expect(200);

      expect(res.body.history).toHaveLength(5);
      expect(res.body.history.map((h: { newStatus: string }) => h.newStatus)).toEqual([
        PayrollEventStatus.PENDING,
        PayrollEventStatus.PROCESSING,
        PayrollEventStatus.FAILED_TEMPORARY,
        PayrollEventStatus.PROCESSING,
        PayrollEventStatus.FAILED_TEMPORARY,
      ]);
      expect(res.body.history[0].previousStatus).toBeNull();
      expect(res.body.history[0].actor).toBe("api");
    });

    it("surfaces the LATEST failure, not the first", async () => {
      const res = await request(app.getHttpServer())
        .get(`/events/${failedEventId}`)
        .expect(200);

      expect(res.body.failure).toMatchObject({
        newStatus: PayrollEventStatus.FAILED_TEMPORARY,
        actor: "worker:2",
        details: { error: "downstream 503 (attempt 2)", attempt: 2 },
      });
      expect(res.body.lastError).toBe("downstream 503 (attempt 2)");
      expect(res.body.nextAttemptAt).toBe("2026-08-24T10:05:00.000Z");
      // Never succeeded.
      expect(res.body.result).toBeNull();
    });

    it("surfaces the success result for a SUCCEEDED event", async () => {
      const res = await request(app.getHttpServer())
        .get(`/events/${succeededEventId}`)
        .expect(200);

      expect(res.body.status).toBe(PayrollEventStatus.SUCCEEDED);
      expect(res.body.result).toMatchObject({
        newStatus: PayrollEventStatus.SUCCEEDED,
        details: { providerRef: "ref-abc-123" },
      });
      expect(res.body.failure).toBeNull();
    });

    it("returns 404 with a clear body for an unknown id", async () => {
      const unknownId = randomUUID();

      const res = await request(app.getHttpServer())
        .get(`/events/${unknownId}`)
        .expect(404);

      expect(res.body).toMatchObject({
        statusCode: 404,
        error: "Not Found",
      });
      expect(res.body.message).toContain(unknownId);
    });

    it("returns 400 for a malformed (non-UUID) id", async () => {
      const res = await request(app.getHttpServer())
        .get("/events/not-a-uuid")
        .expect(400);

      // Same body shape as every other 400, so clients parse one error format.
      expect(res.body).toMatchObject({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
      });
      expect(res.body.details).toEqual(["id: id must be a valid UUID"]);
    });
  });

  describe("GET /events", () => {
    it("returns a page envelope with data and meta", async () => {
      const res = await request(app.getHttpServer())
        .get("/events")
        .query({ employeeId: employeeA })
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toMatchObject({
        page: 1,
        pageSize: 20,
        total: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });

    it("filters by employeeId", async () => {
      const res = await request(app.getHttpServer())
        .get("/events")
        .query({ employeeId: employeeB })
        .expect(200);

      expect(res.body.meta.total).toBe(1);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(succeededEventId);
      expect(res.body.data[0].employeeId).toBe(employeeB);
    });

    it("filters by status", async () => {
      const res = await request(app.getHttpServer())
        .get("/events")
        .query({ employeeId: employeeA, status: PayrollEventStatus.PENDING })
        .expect(200);

      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].id).toBe(pendingEventId);
      expect(res.body.data[0].status).toBe(PayrollEventStatus.PENDING);
    });

    it("combines employeeId and status with AND", async () => {
      // employeeB has a SUCCEEDED event, but not a PENDING one.
      const res = await request(app.getHttpServer())
        .get("/events")
        .query({ employeeId: employeeB, status: PayrollEventStatus.PENDING })
        .expect(200);

      expect(res.body.meta.total).toBe(0);
      expect(res.body.data).toEqual([]);
    });

    it("filters by eventType", async () => {
      const res = await request(app.getHttpServer())
        .get("/events")
        .query({
          employeeId: employeeA,
          eventType: PayrollEventType.SALARY_CHANGE,
        })
        .expect(200);

      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].id).toBe(failedEventId);
    });

    it("returns events newest first", async () => {
      const res = await request(app.getHttpServer())
        .get("/events")
        .query({ employeeId: employeeA })
        .expect(200);

      const timestamps = res.body.data.map((e: { createdAt: string }) =>
        Date.parse(e.createdAt),
      );
      expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
    });

    it("paginates", async () => {
      const first = await request(app.getHttpServer())
        .get("/events")
        .query({ employeeId: employeeA, page: 1, pageSize: 1 })
        .expect(200);

      expect(first.body.data).toHaveLength(1);
      expect(first.body.meta).toMatchObject({
        page: 1,
        pageSize: 1,
        total: 2,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });

      const second = await request(app.getHttpServer())
        .get("/events")
        .query({ employeeId: employeeA, page: 2, pageSize: 1 })
        .expect(200);

      expect(second.body.meta).toMatchObject({
        page: 2,
        hasNextPage: false,
        hasPreviousPage: true,
      });
      // The two pages must not overlap.
      expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    });

    it("omits the payload from list rows to keep the response lean", async () => {
      const res = await request(app.getHttpServer())
        .get("/events")
        .query({ employeeId: employeeA })
        .expect(200);

      expect(res.body.data[0]).not.toHaveProperty("payload");
      expect(res.body.data[0]).toHaveProperty("status");
    });

    it.each([
      ["a non-UUID employeeId", { employeeId: "nope" }],
      ["an unknown status", { status: "ARCHIVED" }],
      ["an unknown eventType", { eventType: "PROMOTION" }],
      ["page below 1", { page: 0 }],
      ["a non-integer page", { page: 1.5 }],
      ["pageSize above the cap", { pageSize: 101 }],
    ])("returns 400 for %s", async (_label, query) => {
      await request(app.getHttpServer())
        .get("/events")
        .query(query)
        .expect(400);
    });

    it("rejects unknown query parameters", async () => {
      await request(app.getHttpServer())
        .get("/events")
        .query({ employeeId: employeeA, sortBy: "status" })
        .expect(400);
    });
  });
});
