import { PayrollEventType } from "../enums/payroll-event-type.enum";
import { PayrollEventPayloadMap } from "../types/payroll-event.types";

/**
 * Request body for submitting a payroll event.
 *
 * The idempotency key travels in the `Idempotency-Key` HTTP header rather
 * than the body, so a client retrying a request reuses the header verbatim
 * without having to reserialize the payload.
 */
export interface CreatePayrollEventDto<
  T extends PayrollEventType = PayrollEventType,
> {
  eventType: T;
  employeeId: string;
  /** ISO-8601 date (YYYY-MM-DD) the change takes effect. */
  effectiveDate: string;
  payload: PayrollEventPayloadMap[T];
}
