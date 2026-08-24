import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

export const SWAGGER_PATH = "api/docs";

/**
 * Mounts the OpenAPI document at /api/docs, with the raw JSON spec at
 * /api/docs-json for client generation.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle("Payroll Event Processing Service")
    .setDescription(
      "Asynchronous processing of payroll change events.\n\n" +
        "Events are submitted via `POST /events`, persisted as PENDING, and " +
        "processed by a separate worker. Submission is idempotent: supply an " +
        "`Idempotency-Key` header, or one is derived from the request body.\n\n" +
        "Processing is at-least-once at the delivery layer but at-most-once in " +
        "business effect — see docs/database-design.md.",
    )
    .setVersion("0.1.0")
    .addTag("events", "Submit and inspect payroll events")
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: `${SWAGGER_PATH}-json`,
    swaggerOptions: {
      // Keeps the operation list readable as more endpoints are added.
      docExpansion: "list",
      persistAuthorization: true,
    },
  });
}
