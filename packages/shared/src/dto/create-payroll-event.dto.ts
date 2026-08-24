import { PayrollEventType } from "../enums/payroll-event-type.enum";

export class CreatePayrollEventDto {
  type!: PayrollEventType;
  payload!: Record<string, unknown>;
}
