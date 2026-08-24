import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { PayrollEventProducer, createRedisConnection } from "@payroll/queue";
import type { Redis } from "@payroll/queue";
import {
  EventQueueProducer,
  PayrollEventJobData,
} from "./event-queue.constants";

/**
 * BullMQ-backed producer.
 *
 * Delegates to @payroll/queue's PayrollEventProducer, which records the
 * event in its employee's FIFO ordering list before adding the job.
 */
@Injectable()
export class BullEventQueue implements EventQueueProducer, OnModuleDestroy {
  private readonly logger = new Logger(BullEventQueue.name);
  private readonly connection: Redis;
  private readonly producer: PayrollEventProducer;

  constructor(redisUrl: string) {
    this.connection = createRedisConnection(redisUrl);
    this.producer = new PayrollEventProducer(this.connection);
  }

  async enqueueEvent(data: PayrollEventJobData): Promise<void> {
    await this.producer.enqueue(data.eventId, data.employeeId);
    this.logger.debug(
      `enqueued event ${data.eventId} for employee ${data.employeeId}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.close();
    await this.connection.quit();
  }
}
