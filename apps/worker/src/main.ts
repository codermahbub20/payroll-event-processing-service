import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { prisma } from "@payroll/database";
import {
  EmployeeOrdering,
  PayrollEventProducer,
  createRedisConnection,
} from "@payroll/queue";
import { SimulatedPayrollGateway } from "./processing/payroll-gateway";
import { PayrollWorker, DEFAULT_CONCURRENCY } from "./processor/payroll-worker";
import {
  DEFAULT_STUCK_TIMEOUT_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  RecoverySweep,
  ScheduledRecoverySweep,
} from "./processor/recovery-sweep";
import { WorkerHealthServer } from "./health/health-server";
import { WorkerModule } from "./worker.module";

/** Reads a numeric env var, falling back when unset or unparseable. */
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

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

  // Failure rates are configurable so the simulated provider can be made
  // deterministic (0) for demos or hostile (1) for exercising the retry path.
  const gateway = new SimulatedPayrollGateway({
    temporaryFailureRate: numberFromEnv("SIMULATED_TEMPORARY_FAILURE_RATE", 0.2),
    permanentFailureRate: numberFromEnv("SIMULATED_PERMANENT_FAILURE_RATE", 0.05),
    minLatencyMs: numberFromEnv("SIMULATED_MIN_LATENCY_MS", 500),
    maxLatencyMs: numberFromEnv("SIMULATED_MAX_LATENCY_MS", 3000),
  });

  const worker = new PayrollWorker({
    redisUrl,
    prisma,
    concurrency,
    gateway,
  });
  await worker.waitUntilReady();

  // Recovery sweep: catches events abandoned in PROCESSING that BullMQ's own
  // stalled detection cannot see (queue data lost, stall budget exhausted,
  // enqueue that never happened). Runs once at startup, then on an interval.
  const sweepConnection = createRedisConnection(redisUrl);
  const sweepProducer = new PayrollEventProducer(sweepConnection);
  const sweep = new RecoverySweep(
    prisma,
    sweepProducer,
    new EmployeeOrdering(sweepConnection),
    {
      stuckTimeoutMs: numberFromEnv(
        "RECOVERY_STUCK_TIMEOUT_MS",
        DEFAULT_STUCK_TIMEOUT_MS,
      ),
    },
  );
  const scheduledSweep = new ScheduledRecoverySweep(
    sweep,
    numberFromEnv("RECOVERY_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS),
    (error) => logger.error(`recovery sweep failed: ${String(error)}`),
  );

  const startupSweep = await scheduledSweep.start();
  if (startupSweep.scanned > 0) {
    logger.warn(
      `startup sweep recovered ${startupSweep.reEnqueued} and parked ` +
        `${startupSweep.markedFailed} of ${startupSweep.scanned} stuck events`,
    );
  }

  // Health endpoint. See health-server.ts for why HTTP over a heartbeat file.
  const healthServer = new WorkerHealthServer({
    port: numberFromEnv("WORKER_HEALTH_PORT", 3001),
    prisma,
    redis: worker.getConnection(),
    isWorkerRunning: () => worker.isRunning(),
  });
  await healthServer.start();

  logger.log(`worker started (concurrency=${concurrency})`);

  // Drain in-flight jobs before exiting so a deploy does not abandon work
  // mid-transaction and leave an employee's lock held until its TTL expires.
  const shutdown = async (signal: string) => {
    logger.log(`${signal} received; draining`);
    scheduledSweep.stop();
    await healthServer.stop();
    await worker.close();
    await sweepProducer.close();
    await sweepConnection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

bootstrap();
