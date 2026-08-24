import { PrismaClient } from "@payroll/database";
import { EmployeeOrdering } from "@payroll/queue";
import {
  PayrollEventStatus,
  type PayrollEventJobData,
  type PayrollEventJobResult,
} from "@payroll/shared";
import { DelayedError, UnrecoverableError } from "bullmq";
import type { Job } from "bullmq";
import {
  BusinessValidationError,
  PayrollProcessingError,
  errorCode,
  isRetryable,
} from "../processing/errors";
import {
  SimulatedPayrollGateway,
  type PayrollGatewayRequest,
  type PayrollGatewayResult,
} from "../processing/payroll-gateway";
import { StructuredLogger } from "../processing/structured-logger";
import { assertValidPayload } from "../processing/validation";

/** Operation key for the at-most-once ledger. */
export const APPLY_OPERATION_KEY = "apply-payroll-change";

export interface EventProcessorOptions {
  /** Delay before re-checking a job whose turn has not come. */
  requeueDelayMs?: number;
  /** Downstream payroll system. Injectable for tests. */
  gateway?: Pick<SimulatedPayrollGateway, "apply">;
  logger?: StructuredLogger;
}

/**
 * Processes one payroll event: ordering gate, validation, downstream call,
 * status transition.
 *
 * Failure handling is the substance here:
 *   - business validation failure  -> FAILED_PERMANENT, no retry
 *   - explicit permanent downstream error -> FAILED_PERMANENT, no retry
 *   - temporary error, retries left -> throw, BullMQ retries with backoff;
 *     the row stays PROCESSING because the attempt is still in flight
 *   - temporary error, budget spent -> FAILED_TEMPORARY (recoverable later
 *     by a manual re-trigger or sweep)
 */
