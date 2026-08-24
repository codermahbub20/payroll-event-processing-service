import type { BaseLogFields } from "@payroll/shared";

/**
 * Worker-side view of the shared structured logger.
 *
 * The implementation lives in @payroll/shared so the API and worker emit
 * identical field names; this module only adds the worker's processing-event
 * vocabulary on top.
 */
export {
  StructuredLogger,
  type LogLevel,
  type StructuredLoggerOptions,
} from "@payroll/shared";

export type ProcessingLogEvent =
  | "processing_started"
  | "processing_succeeded"
  | "processing_failed_temporary"
  | "processing_failed_permanent"
  | "processing_deferred"
  | "processing_skipped"
  /** A redelivered event whose effect was already applied. */
  | "duplicate_delivery_skipped"
  /** Recovery sweep found an event stuck in PROCESSING. */
  | "stuck_event_recovered";

export interface ProcessingLogFields extends BaseLogFields {
  event: ProcessingLogEvent;
  eventId: string;
  employeeId: string;
  eventType?: string;
  /** 1-based attempt number for this job. */
  attempt?: number;
  maxAttempts?: number;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  /** True when retries remain; false when the budget is exhausted. */
  willRetry?: boolean;
  confirmationId?: string;
  violations?: string[];
}
