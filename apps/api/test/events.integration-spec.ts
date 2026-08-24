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

/**
 * Records enqueue calls so tests can assert that a duplicate submission does
 * not produce a second job, without needing a live Redis.
 */
class RecordingQueue implements EventQueueProducer {
  readonly jobs: PayrollEventJobData[] = [];
  shouldThrow = false;

  async enqueueEvent(data: PayrollEventJobData): Promise<void> {
    if (this.shouldThrow) throw new Error("redis unavailable");
    this.jobs.push(data);
  }

  /** Always healthy: these suites exercise the event path, not health. */
  async checkHealth() {
    return { configured: true, redis: true, queue: true };
  }
}

const VALID_IBAN = "DE89370400440532013000";

describe("[integration] POST /events", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: RecordingQueue;
  const createdEmployeeIds: string[] = [];

  beforeAll(async () => {
    queue = new RecordingQueue();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        EventsService,
        PrismaService,
        { provide: EVENT_QUEUE, useValue: queue },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(buildValidationPipe());
    await app.init();

    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    // Cascades to history + applied_operations via the FK.
    if (createdEmployeeIds.length) {
      await prisma.payrollEvent.deleteMany({
        where: { employeeId: { in: createdEmployeeIds } },
      });
    }
    await app.close();
  });

  beforeEach(() => {
    queue.jobs.length = 0;
    queue.shouldThrow = false;
  });

  function newEmployeeId(): string {
    const id = randomUUID();
    createdEmployeeIds.push(id);
    return id;
  }

  function bankAccountBody(employeeId: string) {
    return {
      eventType: PayrollEventType.BANK_ACCOUNT_CHANGE,
      employeeId,
      effectiveDate: "2026-09-01",
      payload: { iban: VALID_IBAN },
    };
  }

  describe("valid submission", () => {
    it("returns 202 with the event id and PENDING status", async () => {
      const employeeId = newEmployeeId();

      const res = await request(app.getHttpServer())
        .post("/events")
        .send(bankAccountBody(employeeId))
        .expect(202);

      expect(res.body).toMatchObject({
        status: PayrollEventStatus.PENDING,
        duplicate: false,
      });
      expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("persists the event with a PENDING status and the payload intact", async () => {
      const employeeId = newEmployeeId();

      const res = await request(app.getHttpServer())
        .post("/events")
        .send(bankAccountBody(employeeId))
        .expect(202);

      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: res.body.id },
      });

      expect(row.status).toBe(PayrollEventStatus.PENDING);
      expect(row.employeeId).toBe(employeeId);
      expect(row.eventType).toBe(PayrollEventType.BANK_ACCOUNT_CHANGE);
      expect(row.payload).toEqual({ iban: VALID_IBAN });
      expect(row.startedProcessingAt).toBeNull();
      expect(row.completedAt).toBeNull();
    });

    it("writes the opening audit-log entry", async () => {
      const employeeId = newEmployeeId();

      const res = await request(app.getHttpServer())
        .post("/events")
        .send(bankAccountBody(employeeId))
        .expect(202);

      const history = await prisma.payrollEventHistory.findMany({
        where: { eventId: res.body.id },
      });

      expect(history).toHaveLength(1);
      expect(history[0].previousStatus).toBeNull();
      expect(history[0].newStatus).toBe(PayrollEventStatus.PENDING);
      expect(history[0].actor).toBe("api");
    });

    it("enqueues exactly one job", async () => {
      const employeeId = newEmployeeId();

      const res = await request(app.getHttpServer())
        .post("/events")
        .send(bankAccountBody(employeeId))
        .expect(202);

      // employeeId travels with the job as the per-employee ordering key.
      expect(queue.jobs).toEqual([{ eventId: res.body.id, employeeId }]);
    });

    it("accepts the other event types", async () => {
      const addressRes = await request(app.getHttpServer())
        .post("/events")
        .send({
          eventType: PayrollEventType.ADDRESS_CHANGE,
          employeeId: newEmployeeId(),
          effectiveDate: "2026-09-01",
          payload: {
            street: "Hauptstrasse 1",
            city: "Berlin",
            postalCode: "10115",
            country: "DE",
          },
        })
        .expect(202);
      expect(addressRes.body.status).toBe(PayrollEventStatus.PENDING);

      const salaryRes = await request(app.getHttpServer())
        .post("/events")
        .send({
          eventType: PayrollEventType.SALARY_CHANGE,
          employeeId: newEmployeeId(),
          effectiveDate: "2026-09-01",
          payload: { newSalary: 7500000, currency: "EUR" },
        })
        .expect(202);
      expect(salaryRes.body.status).toBe(PayrollEventStatus.PENDING);
    });

    it("still returns 202 when the enqueue fails, leaving the row recoverable", async () => {
      const employeeId = newEmployeeId();
      queue.shouldThrow = true;

      const res = await request(app.getHttpServer())
        .post("/events")
        .send(bankAccountBody(employeeId))
        .expect(202);

      const row = await prisma.payrollEvent.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.status).toBe(PayrollEventStatus.PENDING);
    });
  });

  describe("invalid submission", () => {
    it("returns 400 with details for a missing required payload field", async () => {
      const res = await request(app.getHttpServer())
        .post("/events")
        .send({
          eventType: PayrollEventType.BANK_ACCOUNT_CHANGE,
          employeeId: randomUUID(),
          effectiveDate: "2026-09-01",
          payload: {},
        })
        .expect(400);

      expect(res.body.message).toBe("Validation failed");
      expect(res.body.details.join(" ")).toMatch(/iban/i);
    });

    it("returns 400 for an unknown eventType", async () => {
      const res = await request(app.getHttpServer())
        .post("/events")
        .send({
          eventType: "PROMOTION",
          employeeId: randomUUID(),
          effectiveDate: "2026-09-01",
          payload: { iban: VALID_IBAN },
        })
        .expect(400);

      expect(res.body.details.join(" ")).toMatch(/eventType/i);
    });

    it("returns 400 when the payload belongs to a different event type", async () => {
      const res = await request(app.getHttpServer())
        .post("/events")
        .send({
          eventType: PayrollEventType.SALARY_CHANGE,
          employeeId: randomUUID(),
          effectiveDate: "2026-09-01",
          payload: { iban: VALID_IBAN },
        })
        .expect(400);

      expect(res.body.details.join(" ")).toMatch(/payload/i);
    });

    it.each([
      ["a non-UUID employeeId", { employeeId: "employee-1" }],
      ["a malformed effectiveDate", { effectiveDate: "01/09/2026" }],
      ["an impossible date", { effectiveDate: "2026-02-30" }],
    ])("returns 400 for %s", async (_label, override) => {
      await request(app.getHttpServer())
        .post("/events")
        .send({ ...bankAccountBody(randomUUID()), ...override })
        .expect(400);
    });

    it("persists nothing for a rejected submission", async () => {
      const employeeId = randomUUID();

      await request(app.getHttpServer())
        .post("/events")
        .send({
          eventType: PayrollEventType.BANK_ACCOUNT_CHANGE,
          employeeId,
          effectiveDate: "2026-09-01",
          payload: { iban: "NOT-AN-IBAN" },
        })
        .expect(400);

      expect(await prisma.payrollEvent.count({ where: { employeeId } })).toBe(0);
      expect(queue.jobs).toHaveLength(0);
    });
  });

  describe("idempotency", () => {
    it("returns the existing event and creates no duplicate row (client key)", async () => {
      const employeeId = newEmployeeId();
      const key = `client-${randomUUID()}`;
      const body = bankAccountBody(employeeId);

      const first = await request(app.getHttpServer())
        .post("/events")
        .set("Idempotency-Key", key)
        .send(body)
        .expect(202);
      expect(first.body.duplicate).toBe(false);

      const second = await request(app.getHttpServer())
        .post("/events")
        .set("Idempotency-Key", key)
        .send(body)
        .expect(200);

      expect(second.body.duplicate).toBe(true);
      expect(second.body.id).toBe(first.body.id);

      // The row count is the real assertion: exactly one event exists.
      expect(await prisma.payrollEvent.count({ where: { employeeId } })).toBe(1);
      // And the retry must NOT have produced a second job.
      expect(queue.jobs).toEqual([{ eventId: first.body.id, employeeId }]);
    });

    it("dedups on the derived key when no header is supplied", async () => {
      const employeeId = newEmployeeId();
      const body = bankAccountBody(employeeId);

      const first = await request(app.getHttpServer())
        .post("/events")
        .send(body)
        .expect(202);

      const second = await request(app.getHttpServer())
        .post("/events")
        .send(body)
        .expect(200);

      expect(second.body.id).toBe(first.body.id);
      expect(await prisma.payrollEvent.count({ where: { employeeId } })).toBe(1);
      expect(queue.jobs).toHaveLength(1);
    });

    it("treats a changed payload as a distinct event when deriving the key", async () => {
      const employeeId = newEmployeeId();

      await request(app.getHttpServer())
        .post("/events")
        .send({
          eventType: PayrollEventType.SALARY_CHANGE,
          employeeId,
          effectiveDate: "2026-09-01",
          payload: { newSalary: 7500000, currency: "EUR" },
        })
        .expect(202);

      await request(app.getHttpServer())
        .post("/events")
        .send({
          eventType: PayrollEventType.SALARY_CHANGE,
          employeeId,
          effectiveDate: "2026-09-01",
          payload: { newSalary: 8000000, currency: "EUR" },
        })
        .expect(202);

      expect(await prisma.payrollEvent.count({ where: { employeeId } })).toBe(2);
      expect(queue.jobs).toHaveLength(2);
    });

    it("derives the same key regardless of payload key order", async () => {
      const employeeId = newEmployeeId();

      const first = await request(app.getHttpServer())
        .post("/events")
        .send({
          eventType: PayrollEventType.SALARY_CHANGE,
          employeeId,
          effectiveDate: "2026-09-01",
          payload: { newSalary: 7500000, currency: "EUR" },
        })
        .expect(202);

      const second = await request(app.getHttpServer())
        .post("/events")
        .send({
          eventType: PayrollEventType.SALARY_CHANGE,
          employeeId,
          effectiveDate: "2026-09-01",
          payload: { currency: "EUR", newSalary: 7500000 },
        })
        .expect(200);

      expect(second.body.id).toBe(first.body.id);
      expect(await prisma.payrollEvent.count({ where: { employeeId } })).toBe(1);
    });

    it("survives concurrent identical submissions without duplicating", async () => {
      const employeeId = newEmployeeId();
      const key = `client-${randomUUID()}`;
      const body = bankAccountBody(employeeId);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer())
            .post("/events")
            .set("Idempotency-Key", key)
            .send(body),
        ),
      );

      // Every response must succeed and point at the same event.
      const ids = new Set(responses.map((r) => r.body.id));
      expect(ids.size).toBe(1);
      for (const r of responses) expect([200, 202]).toContain(r.status);

      // Exactly one row, and exactly one 202 (the winner of the race).
      expect(await prisma.payrollEvent.count({ where: { employeeId } })).toBe(1);
      expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
    });

    it("rejects an over-long Idempotency-Key rather than truncating it", async () => {
      await request(app.getHttpServer())
        .post("/events")
        .set("Idempotency-Key", "x".repeat(256))
        .send(bankAccountBody(randomUUID()))
        .expect(400);
    });
  });
});
