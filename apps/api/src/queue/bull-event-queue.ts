import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import {
  EventQueueProducer,
  PAYROLL_EVENT_QUEUE,
  PayrollEventJobData,
} from "./event-queue.constants";

@Injectable()
export class BullEventQueue implements EventQueueProducer, OnModuleDestroy {
  private readonly logger = new Logger(BullEventQueue.name);
  private readonly queue: Queue<PayrollEventJobData>;

  constructor(redisUrl: string) {
    this.queue = new Queue<PayrollEventJobData>(PAYROLL_EVENT_QUEUE, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        // Retries here cover transient worker/redis failures. Business-level
        // retries (FAILED_TEMPORARY -> next_attempt_at) are handled in the DB
        // by the worker, so these are kept few and short.
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    });
  }

  async enqueueEvent(data: PayrollEventJobData): Promise<void> {
    // jobId = eventId makes the enqueue itself idempotent: if the API crashes
    // after commit but before the ack, a re-enqueue of the same event is
    // collapsed by BullMQ instead of creating a second job.
    await this.queue.add(PAYROLL_EVENT_QUEUE, data, { jobId: data.eventId });
    this.logger.debug(`enqueued event ${data.eventId}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
