import type { PayrollEventJobData } from "@payroll/shared";

// The queue name and job payload shape now live in @payroll/shared so the
// producer (api) and consumer (worker) cannot drift apart.
export { PAYROLL_EVENT_QUEUE, type PayrollEventJobData } from "@payroll/shared";

/** DI token for the queue producer, so tests can inject a fake. */
export const EVENT_QUEUE = Symbol("EVENT_QUEUE");

/** Contract the events service depends on. */
export interface EventQueueProducer {
  enqueueEvent(data: PayrollEventJobData): Promise<void>;
}
