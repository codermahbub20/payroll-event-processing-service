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
}

export const DEFAULT_CONCURRENCY = 10;

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
      applyEffect: options.applyEffect,
    });

    this.worker = new Worker<PayrollEventJobData, PayrollEventJobResult | undefined>(
      PAYROLL_EVENT_QUEUE,
      (job, token) => this.processor.process(job, token),
      {
        connection: this.connection,
        concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      },
    );

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

  async close(): Promise<void> {
    await this.worker.close();
    if (this.ownsConnection) {
      await this.connection.quit();
    }
  }
}
