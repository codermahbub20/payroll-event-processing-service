/**
 * Kinds of payroll change an employee can submit.
 * Mirrors the `payroll_event_type` Postgres enum in packages/database.
 */
export enum PayrollEventType {
  BANK_ACCOUNT_CHANGE = "BANK_ACCOUNT_CHANGE",
  ADDRESS_CHANGE = "ADDRESS_CHANGE",
  SALARY_CHANGE = "SALARY_CHANGE",
}
