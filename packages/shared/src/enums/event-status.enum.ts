/**
 * Lifecycle of a payroll event.
 * Mirrors the `payroll_event_status` Postgres enum in packages/database.
 *
 * PENDING          -> accepted, not yet picked up
 * PROCESSING       -> claimed by a worker
 * SUCCEEDED        -> terminal, business effect applied exactly once
 * FAILED_TEMPORARY -> retryable (timeout, downstream 5xx); will be re-attempted
 * FAILED_PERMANENT -> terminal, needs human intervention (validation, 4xx)
 */
export enum PayrollEventStatus {
  PENDING = "PENDING",
  PROCESSING = "PROCESSING",
  SUCCEEDED = "SUCCEEDED",
  FAILED_TEMPORARY = "FAILED_TEMPORARY",
  FAILED_PERMANENT = "FAILED_PERMANENT",
}

/** Statuses from which no further transition occurs. */
export const TERMINAL_EVENT_STATUSES: readonly PayrollEventStatus[] = [
  PayrollEventStatus.SUCCEEDED,
  PayrollEventStatus.FAILED_PERMANENT,
] as const;

export function isTerminalStatus(status: PayrollEventStatus): boolean {
  return TERMINAL_EVENT_STATUSES.includes(status);
}
