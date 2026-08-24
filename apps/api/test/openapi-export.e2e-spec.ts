import { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import type { OpenAPIObject } from "@nestjs/swagger";
import { Test, TestingModule } from "@nestjs/testing";
import { PayrollEventType } from "@payroll/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppModule } from "../src/app.module";
import { buildOpenApiConfig } from "../src/common/swagger";

/**
 * Guards the committed docs/openapi.json.
 *
 * That file is what a reviewer reads without running anything, so it must not
 * drift from the code. A hand-checked spec rots the first time someone edits a
 * decorator and forgets to re-export; this fails the build instead.
 *
 * Builds the real AppModule (not a hand-assembled subset) so the comparison
 * covers every route the running server actually exposes.
 */
describe("committed docs/openapi.json", () => {
  let app: INestApplication;
  let live: OpenAPIObject;
  let exported: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    live = SwaggerModule.createDocument(app, buildOpenApiConfig());
    exported = JSON.parse(
      readFileSync(resolve(__dirname, "../../../docs/openapi.json"), "utf8"),
    ) as OpenAPIObject;
  });

  afterAll(async () => {
    await app.close();
  });

  it("matches the document the server generates", () => {
    // If this fails, run `pnpm docs:export`.
    expect(exported).toEqual(live);
  });

  it("documents exactly the intended endpoints", () => {
    expect(Object.keys(exported.paths).sort()).toEqual([
      "/events",
      "/events/{id}",
      "/health",
    ]);
  });

  it("gives every operation a summary and a tag", () => {
    // Collected rather than asserted inline so a failure names every offending
    // operation at once instead of stopping at the first.
    const missing: string[] = [];

    for (const [path, ops] of Object.entries(exported.paths)) {
      for (const [method, op] of Object.entries(
        ops as Record<string, { summary?: string; tags?: string[] }>,
      )) {
        if (!op.summary) missing.push(`${method.toUpperCase()} ${path}: summary`);
        if (!op.tags?.length) missing.push(`${method.toUpperCase()} ${path}: tag`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("carries a request-body example for every event type", () => {
    const examples = (
      exported.paths["/events"].post as unknown as {
        requestBody: {
          content: Record<
            string,
            { examples: Record<string, { value: { eventType: string } }> }
          >;
        };
      }
    ).requestBody.content["application/json"].examples;

    const documented = Object.values(examples).map((e) => e.value.eventType);

    // Without one example per type, Swagger UI's "Try it out" prefills a single
    // shape and a reviewer has to guess the others.
    for (const type of Object.values(PayrollEventType)) {
      expect(documented).toContain(type);
    }
  });

  it("documents POST /events as 202/200/400", () => {
    const responses = (
      exported.paths["/events"].post as unknown as {
        responses: Record<string, unknown>;
      }
    ).responses;
    expect(Object.keys(responses).sort()).toEqual(["200", "202", "400"]);
  });

  it("documents GET /health as 200/503", () => {
    const responses = (
      exported.paths["/health"].get as unknown as {
        responses: Record<string, unknown>;
      }
    ).responses;
    expect(Object.keys(responses).sort()).toEqual(["200", "503"]);
  });

  it("has no dangling schema references", () => {
    const defined = new Set(Object.keys(exported.components?.schemas ?? {}));
    const referenced = new Set<string>();

    JSON.stringify(exported, (_key, value) => {
      if (
        typeof value === "string" &&
        value.startsWith("#/components/schemas/")
      ) {
        referenced.add(value.replace("#/components/schemas/", ""));
      }
      return value;
    });

    expect([...referenced].filter((n) => !defined.has(n))).toEqual([]);
  });
});
