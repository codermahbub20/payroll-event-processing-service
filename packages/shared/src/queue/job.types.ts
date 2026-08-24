/**
 * Job contract shared by the API (producer) and worker (consumer).
 *
 * Keeping this in @payroll/shared means a change to the payload shape breaks
 * the build on both sides rather than surfacing as a runtime deserialisation
 * failure in production.
 */

/** Name of the queue carrying payroll events to the worker. */
export const PAYROLL_EVENT_QUEUE = "payroll-events";

/**
 * Job payload.
 *
 * Deliberately minimal: the worker re-reads the authoritative row from
 * Postgres rather than trusting job data, which could be stale if the event
 * changed after enqueue. `employeeId` is carried anyway because the ordering
 * lock must be acquired BEFORE any database read.
 */
export interface PayrollEventJobData {
  eventId: string;
  /** Partition key for per-employee ordering. */
  employeeId: string;
  /**
   * Monotonic sequence within an employee, assigned at enqueue time. Lets the
   * worker detect out-of-order delivery rather than silently processing it.
   */
  sequence?: number;
}

/** Result returned by a completed job, surfaced in BullMQ's job record. */
export interface PayrollEventJobResult {
  eventId: string;
  status: string;
  /** True when the job exited early because the effect was already applied. */
  alreadyApplied?: boolean;
}

/** Redis key holding the FIFO queue of pending event ids for one employee. */
export function employeeQueueKey(employeeId: string): string {
  return `payroll:employee:${employeeId}:queue`;
}

/** Redis key holding the current lock holder for one employee. */
export function employeeLockKey(employeeId: string): string {
  return `payroll:employee:${employeeId}:lock`;
}

/** Redis key holding the monotonic sequence counter for one employee. */
export function employeeSequenceKey(employeeId: string): string {
  return `payroll:employee:${employeeId}:seq`;
}
