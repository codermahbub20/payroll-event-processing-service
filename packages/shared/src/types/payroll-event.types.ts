import { PayrollEventStatus } from "../enums/event-status.enum";
import { PayrollEventType } from "../enums/payroll-event-type.enum";

/**
 * Type-specific payload shapes stored in `payroll_events.payload` (jsonb).
 *
 * `employeeId` and `effectiveDate` are common to every event type and live as
 * real columns on `payroll_events`, so they are deliberately absent here.
 */
export interface BankAccountChangePayload {
  iban: string;
}

export interface AddressChangePayload {
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface SalaryChangePayload {
  newSalary: number;
  currency: string;
}

/** Discriminated union linking each event type to its payload. */
export type PayrollEventPayloadMap = {
  [PayrollEventType.BANK_ACCOUNT_CHANGE]: BankAccountChangePayload;
  [PayrollEventType.ADDRESS_CHANGE]: AddressChangePayload;
  [PayrollEventType.SALARY_CHANGE]: SalaryChangePayload;
};

export type PayrollEventPayload =
  PayrollEventPayloadMap[keyof PayrollEventPayloadMap];

/** The core event record, mirroring the `payroll_events` table. */
export interface PayrollEvent<T extends PayrollEventType = PayrollEventType> {
  id: string;
  eventType: T;
  employeeId: string;
  effectiveDate: string;
  payload: PayrollEventPayloadMap[T];
  status: PayrollEventStatus;
  idempotencyKey: string;
  version: number;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedProcessingAt: string | null;
  completedAt: string | null;
}

/** A single row of the append-only audit log. */
export interface PayrollEventHistoryEntry {
  id: string;
  eventId: string;
  previousStatus: PayrollEventStatus | null;
  newStatus: PayrollEventStatus;
  details: Record<string, unknown> | null;
  actor: string | null;
  createdAt: string;
}

/** A row in the at-most-once effects ledger. */
export interface AppliedOperationRecord {
  id: string;
  eventId: string;
  operationKey: string;
  result: Record<string, unknown> | null;
  appliedAt: string;
}
