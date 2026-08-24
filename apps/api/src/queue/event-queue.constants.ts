import type { PayrollEventJobData } from "@payroll/shared";

// The queue name and job payload shape now live in @payroll/shared so the
// producer (api) and consumer (worker) cannot drift apart.
export { PAYROLL_EVENT_QUEUE, type PayrollEventJobData } from "@payroll/shared";

/** DI token for the queue producer, so tests can inject a fake. */
export const EVENT_QUEUE = Symbol("EVENT_QUEUE");

/** Outcome of probing the queue's dependencies. */
export interface QueueHealth {
  /** Redis responded to PING. */
  redis: boolean;
  /** BullMQ answered a queue-level command. */
  queue: boolean;
  /** Present when the queue is configured but unreachable. */
  error?: string;
  /** False when no broker is configured at all (the no-op producer). */
  configured: boolean;
  /** Pending job counts, when reachable — useful for backlog alerting. */
  counts?: Record<string, number>;
}

/** Contract the events service depends on. */
export interface EventQueueProducer {
  enqueueEvent(data: PayrollEventJobData): Promise<void>;
  /** Probes Redis and the queue. Never throws; reports failure in the result. */
  checkHealth(): Promise<QueueHealth>;
}
