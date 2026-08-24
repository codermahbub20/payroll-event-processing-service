import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";
import { ApiError, listEvents } from "../api/client";
import { EVENT_TYPE_LABELS } from "../api/event-forms";
import type { PaginatedEvents } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { formatDateTime, formatRelative, shortId } from "../format";

const PAGE_SIZE = 20;

/**
 * Filters live in the URL rather than component state, so a filtered view is
 * shareable and survives a refresh or a back-navigation from the detail page.
 */
export function EventsListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const employeeId = searchParams.get("employeeId") ?? "";
  const status = searchParams.get("status") ?? "";
  const eventType = searchParams.get("eventType") ?? "";
  const page = Number(searchParams.get("page") ?? "1");

  const [result, setResult] = useState<PaginatedEvents | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  // Local mirror so typing an employee ID does not refetch on every keystroke.
  const [employeeInput, setEmployeeInput] = useState(employeeId);
  useEffect(() => setEmployeeInput(employeeId), [employeeId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listEvents({
        employeeId: employeeId || undefined,
        status: (status as PayrollEventStatus) || undefined,
        eventType: (eventType as PayrollEventType) || undefined,
        page: Number.isFinite(page) && page > 0 ? page : 1,
        pageSize: PAGE_SIZE,
      });
      setResult(next);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, {
              statusCode: 0,
              error: "Error",
              message: String(cause),
            }),
      );
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [employeeId, status, eventType, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateParams(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // Any filter change invalidates the current page number.
    if (!("page" in changes)) next.delete("page");
    setSearchParams(next);
  }

  const events = result?.data ?? [];
  const meta = result?.meta;

  return (
    <>
      <h2 className="page-title">Submitted events</h2>
      <p className="page-subtitle">
        Newest first. Select a row to see its full detail and live status.
      </p>

      <div className="toolbar">
        <div className="field">
          <label htmlFor="filter-employee">Employee ID</label>
          <input
            id="filter-employee"
            className="mono"
            placeholder="Filter by UUID"
            value={employeeInput}
            onChange={(e) => setEmployeeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                updateParams({ employeeId: employeeInput.trim() });
              }
            }}
            onBlur={() => updateParams({ employeeId: employeeInput.trim() })}
          />
        </div>

        <div className="field">
          <label htmlFor="filter-status">Status</label>
          <select
            id="filter-status"
            value={status}
            onChange={(e) => updateParams({ status: e.target.value })}
          >
            <option value="">All statuses</option>
            {Object.values(PayrollEventStatus).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="filter-type">Event type</label>
          <select
            id="filter-type"
            value={eventType}
            onChange={(e) => updateParams({ eventType: e.target.value })}
          >
            <option value="">All types</option>
            {Object.values(PayrollEventType).map((value) => (
              <option key={value} value={value}>
                {EVENT_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <button type="button" className="secondary" onClick={() => void load()}>
          Refresh
        </button>

        {(employeeId || status || eventType) && (
          <button
            type="button"
            className="secondary"
            onClick={() => setSearchParams(new URLSearchParams())}
          >
            Clear filters
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <strong>{error.message}</strong>
          {error.details.length > 0 && (
            <ul>
              {error.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card">
        {loading && !result ? (
          <div className="empty">Loading…</div>
        ) : events.length === 0 ? (
          <div className="empty">
            {employeeId || status || eventType
              ? "No events match these filters."
              : "No events yet. Submit one to get started."}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th>Event ID</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr
                    key={event.id}
                    tabIndex={0}
                    role="link"
                    aria-label={`Open event ${event.id}`}
                    onClick={() => navigate(`/events/${event.id}`)}
                    onKeyDown={(e) => {
                      // Rows are interactive, so they must work from the
                      // keyboard too, not just the mouse.
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/events/${event.id}`);
                      }
                    }}
                  >
                    <td>
                      <span className="mono truncate" title={event.employeeId}>
                        {event.employeeId}
                      </span>
                    </td>
                    <td>{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</td>
                    <td>
                      <StatusBadge status={event.status} />
                    </td>
                    <td title={formatDateTime(event.createdAt)}>
                      {formatRelative(event.createdAt)}
                    </td>
                    <td>
                      <span className="mono" title={event.id}>
                        {shortId(event.id)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {meta && meta.total > 0 && (
          <div className="pagination">
            <button
              type="button"
              className="secondary"
              disabled={!meta.hasPreviousPage}
              onClick={() => updateParams({ page: String(meta.page - 1) })}
            >
              Previous
            </button>
            <span className="muted">
              Page {meta.page} of {meta.totalPages} · {meta.total} event
              {meta.total === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={!meta.hasNextPage}
              onClick={() => updateParams({ page: String(meta.page + 1) })}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}
