/**
 * Failure taxonomy for payroll processing.
 *
 * The distinction is operational, not cosmetic: a temporary failure is worth
 * retrying automatically, a permanent one never will be. Retrying a permanent
 * failure burns queue capacity and delays valid work behind it; giving up on a
 * temporary one silently drops a legitimate payroll change.
 */

/** Base class carrying the retry classification. */
export abstract class PayrollProcessingError extends Error {
  abstract readonly retryable: boolean;
  /** Stable machine-readable code for logs and history `details`. */
  abstract readonly code: string;

  constructor(
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
    // Required when targeting ES5-era prototypes; harmless otherwise and keeps
    // `instanceof` working through the class hierarchy.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The request was well-formed but the downstream system could not serve it
 * right now — timeout, 503, connection reset. Retrying may well succeed.
 */
export class TemporaryProcessingError extends PayrollProcessingError {
  readonly retryable = true;
  readonly code: string;

  constructor(
    message: string,
    code = "DOWNSTREAM_UNAVAILABLE",
    context: Record<string, unknown> = {},
  ) {
    super(message, context);
    this.code = code;
  }
}

/**
 * The request will never succeed as submitted — invalid business data, or the
 * downstream system rejecting it outright (employee not found, account
 * closed). No amount of retrying changes the outcome.
 */
export class PermanentProcessingError extends PayrollProcessingError {
  readonly retryable = false;
  readonly code: string;

  constructor(
    message: string,
    code = "NON_RETRYABLE",
    context: Record<string, unknown> = {},
  ) {
    super(message, context);
    this.code = code;
  }
}

/**
 * Business validation failed. Always permanent: the payload is stored in the
 * event row and does not change between attempts, so a validation failure is
 * deterministic.
 */
export class BusinessValidationError extends PermanentProcessingError {
  constructor(
    message: string,
    readonly violations: string[],
    context: Record<string, unknown> = {},
  ) {
    super(message, "BUSINESS_VALIDATION_FAILED", { ...context, violations });
  }
}

/** True when the error explicitly declares itself retryable. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof PayrollProcessingError) {
    return error.retryable;
  }
  // Unknown errors are treated as retryable. An unrecognised crash is more
  // likely a transient infrastructure fault than a permanent data problem,
  // and the retry budget bounds the cost of being wrong. Failing permanently
  // on an unknown error would discard recoverable work.
  return true;
}

/** Extracts a stable error code for logging and audit details. */
export function errorCode(error: unknown): string {
  if (error instanceof PayrollProcessingError) return error.code;
  return "UNKNOWN_ERROR";
}
