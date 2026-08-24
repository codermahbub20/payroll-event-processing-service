import {
  ACQUIRE_LOCK,
  ENQUEUE_EVENT,
  RELEASE_LOCK,
  RENEW_LOCK,
  employeeLockKey,
  employeeQueueKey,
  employeeSequenceKey,
} from "@payroll/shared";
import type { Redis } from "ioredis";

/** Default lock TTL. Must exceed the longest expected job duration. */
export const DEFAULT_LOCK_TTL_MS = 30_000;

/** Housekeeping TTL for per-employee keys (24h), refreshed on every enqueue. */
export const DEFAULT_QUEUE_TTL_SECONDS = 86_400;

export interface EmployeeOrderingOptions {
  lockTtlMs?: number;
  queueTtlSeconds?: number;
}

/**
 * Enforces strict FIFO ordering per employee while allowing different
 * employees to run concurrently.
 *
 * The mechanism has two parts:
 *
 *  1. A per-employee FIFO list in Redis, appended at enqueue time. This
 *     records the accepted order independently of BullMQ's delivery order,
 *     which is NOT guaranteed to match under concurrency, retries or backoff.
 *
 *  2. A per-employee lock, held for the duration of a job. A worker may only
 *     process an event when it is at the HEAD of that employee's FIFO list and
 *     the lock is free.
 *
 * A job whose turn has not come is re-queued with a short delay rather than
 * failed, so it does not consume a retry attempt or land in the DLQ for what
 * is a normal scheduling outcome.
 */
export class EmployeeOrdering {
  private readonly lockTtlMs: number;
  private readonly queueTtlSeconds: number;

  constructor(
    private readonly redis: Redis,
    options: EmployeeOrderingOptions = {},
  ) {
    this.lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.queueTtlSeconds = options.queueTtlSeconds ?? DEFAULT_QUEUE_TTL_SECONDS;
  }

  /**
   * Records an event in its employee's FIFO queue. Called by the producer
   * BEFORE the BullMQ job is added, so the accepted order is durable even if
   * the enqueue then fails.
   *
   * Returns the assigned sequence number, or null when the event was already
   * present (an at-least-once redelivery).
   */
  async register(employeeId: string, eventId: string): Promise<number | null> {
    const result = (await this.redis.eval(
      ENQUEUE_EVENT,
      2,
      employeeQueueKey(employeeId),
      employeeSequenceKey(employeeId),
      eventId,
      String(this.queueTtlSeconds),
    )) as number;

    return result === -1 ? null : result;
  }

  /**
   * Attempts to take the ordering lock for an event.
   *
   * Returns true only when this event is at the head of its employee's queue
   * AND the lock was free (or already held by this same event, so a retry is
   * re-entrant rather than self-deadlocking).
   */
  async acquire(employeeId: string, eventId: string): Promise<boolean> {
    const result = (await this.redis.eval(
      ACQUIRE_LOCK,
      2,
      employeeLockKey(employeeId),
      employeeQueueKey(employeeId),
      eventId,
      String(this.lockTtlMs),
    )) as number;

    return result === 1;
  }

  /**
   * Releases the lock and advances the queue. Returns the next event id for
   * this employee, or null when the queue is drained.
   *
   * MUST run even when the job failed — otherwise a single failure blocks
   * every subsequent event for that employee until the TTL expires.
   */
  async release(employeeId: string, eventId: string): Promise<string | null> {
    const next = (await this.redis.eval(
      RELEASE_LOCK,
      2,
      employeeLockKey(employeeId),
      employeeQueueKey(employeeId),
      eventId,
    )) as string | null;

    return next ?? null;
  }

  /** Refreshes the lock TTL for an in-flight job. */
  async renew(employeeId: string, eventId: string): Promise<boolean> {
    const result = (await this.redis.eval(
      RENEW_LOCK,
      1,
      employeeLockKey(employeeId),
      eventId,
      String(this.lockTtlMs),
    )) as number;

    return result === 1;
  }

  /** Current head of an employee's queue — diagnostics and tests. */
  async head(employeeId: string): Promise<string | null> {
    return this.redis.lindex(employeeQueueKey(employeeId), 0);
  }

  /** Pending event ids for an employee, in order — diagnostics and tests. */
  async pending(employeeId: string): Promise<string[]> {
    return this.redis.lrange(employeeQueueKey(employeeId), 0, -1);
  }

  /** Current lock holder, or null — diagnostics and tests. */
  async lockHolder(employeeId: string): Promise<string | null> {
    return this.redis.get(employeeLockKey(employeeId));
  }

  /**
   * Keeps the lock alive for the duration of `work`. A long-running job would
   * otherwise lose its lock to the TTL and let a later event overtake it.
   */
  async withRenewal<T>(
    employeeId: string,
    eventId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const interval = setInterval(
      () => {
        void this.renew(employeeId, eventId).catch(() => {
          /* transient; the next tick retries */
        });
      },
      Math.max(1000, Math.floor(this.lockTtlMs / 3)),
    );

    try {
      return await work();
    } finally {
      clearInterval(interval);
    }
  }
}
