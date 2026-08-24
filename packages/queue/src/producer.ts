import {
  PAYROLL_EVENT_QUEUE,
  type PayrollEventJobData,
} from "@payroll/shared";
import { Queue } from "bullmq";
import { EmployeeOrdering } from "./employee-ordering";
import type { Redis } from "./connection";

export interface PayrollEventProducerOptions {
  /** Retries for transport-level failures. Business retries live in Postgres. */
  attempts?: number;
  backoffMs?: number;
}

/**
 * Adds payroll events to the queue, recording per-employee ordering as it goes.
 */
export class PayrollEventProducer {
  private readonly queue: Queue<PayrollEventJobData>;
  private readonly ordering: EmployeeOrdering;

  constructor(
    private readonly connection: Redis,
    options: PayrollEventProducerOptions = {},
  ) {
    this.queue = new Queue<PayrollEventJobData>(PAYROLL_EVENT_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: options.attempts ?? 3,
        backoff: { type: "exponential", delay: options.backoffMs ?? 1000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    });
    this.ordering = new EmployeeOrdering(connection);
  }

  /**
   * Enqueues an event for processing.
   *
   * Ordering is registered in Redis BEFORE the BullMQ job is added. That order
   * matters: the FIFO list is the record of accepted order, so if the add()
   * below fails, the event is still correctly positioned and a later
   * redelivery cannot jump the queue. Doing it the other way round would let a
   * job become visible to a worker before its position was recorded.
   */
  async enqueue(eventId: string, employeeId: string): Promise<void> {
    const sequence = await this.ordering.register(employeeId, eventId);

    await this.queue.add(
      PAYROLL_EVENT_QUEUE,
      { eventId, employeeId, sequence: sequence ?? undefined },
      {
        // jobId = eventId makes the enqueue idempotent: a redelivery after a
        // crash between commit and ack is collapsed by BullMQ rather than
        // creating a second job.
        jobId: eventId,
      },
    );
  }

  /** Underlying queue — metrics, tests, administrative operations. */
  getQueue(): Queue<PayrollEventJobData> {
    return this.queue;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
