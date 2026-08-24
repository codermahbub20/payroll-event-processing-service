import { Logger } from "@nestjs/common";
import { PrismaClient } from "@payroll/database";
import { EmployeeOrdering, createRedisConnection } from "@payroll/queue";
import type { Redis } from "@payroll/queue";
import {
  PAYROLL_EVENT_QUEUE,
  type PayrollEventJobData,
  type PayrollEventJobResult,
} from "@payroll/shared";
import { Worker } from "bullmq";
import { EventProcessor, type EventProcessorOptions } from "./event-processor";

export interface PayrollWorkerOptions extends EventProcessorOptions {
  redisUrl: string;
  prisma: PrismaClient;
  /**
   * How many jobs run in parallel. This is the concurrency across DIFFERENT
   * employees — ordering within one employee is enforced by the Redis lock,
   * not by limiting concurrency.
   */
  concurrency?: number;
  connection?: Redis;
  /** How long a worker may hold a job's lock without renewing it. */
  lockDuration?: number;
  /** How often the worker scans for jobs whose lock expired. */
  stalledInterval?: number;
  /** How many times a job may stall before being failed outright. */
  maxStalledCount?: number;
}

export const DEFAULT_CONCURRENCY = 10;

/**
 * Stalled-job detection settings.
 *
 * A job "stalls" when its owning worker stops renewing the lock — the process
 * crashed, was OOM-killed, or lost its Redis connection. BullMQ then hands the
 * job to another worker.
 *
 * `lockDuration` must comfortably exceed the slowest realistic job. The
 * simulated provider can take up to 3s, and a job may also wait on its
 * employee ordering lock, so 30s leaves generous headroom. Setting it too low
 * causes healthy long-running jobs to be redelivered while still executing —
 * two workers on one event.
 *
 * `stalledInterval` bounds detection latency: a crashed job is picked up
 * within roughly lockDuration + stalledInterval.
 *
 * `maxStalledCount` caps how many times a job may stall before BullMQ fails it
 * permanently. Without a cap, a job that reliably crashes its worker (a poison
 * message) would cycle forever, taking a worker down each time.
 */
export const DEFAULT_LOCK_DURATION_MS = 30_000;
export const DEFAULT_STALLED_INTERVAL_MS = 15_000;
export const DEFAULT_MAX_STALLED_COUNT = 2;

/**
 * BullMQ consumer for payroll events.
 *
 * Concurrency and ordering are deliberately decoupled: the worker runs many
 * jobs at once, and the per-employee lock is what serialises jobs that share
 * an employeeId. Enforcing order by setting concurrency to 1 would serialise
 * ALL employees, which is the behaviour this design exists to avoid.
 */
export class PayrollWorker {
  private readonly logger = new Logger(PayrollWorker.name);
  private readonly connection: Redis;
  private readonly ownsConnection: boolean;
  private readonly worker: Worker<PayrollEventJobData, PayrollEventJobResult | undefined>;
  private readonly ordering: EmployeeOrdering;
  private readonly processor: EventProcessor;

  constructor(options: PayrollWorkerOptions) {
    this.ownsConnection = !options.connection;
    this.connection =
      options.connection ?? createRedisConnection(options.redisUrl);

    this.ordering = new EmployeeOrdering(this.connection);

    this.processor = new EventProcessor(options.prisma, this.ordering, {
      requeueDelayMs: options.requeueDelayMs,
      gateway: options.gateway,
      logger: options.logger,
    });

    this.worker = new Worker<PayrollEventJobData, PayrollEventJobResult | undefined>(
      PAYROLL_EVENT_QUEUE,
      (job, token) => this.processor.process(job, token),
      {
        connection: this.connection,
        concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
        // Crash recovery: if this process dies mid-job, the lock expires and
        // another worker picks the job up. Safe because the processor's
        // terminal-status check and the applied_operations ledger make
        // redelivery idempotent.
        lockDuration: options.lockDuration ?? DEFAULT_LOCK_DURATION_MS,
        stalledInterval: options.stalledInterval ?? DEFAULT_STALLED_INTERVAL_MS,
        maxStalledCount: options.maxStalledCount ?? DEFAULT_MAX_STALLED_COUNT,
      },
    );

    this.worker.on("stalled", (jobId) => {
      // Worth a loud log: frequent stalls mean crashing workers or a
      // lockDuration set below real job durations.
      this.logger.warn(
        `job ${jobId} stalled and was requeued for another worker`,
      );
    });

    this.worker.on("failed", (job, error) => {
      this.logger.error(
        `job ${job?.id} failed: ${error.message}`,
        error.stack,
      );
    });

    this.worker.on("error", (error) => {
      this.logger.error(`worker error: ${error.message}`, error.stack);
    });
  }

  /** Resolves once the worker is connected and ready to take jobs. */
  async waitUntilReady(): Promise<void> {
    await this.worker.waitUntilReady();
  }

  /**
   * True while the worker is consuming. Used by the health endpoint: a worker
   * process that is alive but whose BullMQ consumer has closed would otherwise
   * report healthy while doing no work.
   */
  isRunning(): boolean {
    return this.worker.isRunning() && !this.worker.closing;
  }

  /** Underlying Redis connection, for health probes. */
  getConnection(): Redis {
    return this.connection;
  }

  /**
   * Shuts the worker down.
   *
   * `force` skips waiting for in-flight jobs, which is what a crash looks
   * like: locks are abandoned rather than released, so BullMQ's stalled
   * detection has to reclaim the jobs. Used by the crash-recovery tests.
   */
  async close(force = false): Promise<void> {
    await this.worker.close(force);
    if (this.ownsConnection) {
      await this.connection.quit();
    }
  }
}
