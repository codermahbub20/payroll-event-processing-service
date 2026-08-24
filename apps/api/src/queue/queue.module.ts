import { Global, Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BullEventQueue } from "./bull-event-queue";
import {
  EVENT_QUEUE,
  EventQueueProducer,
  PayrollEventJobData,
} from "./event-queue.constants";

/**
 * No-op producer used when REDIS_URL is unset (e.g. integration tests that
 * exercise the HTTP + DB path without a broker). Logs instead of enqueueing so
 * a misconfigured production deploy is loud rather than silently dropping work.
 */
class NoopEventQueue implements EventQueueProducer {
  private readonly logger = new Logger(NoopEventQueue.name);

  async enqueueEvent(data: PayrollEventJobData): Promise<void> {
    this.logger.warn(
      `REDIS_URL not configured — event ${data.eventId} was persisted but NOT enqueued`,
    );
  }
}

@Global()
@Module({
  providers: [
    {
      provide: EVENT_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): EventQueueProducer => {
        const redisUrl = config.get<string>("REDIS_URL");
        return redisUrl ? new BullEventQueue(redisUrl) : new NoopEventQueue();
      },
    },
  ],
  exports: [EVENT_QUEUE],
})
export class QueueModule {}
