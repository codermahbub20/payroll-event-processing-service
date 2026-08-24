import "reflect-metadata";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "../src/app.module";
import { buildOpenApiConfig } from "../src/common/swagger";

/**
 * Writes the generated OpenAPI document to docs/openapi.json.
 *
 * Uses `NestFactory.create` WITHOUT `listen`, so the document is produced from
 * the real module graph and decorators without binding a port or accepting
 * traffic. Generating it from the live app rather than hand-maintaining a spec
 * file is the point: a hand-written spec drifts from the code silently, and a
 * reviewer reading it would be reading fiction.
 *
 * The app still instantiates providers, so PrismaService opens a pool. It is
 * closed before exit; the export does not require a reachable database because
 * nothing queries during module init.
 */
async function exportOpenApi(): Promise<void> {
  const outputPath = resolve(__dirname, "../../../docs/openapi.json");

  const app = await NestFactory.create(AppModule, {
    // The export is a build step; framework chatter would pollute CI output.
    logger: false,
  });

  try {
    const document = SwaggerModule.createDocument(app, buildOpenApiConfig());

    mkdirSync(dirname(outputPath), { recursive: true });
    // Trailing newline and 2-space indent keep the committed file diff-friendly.
    writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

    const pathCount = Object.keys(document.paths ?? {}).length;
    const schemaCount = Object.keys(document.components?.schemas ?? {}).length;

    console.log(
      `wrote ${outputPath} (${pathCount} paths, ${schemaCount} schemas)`,
    );
  } finally {
    await app.close();
  }
}

exportOpenApi()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("failed to export OpenAPI document:", error);
    process.exit(1);
  });
