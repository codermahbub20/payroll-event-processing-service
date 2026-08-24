import type { PayrollEventStatus, PayrollEventType } from "@payroll/shared";

/**
 * Response shapes, mirroring the DTOs in docs/openapi.json.
 *
 * The enums come from @payroll/shared rather than being redeclared here, so a
 * new event type or status added to the backend is a compile error in the UI
 * instead of a silently unhandled value at runtime.
 */

export interface EventSummary {
  id: string;
  eventType: PayrollEventType;
  employeeId: string;
  /** Calendar date, YYYY-MM-DD. */
  effectiveDate: string;
  status: PayrollEventStatus;
  createdAt: string;
  updatedAt: string;
  startedProcessingAt: string | null;
  completedAt: string | null;
  attemptCount: number;
}

export interface EventHistoryEntry {
  id: string;
  previousStatus: PayrollEventStatus | null;
  newStatus: PayrollEventStatus;
  details: Record<string, unknown> | null;
  actor: string | null;
  createdAt: string;
}

export interface EventDetail extends EventSummary {
  payload: Record<string, unknown>;
  idempotencyKey: string;
  lastError: string | null;
  nextAttemptAt: string | null;
  /** Most recent failing transition, or null. */
  failure: EventHistoryEntry | null;
  /** Most recent succeeding transition, or null. */
  result: EventHistoryEntry | null;
  history: EventHistoryEntry[];
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PaginatedEvents {
  data: EventSummary[];
  meta: PaginationMeta;
}

export interface SubmitEventResponse {
  id: string;
  status: PayrollEventStatus;
  /** True when the idempotency key was already known. */
  duplicate: boolean;
}

export interface ListEventsQuery {
  employeeId?: string;
  status?: PayrollEventStatus;
  eventType?: PayrollEventType;
  page?: number;
  pageSize?: number;
}

/** The API's uniform error body. */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  timestamp?: string;
  path?: string;
  details?: string[];
}
