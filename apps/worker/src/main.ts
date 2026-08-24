import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { prisma } from "@payroll/database";
import { PayrollWorker, DEFAULT_CONCURRENCY } from "./processor/payroll-worker";
import { WorkerModule } from "./worker.module";

async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerModule);
  const logger = new Logger("Worker");

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.error("REDIS_URL is not set; the worker has nothing to consume");
    process.exit(1);
  }

  const concurrency = process.env.WORKER_CONCURRENCY
    ? Number(process.env.WORKER_CONCURRENCY)
    : DEFAULT_CONCURRENCY;

  const worker = new PayrollWorker({ redisUrl, prisma, concurrency });
  await worker.waitUntilReady();

  logger.log(`worker started (concurrency=${concurrency})`);

  // Drain in-flight jobs before exiting so a deploy does not abandon work
  // mid-transaction and leave an employee's lock held until its TTL expires.
  const shutdown = async (signal: string) => {
    logger.log(`${signal} received; draining`);
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

bootstrap();
