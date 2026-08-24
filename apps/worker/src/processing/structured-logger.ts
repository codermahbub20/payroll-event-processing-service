/**
 * Structured JSON logging for the processing lifecycle.
 *
 * One line per event, machine-parseable, so a log aggregator can answer
 * "which events failed permanently today, and why?" without regex-scraping
 * prose. Written straight to stdout rather than through Nest's Logger, whose
 * default formatter would wrap the JSON in ANSI colour codes and a prefix.
 */

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

export interface ProcessingLogFields {
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
  [key: string]: unknown;
}

export interface StructuredLoggerOptions {
  /** Injectable sink so tests can capture lines instead of writing stdout. */
  write?: (line: string) => void;
  service?: string;
}

export class StructuredLogger {
  private readonly write: (line: string) => void;
  private readonly service: string;

  constructor(options: StructuredLoggerOptions = {}) {
    // eslint-disable-next-line no-console
    this.write = options.write ?? ((line) => console.log(line));
    this.service = options.service ?? "payroll-worker";
  }

  log(fields: ProcessingLogFields): void {
    const level =
      fields.event === "processing_failed_permanent"
        ? "error"
        : fields.event === "processing_failed_temporary"
          ? "warn"
          : "info";

    this.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        service: this.service,
        ...fields,
      }),
    );
  }
}
