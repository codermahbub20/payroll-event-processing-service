import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  INestApplication,
  NotFoundException,
  Param,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { StructuredLogger } from "@payroll/shared";
import request from "supertest";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { buildValidationPipe } from "../src/common/validation";

/** Routes that throw each class of error the filter must normalise. */
@Controller("boom")
class BoomController {
  @Get("unhandled")
  unhandled(): never {
    // A leaky message: it names an internal host and credentials-shaped text.
    throw new Error(
      "connect ECONNREFUSED postgres://payroll:hunter2@10.0.0.5:5432",
    );
  }

  @Get("http")
  http(): never {
    throw new NotFoundException("Event abc-123 not found");
  }

  @Get("structured")
  structured(): never {
    throw new BadRequestException({
      statusCode: 400,
      error: "Bad Request",
      message: "Validation failed",
      details: ["eventType: must be one of ..."],
    });
  }

  @Get("string-throw")
  stringThrow(): never {
    // Not an Error instance — the filter must still produce a valid body.
    throw "something went wrong";
  }

  /** Drives the status-name lookup table with an arbitrary code. */
  @Get("status/:code")
  byStatus(@Param("code") code: string): never {
    throw new HttpException("triggered", Number(code));
  }

  /** Nest's pipes sometimes put an array in `message`. */
  @Get("array-message")
  arrayMessage(): never {
    throw new BadRequestException({
      message: ["first problem", "second problem"],
    });
  }

  /** An object body with no `message` key at all. */
  @Get("object-no-message")
  objectNoMessage(): never {
    throw new HttpException({ somethingElse: true }, HttpStatus.CONFLICT);
  }
}

describe("[integration] AllExceptionsFilter", () => {
  let app: INestApplication;
  const logs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [BoomController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(buildValidationPipe());
    app.useGlobalFilters(
      new AllExceptionsFilter(
        new StructuredLogger({
          service: "payroll-api",
          context: "AllExceptionsFilter",
          write: (line) => logs.push(JSON.parse(line)),
        }),
      ),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logs.length = 0;
  });

  it("converts an unhandled error into the standard shape", async () => {
    const res = await request(app.getHttpServer())
      .get("/boom/unhandled")
      .expect(500);

    expect(res.body).toMatchObject({
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
      path: "/boom/unhandled",
    });
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("never leaks a stack trace or internal detail to the client", async () => {
    const res = await request(app.getHttpServer())
      .get("/boom/unhandled")
      .expect(500);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("10.0.0.5");
    expect(res.body.stack).toBeUndefined();
  });

  it("logs the stack server-side, where operators can see it", async () => {
    await request(app.getHttpServer()).get("/boom/unhandled").expect(500);

    const errorLog = logs.find((l) => l.level === "error");
    expect(errorLog).toBeDefined();
    // Withheld from the response, kept in the log.
    expect(String(errorLog!.stack)).toContain("ECONNREFUSED");
    expect(errorLog!.statusCode).toBe(500);
    expect(errorLog!.path).toBe("/boom/unhandled");
  });

  it("preserves the message of an intentional HttpException", async () => {
    const res = await request(app.getHttpServer()).get("/boom/http").expect(404);

    expect(res.body).toMatchObject({
      statusCode: 404,
      error: "Not Found",
      message: "Event abc-123 not found",
      path: "/boom/http",
    });
  });

  it("preserves a validation body's details array", async () => {
    const res = await request(app.getHttpServer())
      .get("/boom/structured")
      .expect(400);

    expect(res.body.details).toEqual(["eventType: must be one of ..."]);
    expect(res.body.message).toBe("Validation failed");
    expect(res.body.path).toBe("/boom/structured");
  });

  it("handles a thrown non-Error value", async () => {
    const res = await request(app.getHttpServer())
      .get("/boom/string-throw")
      .expect(500);

    expect(res.body.statusCode).toBe(500);
    expect(res.body.message).toBe("An unexpected error occurred");
  });

  it("logs 4xx at warn and 5xx at error", async () => {
    await request(app.getHttpServer()).get("/boom/http").expect(404);
    expect(logs.find((l) => l.level === "warn")).toBeDefined();
    expect(logs.find((l) => l.level === "error")).toBeUndefined();

    logs.length = 0;
    await request(app.getHttpServer()).get("/boom/unhandled").expect(500);
    // Only 5xx is our fault, so only 5xx is worth alerting on.
    expect(logs.find((l) => l.level === "error")).toBeDefined();
  });

  it("returns the standard shape for an unmatched route", async () => {
    const res = await request(app.getHttpServer())
      .get("/does-not-exist")
      .expect(404);

    expect(res.body).toMatchObject({ statusCode: 404, error: "Not Found" });
    expect(res.body.path).toBe("/does-not-exist");
    expect(res.body.timestamp).toBeDefined();
  });

  describe("status-code normalisation", () => {
    it.each([
      [401, "Unauthorized"],
      [403, "Forbidden"],
      [409, "Conflict"],
      [422, "Unprocessable Entity"],
      [429, "Too Many Requests"],
      [503, "Service Unavailable"],
    ])("names %i as %s", async (status, expected) => {
      const res = await request(app.getHttpServer())
        .get(`/boom/status/${status}`)
        .expect(status);

      expect(res.body.error).toBe(expected);
      expect(res.body.statusCode).toBe(status);
    });

    it("falls back to a generic name for an unmapped status", async () => {
      const res = await request(app.getHttpServer())
        .get("/boom/status/418")
        .expect(418);

      expect(res.body.error).toBe("Error");
    });

    it("flattens an array message into one string", async () => {
      // Nest's pipes sometimes put an array in `message`; the filter must
      // normalise it rather than emitting an array where clients expect text.
      const res = await request(app.getHttpServer())
        .get("/boom/array-message")
        .expect(400);

      expect(typeof res.body.message).toBe("string");
      expect(res.body.message).toBe("first problem; second problem");
    });

    it("keeps a message when the body object supplies none", async () => {
      const res = await request(app.getHttpServer())
        .get("/boom/object-no-message")
        .expect(409);

      expect(res.body.error).toBe("Conflict");
      expect(res.body.message).toBeTruthy();
    });
  });
});
