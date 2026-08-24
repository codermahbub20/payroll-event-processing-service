import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { OpenAPIObject } from "@nestjs/swagger";

export const SWAGGER_PATH = "api/docs";

/**
 * The OpenAPI document definition.
 *
 * Exported separately so `scripts/export-openapi.ts` produces byte-identical
 * output to what the running server serves — a spec file generated from a
 * different config than the live one is worse than no spec file.
 */
export function buildOpenApiConfig(): Omit<OpenAPIObject, "paths"> {
  return new DocumentBuilder()
    .setTitle("Payroll Event Processing Service")
    .setDescription(
      "Asynchronous processing of payroll change events.\n\n" +
        "## Flow\n\n" +
        "1. `POST /events` validates and persists the event as `PENDING`, then " +
        "enqueues it. It returns immediately — processing is asynchronous.\n" +
        "2. A worker claims the event, calls the payroll provider, and moves it " +
        "to `SUCCEEDED`, `FAILED_TEMPORARY` or `FAILED_PERMANENT`.\n" +
        "3. `GET /events/{id}` shows the current status plus the full " +
        "transition timeline.\n\n" +
        "## Idempotency\n\n" +
        "Submission is idempotent. Supply an `Idempotency-Key` header, or one " +
        "is derived from the request body " +
        "(`employeeId` + `eventType` + `effectiveDate` + `payload`). A repeat " +
        "submission returns **200** with the original event instead of **202**, " +
        "and enqueues no new work.\n\n" +
        "## Ordering\n\n" +
        "Events for the same `employeeId` are processed strictly in submission " +
        "order. Events for different employees process concurrently.\n\n" +
        "Delivery is at-least-once, but the business effect is at-most-once — " +
        "see `docs/decisions.md`.",
    )
    .setVersion("0.1.0")
    .addTag("events", "Submit and inspect payroll events")
    .addTag("health", "Liveness and dependency checks")
    .addServer("http://localhost:3000", "Local development")
    .build();
}

/**
 * Mounts the OpenAPI document at /api/docs, with the raw JSON spec at
 * /api/docs-json for client generation.
 */
export function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: `${SWAGGER_PATH}-json`,
    swaggerOptions: {
      // Keeps the operation list readable as more endpoints are added.
      docExpansion: "list",
      persistAuthorization: true,
      // Surfaces the request duration in "Try it out", which makes the
      // async-processing point concrete: submission is fast, work happens later.
      displayRequestDuration: true,
    },
  });
}
