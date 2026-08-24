import { INestApplication } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { Test, TestingModule } from "@nestjs/testing";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";
import type { OpenAPIObject } from "@nestjs/swagger";
import { EventsController } from "../src/events/events.controller";
import { EventsService } from "../src/events/events.service";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  EVENT_QUEUE,
  EventQueueProducer,
  PayrollEventJobData,
} from "../src/queue/event-queue.constants";

class NoopQueue implements EventQueueProducer {
  async enqueueEvent(_data: PayrollEventJobData): Promise<void> {}

  /** Always healthy: these suites exercise the event path, not health. */
  async checkHealth() {
    return { configured: true, redis: true, queue: true };
  }
}

/**
 * The OpenAPI document is generated from decorators, so a wrong decorator
 * compiles cleanly and only shows up as broken docs. These assertions pin the
 * parts that are easy to get silently wrong — notably that the documented
 * status codes match what the controller actually returns.
 */
describe("OpenAPI document", () => {
  let app: INestApplication;
  let doc: OpenAPIObject;

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
    await app.init();

    doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("test").setVersion("0.1.0").build(),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it("documents all three event endpoints", () => {
    expect(Object.keys(doc.paths).sort()).toEqual(
      ["/events", "/events/{id}"].sort(),
    );
    expect(doc.paths["/events"].post).toBeDefined();
    expect(doc.paths["/events"].get).toBeDefined();
    expect(doc.paths["/events/{id}"].get).toBeDefined();
  });

  it("gives every operation a summary", () => {
    expect(doc.paths["/events"].post?.summary).toBeTruthy();
    expect(doc.paths["/events"].get?.summary).toBeTruthy();
    expect(doc.paths["/events/{id}"].get?.summary).toBeTruthy();
  });

  it("documents POST /events as 202/200/400 — not 201", () => {
    const responses = doc.paths["/events"].post!.responses;
    expect(Object.keys(responses).sort()).toEqual(["200", "202", "400"]);
    // 201 is the @ApiCreatedResponse default and would be wrong here: the
    // handler returns 202 for a new event and 200 for a duplicate.
    expect(responses["201"]).toBeUndefined();
  });

  it("documents GET /events/{id} with a 404", () => {
    const responses = doc.paths["/events/{id}"].get!.responses;
    expect(Object.keys(responses).sort()).toEqual(["200", "400", "404"]);
  });

  it("documents the payload as a oneOf over the three payload schemas", () => {
    const payload = (
      doc.components!.schemas!.CreateEventDto as {
        properties: Record<string, { oneOf?: { $ref: string }[] }>;
      }
    ).properties.payload;

    expect(payload.oneOf).toHaveLength(3);
    const refs = payload.oneOf!.map((s) => s.$ref);
    for (const name of [
      "BankAccountChangePayloadDto",
      "AddressChangePayloadDto",
      "SalaryChangePayloadDto",
    ]) {
      expect(refs).toContain(`#/components/schemas/${name}`);
    }
  });

  it("registers every schema a $ref points at", () => {
    // A $ref to an unregistered schema renders as a broken node in the UI.
    const defined = new Set(Object.keys(doc.components?.schemas ?? {}));
    const referenced = new Set<string>();
    JSON.stringify(doc, (_key, value) => {
      if (typeof value === "string" && value.startsWith("#/components/schemas/")) {
        referenced.add(value.replace("#/components/schemas/", ""));
      }
      return value;
    });

    const dangling = [...referenced].filter((name) => !defined.has(name));
    expect(dangling).toEqual([]);
  });

  it("exposes the filter enums on the list endpoint", () => {
    const params = (doc.paths["/events"].get!.parameters ?? []) as {
      name: string;
      schema?: { enum?: string[] };
    }[];
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));

    expect(Object.keys(byName).sort()).toEqual(
      ["employeeId", "eventType", "page", "pageSize", "status"].sort(),
    );
    expect(byName.status.schema?.enum).toEqual(
      Object.values(PayrollEventStatus),
    );
    expect(byName.eventType.schema?.enum).toEqual(
      Object.values(PayrollEventType),
    );
  });

  it("documents the optional Idempotency-Key header on POST", () => {
    const params = (doc.paths["/events"].post!.parameters ?? []) as {
      name: string;
      in: string;
      required?: boolean;
    }[];
    const header = params.find((p) => p.name === "Idempotency-Key");

    expect(header).toBeDefined();
    expect(header!.in).toBe("header");
    expect(header!.required).toBe(false);
  });
});
