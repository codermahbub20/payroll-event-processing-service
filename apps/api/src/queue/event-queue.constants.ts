/** Name of the BullMQ queue carrying payroll events to the worker. */
export const PAYROLL_EVENT_QUEUE = "payroll-events";

/** DI token for the queue producer, so tests can inject a fake. */
export const EVENT_QUEUE = Symbol("EVENT_QUEUE");

/** Payload placed on the queue. Deliberately minimal — the worker re-reads
 *  the authoritative row from Postgres rather than trusting job data, which
 *  could be stale if the event was modified after enqueue. */
export interface PayrollEventJobData {
  eventId: string;
}

/** Contract the events service depends on. */
export interface EventQueueProducer {
  enqueueEvent(data: PayrollEventJobData): Promise<void>;
}