export class EventProcessor {
  private readonly requeueDelayMs: number;
  private readonly gateway: Pick<SimulatedPayrollGateway, "apply">;
  private readonly logger: StructuredLogger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ordering: EmployeeOrdering,
    options: EventProcessorOptions = {},
  ) {
    this.requeueDelayMs = options.requeueDelayMs ?? 50;
    this.gateway = options.gateway ?? new SimulatedPayrollGateway();
    this.logger = options.logger ?? new StructuredLogger();
  }

  async process(
    job: Job<PayrollEventJobData>,
    token?: string,
  ): Promise<PayrollEventJobResult | undefined> {
    const { eventId, employeeId } = job.data;

    const acquired = await this.ordering.acquire(employeeId, eventId);
    if (!acquired) {
      // Someone earlier in this employee's queue is still in flight. Defer
      // rather than fail: a throw would burn a retry attempt and eventually
      // land a perfectly valid event in the DLQ.
      this.logger.log({
        event: "processing_deferred",
        eventId,
        employeeId,
        attempt: job.attemptsMade + 1,
      });
      await this.deferUntilTurn(job, token);
      return undefined;
    }

    try {
      return await this.ordering.withRenewal(employeeId, eventId, () =>
        this.runGuarded(job),
      );
    } finally {
      // Always release, success or failure, so the employee's queue advances.
      await this.ordering.release(employeeId, eventId);
    }
  }

  /**
   * Defers a job whose turn has not come, via BullMQ's `moveToDelayed` +
   * `DelayedError` protocol.
   *
   * Why not simply re-`add` the job with the same jobId: BullMQ refuses to
   * re-add a jobId that is currently active or completed, and it does so
   * SILENTLY — `add()` returns a plausible-looking Job object while no job is
   * actually queued, so the event disappears. Verified against a real Redis.
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
    job: Job<PayrollEventJobData>,
  ): Promise<PayrollEventJobResult> {
    const { eventId, employeeId } = job.data;

    // BullMQ's attemptsMade is 0-based DURING execution (verified against a
    // real Redis: a 3-attempt job observes 0, 1, 2). Humans and logs want
    // 1-based, hence the +1 throughout.
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const isLastAttempt = attempt >= maxAttempts;

    const event = await this.prisma.payrollEvent.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      // The row is the source of truth; a job without one is a stale artifact.
      this.logger.log({
        event: "processing_skipped",
        eventId,
        employeeId,
        attempt,
        reason: "event_not_found",
      });
      return { eventId, status: "MISSING" };
    }

    // PROCESSING MARKER CHECK — the first line of defence against a
    // redelivered event.
    //
    // If the event already reached a terminal status, a previous delivery
    // completed the whole flow: provider called, ledger written, status
    // committed. Short-circuit here so the external system is never called a
    // second time. This runs BEFORE markProcessing, so a duplicate delivery
    // does not even perturb the row.
    if (
      event.status === PayrollEventStatus.SUCCEEDED ||
      event.status === PayrollEventStatus.FAILED_PERMANENT
    ) {
      this.logger.log({
        event: "duplicate_delivery_skipped",
        eventId,
        employeeId,
        eventType: event.eventType,
        attempt,
        reason: "already_terminal",
        currentStatus: event.status,
        message:
          "duplicate delivery detected, skipping re-application of the business effect",
      });
      return { eventId, status: event.status, alreadyApplied: true };
    }

    await this.markProcessing(eventId, event.status, event.attemptCount);

    this.logger.log({
      event: "processing_started",
      eventId,
      employeeId,
      eventType: event.eventType,
      attempt,
      maxAttempts,
    });

    const startedAt = Date.now();

    try {
      const { result, alreadyApplied } = await this.applyBusinessEffect({
        eventId: event.id,
        employeeId: event.employeeId,
        eventType: event.eventType,
        payload: event.payload,
      });

      if (alreadyApplied) {
        // Crash-recovery path: a previous delivery reached the provider and
        // committed the ledger row, then died before the event was marked
        // SUCCEEDED. The effect must NOT be re-applied; we only finish the
        // transition the dead worker never got to.
        this.logger.log({
          event: "duplicate_delivery_skipped",
          eventId,
          employeeId,
          eventType: event.eventType,
          attempt,
          maxAttempts,
          reason: "effect_already_applied",
          message:
            "duplicate delivery detected, skipping re-application of the business effect",
          confirmationId: result.confirmationId,
        });
      }

      await this.commitSuccess(eventId, result, alreadyApplied);

      this.logger.log({
        event: "processing_succeeded",
        eventId,
        employeeId,
        eventType: event.eventType,
        attempt,
        maxAttempts,
        durationMs: Date.now() - startedAt,
        confirmationId: result.confirmationId,
        reapplied: false,
      });

      return {
        eventId,
        status: PayrollEventStatus.SUCCEEDED,
        alreadyApplied,
      };
    } catch (error) {
      return await this.handleFailure({
        error,
        eventId,
        employeeId,
        eventType: event.eventType,
        attempt,
        maxAttempts,
        isLastAttempt,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Classifies a failure and records the right terminal (or non-terminal)
   * state.
   *
   * Permanent failures throw UnrecoverableError rather than calling
   * `job.discard()`. Both stop retries, but UnrecoverableError is the better
   * fit here:
   *   - it is an exception, so it propagates naturally out of the nested call
   *     stack (validation is several frames deep) without threading the job
   *     object down to where the decision is made;
   *   - `discard()` mutates the job then still requires a throw to end the
   *     attempt, so the "no more retries" intent lives in two places and can
   *     drift;
   *   - the job lands in `failed` with a clear reason, which is what an
   *     operator inspecting the queue needs to see.
   */
  private async handleFailure(params: {
    error: unknown;
    eventId: string;
    employeeId: string;
    eventType: string;
    attempt: number;
    maxAttempts: number;
    isLastAttempt: boolean;
    durationMs: number;
  }): Promise<never> {
    const {
      error,
      eventId,
      employeeId,
      eventType,
      attempt,
      maxAttempts,
      isLastAttempt,
      durationMs,
    } = params;

    const message = error instanceof Error ? error.message : String(error);
    const code = errorCode(error);
    const retryable = isRetryable(error);
    const violations =
      error instanceof BusinessValidationError ? error.violations : undefined;
    const context =
      error instanceof PayrollProcessingError ? error.context : {};

    if (!retryable) {
      await this.markTerminalFailure(
        eventId,
        PayrollEventStatus.FAILED_PERMANENT,
        message,
        { code, attempt, violations, ...context },
      );

      this.logger.log({
        event: "processing_failed_permanent",
        eventId,
        employeeId,
        eventType,
        attempt,
        maxAttempts,
        durationMs,
        errorCode: code,
        errorMessage: message,
        willRetry: false,
        ...(violations ? { violations } : {}),
      });

      // Stops BullMQ retrying immediately — see the doc comment above.
      throw new UnrecoverableError(message);
    }

    if (isLastAttempt) {
      // Retry budget spent. FAILED_TEMPORARY means "we gave up for now", not
      // "this can never work" — it stays eligible for a manual re-trigger or
      // a scheduled sweep, which is why it is distinct from FAILED_PERMANENT.
      await this.markTerminalFailure(
        eventId,
        PayrollEventStatus.FAILED_TEMPORARY,
        message,
        { code, attempt, exhausted: true, ...context },
      );

      this.logger.log({
        event: "processing_failed_temporary",
        eventId,
        employeeId,
        eventType,
        attempt,
        maxAttempts,
        durationMs,
        errorCode: code,
        errorMessage: message,
        willRetry: false,
        retriesExhausted: true,
      });

      throw error instanceof Error ? error : new Error(message);
    }

    // Retries remain. The row deliberately stays PROCESSING: the attempt is
    // still in flight from the system's point of view, and flapping it to
    // FAILED_TEMPORARY and back would make the audit trail unreadable and
    // break any "how many events are currently failing?" dashboard.
    await this.recordRetryableAttempt(eventId, message, {
      code,
      attempt,
      ...context,
    });

    this.logger.log({
      event: "processing_failed_temporary",
      eventId,
      employeeId,
      eventType,
      attempt,
      maxAttempts,
      durationMs,
      errorCode: code,
      errorMessage: message,
      willRetry: true,
      retriesExhausted: false,
    });

    throw error instanceof Error ? error : new Error(message);
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
   * Validates, calls the provider, and records the effect in the at-most-once
   * ledger.
   *
   * Validation runs BEFORE the ledger check so an invalid payload fails fast
   * without a provider round trip.
   */
  private async applyBusinessEffect(
    request: PayrollGatewayRequest,
  ): Promise<{ result: PayrollGatewayResult; alreadyApplied: boolean }> {
    assertValidPayload(request.eventType, request.payload);

    const existing = await this.prisma.appliedOperation.findUnique({
      where: {
        eventId_operationKey: {
          eventId: request.eventId,
          operationKey: APPLY_OPERATION_KEY,
        },
      },
    });

    if (existing) {
      // The ledger row exists, so a previous delivery already called the
      // provider. Replay the stored result rather than calling again — this
      // is the case where a crash landed BETWEEN the ledger commit and the
      // job ack, so the effect happened but the event never reached SUCCEEDED.
      return {
        result: existing.result as unknown as PayrollGatewayResult,
        alreadyApplied: true,
      };
    }

    const result = await this.gateway.apply(request);
    return { result, alreadyApplied: false };
  }

  /**
   * Commits the ledger row, the SUCCEEDED status and the audit entry in ONE
   * transaction.
   *
   * These three writes must be atomic. Splitting them leaves a crash window in
   * which the effect is recorded as applied but the event still reads
   * PROCESSING (or worse, the event reads SUCCEEDED with no ledger row, so a
   * redelivery would re-call the provider). Committing together means a crash
   * either leaves all three absent — safe to retry from scratch — or all three
   * present, which the terminal-status guard short-circuits.
   *
   * `skipLedger` is set when the ledger row was already written by an earlier
   * delivery; the unique constraint would otherwise reject the insert and roll
   * the whole transaction back.
   */
  private async commitSuccess(
    eventId: string,
    result: PayrollGatewayResult,
    skipLedger: boolean,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (!skipLedger) {
        await tx.appliedOperation.create({
          data: {
            eventId,
            operationKey: APPLY_OPERATION_KEY,
            result: result as never,
          },
        });
      }

      await tx.payrollEvent.update({
        where: { id: eventId },
        data: {
          status: PayrollEventStatus.SUCCEEDED,
          completedAt: new Date(),
          lastError: null,
          nextAttemptAt: null,
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

  /** Records a terminal failure status plus its audit entry. */
  private async markTerminalFailure(
    eventId: string,
    status: PayrollEventStatus,
    message: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollEvent.update({
        where: { id: eventId },
        data: {
          status,
          lastError: message,
          completedAt:
            status === PayrollEventStatus.FAILED_PERMANENT ? new Date() : null,
          version: { increment: 1 },
        },
      });

      await tx.payrollEventHistory.create({
        data: {
          eventId,
          previousStatus: PayrollEventStatus.PROCESSING,
          newStatus: status,
          actor: "worker",
          details: { error: message, ...details } as never,
        },
      });
    });
  }

  /**
   * Records a failed attempt that will be retried.
   *
   * Writes a history row (so every attempt is auditable) and updates
   * `lastError`, but leaves `status` as PROCESSING — see handleFailure.
   */
  private async recordRetryableAttempt(
    eventId: string,
    message: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollEvent.update({
        where: { id: eventId },
        data: { lastError: message, version: { increment: 1 } },
      });

      await tx.payrollEventHistory.create({
        data: {
          eventId,
          previousStatus: PayrollEventStatus.PROCESSING,
          newStatus: PayrollEventStatus.PROCESSING,
          actor: "worker",
          details: { error: message, willRetry: true, ...details } as never,
        },
      });
    });
  }
}
