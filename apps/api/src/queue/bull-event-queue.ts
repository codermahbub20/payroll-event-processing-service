import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { PayrollEventProducer, createRedisConnection } from "@payroll/queue";
import type { Redis } from "@payroll/queue";
import {
  EventQueueProducer,
  PayrollEventJobData,
  QueueHealth,
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

  /**
   * Probes Redis and BullMQ separately.
   *
   * PING alone is not enough: Redis can be up while BullMQ is unusable (wrong
   * database, evicted keys, a Lua script that will not load). Asking the queue
   * for job counts exercises the path the producer actually uses.
   *
   * Never throws — a health check that raises is useless, since the caller
   * cannot distinguish "dependency down" from "health check broken".
   */
  async checkHealth(): Promise<QueueHealth> {
    let redis: boolean;
    try {
      const pong = await this.connection.ping();
      redis = pong === "PONG";
    } catch (error) {
      return {
        configured: true,
        redis: false,
        queue: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const counts = await this.producer.getQueue().getJobCounts();
      return { configured: true, redis, queue: true, counts };
    } catch (error) {
      return {
        configured: true,
        redis,
        queue: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.close();
    await this.connection.quit();
  }
}
