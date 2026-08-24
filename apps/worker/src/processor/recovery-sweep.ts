import { PrismaClient } from "@payroll/database";
import { EmployeeOrdering, PayrollEventProducer } from "@payroll/queue";
import { PayrollEventStatus } from "@payroll/shared";
import { StructuredLogger } from "../processing/structured-logger";

/** Events stuck in PROCESSING longer than this are considered abandoned. */
export const DEFAULT_STUCK_TIMEOUT_MS = 5 * 60_000;

/** How often the sweep runs when scheduled. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Cap per pass. A sweep that tries to recover 100k rows at once would hold a
 * long transaction and flood the queue; recovering in bounded batches lets
 * normal traffic keep flowing.
 */
export const DEFAULT_SWEEP_BATCH_SIZE = 100;

export interface RecoverySweepOptions {
  stuckTimeoutMs?: number;
  batchSize?: number;
  logger?: StructuredLogger;
  /** Injectable clock, so tests do not have to wait real minutes. */
  now?: () => Date;
}

export interface SweepResult {
  scanned: number;
  reEnqueued: number;
  markedFailed: number;
}

/**
 * Finds events abandoned in PROCESSING and returns them to the queue.
 *
 * BullMQ's stalled-job detection already covers the common case: a worker dies
 * and another picks the job up within ~lockDuration + stalledInterval. This
 * sweep exists for the cases BullMQ *cannot* see:
 *
 *   - the job exhausted `maxStalledCount` and was dropped from the queue;
 *   - Redis lost its data (restart without persistence, failover, eviction),
 *     so the job record no longer exists at all;
 *   - the API committed the event but crashed before enqueueing it — the row
 *     is PENDING/PROCESSING with no job anywhere.
 *
 * In all of those, Postgres still holds the truth and the queue does not.
 *
 * ## Why re-enqueue rather than mark FAILED_TEMPORARY
 *
 * The chosen behaviour is to RE-ENQUEUE, and to mark FAILED_TEMPORARY only
 * when an event has already been recovered too many times.
 *
 * A stuck event is not evidence of a bad event — it is evidence of a dead
 * worker. The event itself may be perfectly valid and simply unlucky in which
 * process picked it up. Marking it FAILED_TEMPORARY would push a recoverable
 * event into a state requiring human attention, which at any scale means an
 * on-call queue full of events whose only fault was a rolling deploy.
 *
 * Re-enqueueing is safe precisely because of the idempotency guarantees:
 * the terminal-status check and the applied_operations ledger mean a
 * redelivered event either short-circuits or resumes without re-applying its
 * effect. Without those, re-enqueueing would risk double payment and marking
 * FAILED_TEMPORARY would be the only responsible option.
 *
 * The attempt ceiling stops the pathological case: an event that repeatedly
 * kills its worker would otherwise be re-enqueued forever, taking a worker
 * down each time. After `maxRecoveryAttempts` it is parked in
 * FAILED_TEMPORARY — still re-triggerable by an operator, but no longer
 * cycling on its own.
 */
export class RecoverySweep {
  private readonly stuckTimeoutMs: number;
  private readonly batchSize: number;
  private readonly logger: StructuredLogger;
  private readonly now: () => Date;

