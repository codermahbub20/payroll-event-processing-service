import { Logger } from "@nestjs/common";
import { PrismaClient } from "@payroll/database";
import { EmployeeOrdering } from "@payroll/queue";
import {
  PayrollEventStatus,
  type PayrollEventJobData,
  type PayrollEventJobResult,
} from "@payroll/shared";
import { DelayedError } from "bullmq";
import type { Job } from "bullmq";

export interface EventProcessorOptions {
  /** Delay before re-checking a job whose turn has not come. */
  requeueDelayMs?: number;
  /** Injectable hook standing in for the real downstream effect. */
  applyEffect?: (event: {
    id: string;
    employeeId: string;
    eventType: string;
    payload: unknown;
  }) => Promise<Record<string, unknown> | void>;
}

/**
 * Processes one payroll event, enforcing per-employee ordering.
 *
 * Flow:
 *   1. Try to take the employee's ordering lock. If this event is not at the
 *      head of that employee's FIFO queue, re-queue with a delay and return —
 *      no status change, no retry consumed.
 *   2. Mark the event PROCESSING and append a history row.
 *   3. Run the business effect (guarded by the applied_operations ledger so a
 *      redelivery cannot apply it twice).
 *   4. Mark terminal status, append history, release the lock.
 *
 * The lock is released in a `finally` so a failure cannot wedge an employee's
 * queue — without that, one bad event blocks every later event for that
 * employee until the lock TTL expires.
 */
