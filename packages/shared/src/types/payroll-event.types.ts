import { EventStatus } from "../enums/event-status.enum";
import { PayrollEventType } from "../enums/payroll-event-type.enum";

export interface PayrollEvent<TPayload = Record<string, unknown>> {
  id: string;
  type: PayrollEventType;
  status: EventStatus;
  payload: TPayload;
  createdAt: string;
  updatedAt: string;
}
