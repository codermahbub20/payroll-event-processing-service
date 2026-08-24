import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { WorkerModule } from "./worker.module";
import { EventStatus } from "@payroll/shared";

async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerModule);
  const logger = new Logger("Worker");
  logger.log(`worker started (default event status: ${EventStatus.PENDING})`);
}

bootstrap();