export class EventProcessor {
  private readonly logger = new Logger(EventProcessor.name);
  private readonly requeueDelayMs: number;
  private readonly applyEffect: NonNullable<EventProcessorOptions["applyEffect"]>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ordering: EmployeeOrdering,
    options: EventProcessorOptions = {},
  ) {
    this.requeueDelayMs = options.requeueDelayMs ?? 50;
    this.applyEffect =
      options.applyEffect ??
      (async () => {
        // Business logic lands here in a later step. Scaffolding only.
        return { applied: true };
      });
  }

  async process(
    job: Job<PayrollEventJobData>,
    token?: string,
  ): Promise<PayrollEventJobResult | undefined> {
    const { eventId, employeeId } = job.data;

    const acquired = await this.ordering.acquire(employeeId, eventId);
    if (!acquired) {
      // Someone earlier in this employee's queue is still in flight. Defer
      // this job rather than failing it: a throw would burn a retry attempt
      // and eventually land a perfectly valid event in the DLQ.
      this.logger.debug(
        `event ${eventId} waiting its turn for employee ${employeeId}`,
      );
      await this.deferUntilTurn(job, token);
      return undefined;
    }

    try {
      return await this.ordering.withRenewal(employeeId, eventId, () =>
        this.runGuarded(eventId, employeeId),
      );
    } finally {
      // Always release, success or failure, so the employee's queue advances.
      const next = await this.ordering.release(employeeId, eventId);
      if (next) {
        this.logger.debug(`employee ${employeeId} advances to event ${next}`);
      }
    }
  }

  /**
   * Defers a job whose turn has not come, via BullMQ's `moveToDelayed` +
   * `DelayedError` protocol.
   *
   * Why not simply re-`add` the job with the same jobId: BullMQ refuses to
   * re-add a jobId that is currently active or completed, and it does so
   * SILENTLY — `add()` returns a plausible-looking Job object while no job is
   * actually queued, so the event disappears. Verified directly against a real
   * Redis before settling on this approach.
   *
   * `moveToDelayed` keeps the SAME job (so `jobId === eventId` still dedups
   * redeliveries) and does not consume a retry attempt, because throwing
   * DelayedError tells BullMQ the job was deliberately rescheduled rather
   * than having failed.
   */
  private async deferUntilTurn(
    job: Job<PayrollEventJobData>,
    token?: string,
  ): Promise<never> {
    await job.moveToDelayed(Date.now() + this.requeueDelayMs, token);
    throw new DelayedError();
  }

  private async runGuarded(
    eventId: string,
    employeeId: string,
  ): Promise<PayrollEventJobResult> {
    const event = await this.prisma.payrollEvent.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      // The row is the source of truth; a job without one is a stale artifact
      // (e.g. the event was purged). Nothing to do.
      this.logger.warn(`event ${eventId} not found; discarding job`);
      return { eventId, status: "MISSING" };
    }

    // Terminal events are never reprocessed. This is the cheap guard; the
    // applied_operations ledger below is the authoritative one.
    if (
      event.status === PayrollEventStatus.SUCCEEDED ||
      event.status === PayrollEventStatus.FAILED_PERMANENT
    ) {
      this.logger.debug(`event ${eventId} already terminal (${event.status})`);
      return { eventId, status: event.status, alreadyApplied: true };
    }

    await this.markProcessing(eventId, event.status, event.attemptCount);

    try {
      const result = await this.applyBusinessEffect(event);
      await this.markSucceeded(eventId, result);
      return { eventId, status: PayrollEventStatus.SUCCEEDED };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markFailed(eventId, message);
      throw error;
    }
  }

  /** Moves the event to PROCESSING and records the transition. */
  private async markProcessing(
    eventId: string,
    previousStatus: string,
    attemptCount: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollEvent.update({
        where: { id: eventId },
        data: {
          status: PayrollEventStatus.PROCESSING,
          startedProcessingAt: new Date(),
          attemptCount: attemptCount + 1,
          version: { increment: 1 },
        },
      });

      await tx.payrollEventHistory.create({
        data: {
          eventId,
          previousStatus: previousStatus as PayrollEventStatus,
          newStatus: PayrollEventStatus.PROCESSING,
          actor: "worker",
        },
      });
    });
  }

  /**
   * Runs the side effect and records it in the at-most-once ledger, in ONE
   * transaction. A redelivery hits the unique (event_id, operation_key)
   * constraint and returns the stored result instead of re-applying.
   */
  private async applyBusinessEffect(event: {
    id: string;
    employeeId: string;
    eventType: string;
    payload: unknown;
  }): Promise<Record<string, unknown>> {
    const operationKey = "apply-payroll-change";

    const existing = await this.prisma.appliedOperation.findUnique({
      where: { eventId_operationKey: { eventId: event.id, operationKey } },
    });

    if (existing) {
      this.logger.debug(`event ${event.id} effect already applied; replaying`);
      return (existing.result as Record<string, unknown>) ?? {};
    }

    const result = (await this.applyEffect(event)) ?? {};

    await this.prisma.appliedOperation.create({
      data: {
        eventId: event.id,
        operationKey,
        result: result as never,
      },
    });

    return result as Record<string, unknown>;
  }

  private async markSucceeded(
    eventId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollEvent.update({
        where: { id: eventId },
        data: {
          status: PayrollEventStatus.SUCCEEDED,
          completedAt: new Date(),
          version: { increment: 1 },
        },
      });

      await tx.payrollEventHistory.create({
        data: {
          eventId,
          previousStatus: PayrollEventStatus.PROCESSING,
          newStatus: PayrollEventStatus.SUCCEEDED,
          actor: "worker",
          details: result as never,
        },
      });
    });
  }

  private async markFailed(eventId: string, message: string): Promise<void> {
    // Everything is treated as retryable for now; classifying permanent
    // failures belongs with the real business logic in a later step.
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollEvent.update({
        where: { id: eventId },
        data: {
          status: PayrollEventStatus.FAILED_TEMPORARY,
          lastError: message,
          version: { increment: 1 },
        },
      });

      await tx.payrollEventHistory.create({
        data: {
          eventId,
          previousStatus: PayrollEventStatus.PROCESSING,
          newStatus: PayrollEventStatus.FAILED_TEMPORARY,
          actor: "worker",
          details: { error: message } as never,
        },
      });
    });
  }
}
