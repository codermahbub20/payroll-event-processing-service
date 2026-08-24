import { PayrollEventStatus } from "@payroll/shared";

/**
 * Colour mapping, per the assignment:
 *   PENDING = gray, PROCESSING = blue, SUCCEEDED = green,
 *   FAILED_TEMPORARY = orange, FAILED_PERMANENT = red.
 *
 * The temporary/permanent split is deliberately orange vs red: a temporary
 * failure will be retried and may still succeed, whereas a permanent one needs
 * a human. Showing both in red would hide that distinction.
 */
const CLASS_BY_STATUS: Record<PayrollEventStatus, string> = {
  [PayrollEventStatus.PENDING]: "badge-pending",
  [PayrollEventStatus.PROCESSING]: "badge-processing",
  [PayrollEventStatus.SUCCEEDED]: "badge-succeeded",
  [PayrollEventStatus.FAILED_TEMPORARY]: "badge-failed-temporary",
  [PayrollEventStatus.FAILED_PERMANENT]: "badge-failed-permanent",
};

const LABEL_BY_STATUS: Record<PayrollEventStatus, string> = {
  [PayrollEventStatus.PENDING]: "Pending",
  [PayrollEventStatus.PROCESSING]: "Processing",
  [PayrollEventStatus.SUCCEEDED]: "Succeeded",
  [PayrollEventStatus.FAILED_TEMPORARY]: "Failed (retryable)",
  [PayrollEventStatus.FAILED_PERMANENT]: "Failed (permanent)",
};

export function StatusBadge({ status }: { status: PayrollEventStatus }) {
  // An unrecognised status (backend ahead of frontend) still renders its raw
  // value rather than an empty badge.
  const className = CLASS_BY_STATUS[status] ?? "badge-pending";
  const label = LABEL_BY_STATUS[status] ?? status;

  return (
    <span className={`badge ${className}`} title={status}>
      {label}
    </span>
  );
}
