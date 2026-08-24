import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { StructuredLogger } from "@payroll/shared";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";
import { NestJsonLogger } from "./common/nest-json-logger";
import { buildValidationPipe } from "./common/validation";
import { setupSwagger } from "./common/swagger";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Framework output goes through the same JSON formatter as app logs.
    logger: new NestJsonLogger(),
  });

  app.useGlobalPipes(buildValidationPipe());
  // Registered globally so no route can leak a stack trace.
  app.useGlobalFilters(new AllExceptionsFilter());
  setupSwagger(app);

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);

  new StructuredLogger({ service: "payroll-api", context: "Bootstrap" }).info({
    event: "api_started",
    message: `listening on port ${port}`,
    port,
    docs: "/api/docs",
    health: "/health",
  });
}

bootstrap();