  /** Beyond this many total attempts, stop auto-recovering. */
  static readonly MAX_RECOVERY_ATTEMPTS = 10;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly producer: PayrollEventProducer,
    private readonly ordering: EmployeeOrdering,
    options: RecoverySweepOptions = {},
  ) {
    this.stuckTimeoutMs = options.stuckTimeoutMs ?? DEFAULT_STUCK_TIMEOUT_MS;
    this.batchSize = options.batchSize ?? DEFAULT_SWEEP_BATCH_SIZE;
    this.logger = options.logger ?? new StructuredLogger();
    this.now = options.now ?? (() => new Date());
  }

  async run(): Promise<SweepResult> {
    const cutoff = new Date(this.now().getTime() - this.stuckTimeoutMs);

    // `startedProcessingAt` is the marker: set when a worker claims the event,
    // so a row still PROCESSING with an old timestamp was abandoned. The
    // (status) index backs this query.
    const stuck = await this.prisma.payrollEvent.findMany({
      where: {
        status: PayrollEventStatus.PROCESSING,
        startedProcessingAt: { lt: cutoff },
      },
      orderBy: { startedProcessingAt: "asc" },
      take: this.batchSize,
      select: {
        id: true,
        employeeId: true,
        eventType: true,
        attemptCount: true,
        startedProcessingAt: true,
      },
    });

    const result: SweepResult = {
      scanned: stuck.length,
      reEnqueued: 0,
      markedFailed: 0,
    };

    for (const event of stuck) {
      const stuckForMs = event.startedProcessingAt
        ? this.now().getTime() - event.startedProcessingAt.getTime()
        : 0;

      if (event.attemptCount >= RecoverySweep.MAX_RECOVERY_ATTEMPTS) {
        await this.parkAsFailedTemporary(event.id, event.attemptCount);
        result.markedFailed += 1;

        this.logger.log({
          event: "stuck_event_recovered",
          eventId: event.id,
          employeeId: event.employeeId,
          eventType: event.eventType,
          action: "marked_failed_temporary",
          reason: "recovery_attempts_exhausted",
          attempt: event.attemptCount,
          stuckForMs,
        });
        continue;
      }

      await this.reEnqueue(event.id, event.employeeId);
      result.reEnqueued += 1;

      this.logger.log({
        event: "stuck_event_recovered",
        eventId: event.id,
        employeeId: event.employeeId,
        eventType: event.eventType,
        action: "re_enqueued",
        attempt: event.attemptCount,
        stuckForMs,
      });
    }

    return result;
  }

  /**
   * Returns an abandoned event to PENDING and re-queues it.
   *
   * The dead worker may still hold the employee's ordering lock, so it is
   * released first — otherwise the re-enqueued job would defer forever waiting
   * for a worker that no longer exists. (The lock also has a TTL, but the
   * sweep should not have to wait for it.)
   */
  private async reEnqueue(eventId: string, employeeId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollEvent.update({
        where: { id: eventId },
        data: {
          status: PayrollEventStatus.PENDING,
          startedProcessingAt: null,
          version: { increment: 1 },
        },
      });

      await tx.payrollEventHistory.create({
        data: {
          eventId,
          previousStatus: PayrollEventStatus.PROCESSING,
          newStatus: PayrollEventStatus.PENDING,
          actor: "recovery-sweep",
          details: {
            reason: "stuck_in_processing",
            action: "re_enqueued",
          } as never,
        },
      });
    });

    await this.ordering.release(employeeId, eventId);
    await this.producer.enqueue(eventId, employeeId);
  }

  /** Parks an event that has been recovered too many times. */
  private async parkAsFailedTemporary(
    eventId: string,
    attemptCount: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollEvent.update({
        where: { id: eventId },
        data: {
          status: PayrollEventStatus.FAILED_TEMPORARY,
          lastError: `abandoned in PROCESSING after ${attemptCount} attempts`,
          version: { increment: 1 },
        },
      });

      await tx.payrollEventHistory.create({
        data: {
          eventId,
          previousStatus: PayrollEventStatus.PROCESSING,
          newStatus: PayrollEventStatus.FAILED_TEMPORARY,
          actor: "recovery-sweep",
          details: {
            reason: "recovery_attempts_exhausted",
            attemptCount,
          } as never,
        },
      });
    });
  }
}

/**
 * Runs a sweep on an interval.
 *
 * Scheduled in-process rather than as a queued job: the sweep's whole purpose
 * is to recover from a queue that may itself be empty or lost, so making it
 * depend on that queue would defeat it. It is idempotent and cheap, so several
 * worker replicas running it concurrently is harmless — the row update is the
 * serialisation point.
 */
export class ScheduledRecoverySweep {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly sweep: RecoverySweep,
    private readonly intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
    private readonly onError?: (error: unknown) => void,
  ) {}

  /** Runs immediately (catching startup leftovers), then on the interval. */
  async start(): Promise<SweepResult> {
    const first = await this.sweep.run();

    this.timer = setInterval(() => {
      void this.sweep.run().catch((error) => {
        this.onError?.(error);
      });
    }, this.intervalMs);

    // Do not hold the process open purely for the sweep.
    this.timer.unref?.();

    return first;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
