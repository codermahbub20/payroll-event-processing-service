import type {
  ApiErrorBody,
  EventDetail,
  ListEventsQuery,
  PaginatedEvents,
  SubmitEventResponse,
} from "./types";

/**
 * All API calls go through the /api prefix, which the Vite dev server and the
 * production nginx config both strip before forwarding. The prefix keeps the
 * SPA's own /events routes distinct from the API's, so a browser navigation to
 * /events renders the app rather than returning JSON.
 *
 * VITE_API_BASE_URL overrides it for a deployment serving the two on different
 * hosts.
 */
// `||` rather than `??`: the Docker build sets VITE_API_BASE_URL="" by default,
// and an empty string must fall back to "/api" too. With `??` it would not,
// sending requests to bare /events — which the SPA router owns, so they would
// return index.html instead of JSON.
const BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";

/**
 * Error carrying the API's structured body, so callers can render field-level
 * `details` instead of a generic "request failed".
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message || `Request failed with status ${statusCode}`);
    this.name = "ApiError";
  }

  /** Field-level validation failures, when the API supplied them. */
  get details(): string[] {
    return this.body.details ?? [];
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (cause) {
    // fetch only rejects on network failure, so this is "API unreachable"
    // rather than an HTTP error — worth saying explicitly.
    throw new ApiError(0, {
      statusCode: 0,
      error: "Network Error",
      message:
        "Could not reach the API. Is it running on http://localhost:3000?",
    });
  }

  if (!response.ok) {
    // A non-JSON error body (a proxy 502, say) must not mask the real status.
    const body = await response
      .json()
      .catch(() => ({
        statusCode: response.status,
        error: response.statusText,
        message: `Request failed with status ${response.status}`,
      }));
    throw new ApiError(response.status, body as ApiErrorBody);
  }

  return (await response.json()) as T;
}

export interface SubmitEventInput {
  eventType: string;
  employeeId: string;
  effectiveDate: string;
  payload: Record<string, unknown>;
  /** Optional client-supplied dedup key. */
  idempotencyKey?: string;
}

export async function submitEvent(
  input: SubmitEventInput,
): Promise<SubmitEventResponse> {
  const { idempotencyKey, ...body } = input;

  return request<SubmitEventResponse>("/events", {
    method: "POST",
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
    body: JSON.stringify(body),
  });
}

export async function listEvents(
  query: ListEventsQuery = {},
): Promise<PaginatedEvents> {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    // Empty filters must be omitted, not sent as "", which the API would
    // reject as a malformed UUID or unknown enum value.
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }

  const qs = params.toString();
  return request<PaginatedEvents>(`/events${qs ? `?${qs}` : ""}`);
}

export async function getEvent(id: string): Promise<EventDetail> {
  return request<EventDetail>(`/events/${encodeURIComponent(id)}`);
}
