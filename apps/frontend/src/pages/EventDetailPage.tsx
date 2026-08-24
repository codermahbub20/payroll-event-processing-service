import { Link, useParams } from "react-router-dom";
import { PayrollEventStatus } from "@payroll/shared";
import { EVENT_TYPE_LABELS } from "../api/event-forms";
import type { EventHistoryEntry } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { POLL_INTERVAL_MS, usePolledEvent } from "../hooks/usePolledEvent";
import {
  durationMs,
  formatCalendarDate,
  formatDateTime,
  formatDuration,
} from "../format";

export function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { event, error, loading, polling, refresh } = usePolledEvent(id);

  if (loading) {
    return <div className="card empty">Loading event…</div>;
  }

  if (error) {
    const notFound = error.statusCode === 404;
    return (
      <>
        <div className="alert alert-error" role="alert">
          <strong>{notFound ? "Event not found" : error.message}</strong>
          {notFound && (
            <div style={{ marginTop: 4 }}>
              No event exists with ID <span className="mono">{id}</span>.
            </div>
          )}
        </div>
        <Link to="/events">&larr; Back to all events</Link>
      </>
    );
  }

  if (!event) return null;

  const processingTime = durationMs(
    event.startedProcessingAt,
    event.completedAt,
  );
  const queueTime = durationMs(event.createdAt, event.startedProcessingAt);

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          marginBottom: 4,
        }}
      >
        <div>
          <h2 className="page-title">
            {EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}
          </h2>
          <p className="page-subtitle mono" style={{ marginBottom: 0 }}>
            {event.id}
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <StatusBadge status={event.status} />
          {polling && (
            <div className="polling" style={{ marginTop: 8 }}>
              <span className="pulse" aria-hidden="true" />
              <span>Live · refreshing every {POLL_INTERVAL_MS / 1000}s</span>
            </div>
          )}
        </div>
      </div>

      <p style={{ marginTop: 12, marginBottom: 20 }}>
        <Link to="/events">&larr; All events</Link>
      </p>

      {/*
        Terminal-state banners. Surfaced above the fold because "what happened
        and why" is the first question on this page — the reviewer should not
        have to read the timeline to find it.
      */}
      {event.status === PayrollEventStatus.SUCCEEDED && event.result && (
        <div className="alert alert-success">
          <strong>Processed successfully</strong>
          <ResultDetails entry={event.result} />
        </div>
      )}

      {event.status === PayrollEventStatus.FAILED_PERMANENT && (
        <div className="alert alert-error">
          <strong>Permanently failed — will not be retried</strong>
          <div style={{ marginTop: 4 }}>
            {event.lastError ?? "No error message recorded."}
          </div>
          <div style={{ marginTop: 6, fontSize: 13 }}>
            This needs a correction and a fresh submission; retrying the same
            data cannot succeed.
          </div>
        </div>
      )}

      {event.status === PayrollEventStatus.FAILED_TEMPORARY && (
        <div
          className="alert"
          style={{
            background: "#fffaeb",
            borderColor: "#fedf89",
            color: "#b54708",
          }}
        >
          <strong>
            Failed after {event.attemptCount} attempt
            {event.attemptCount === 1 ? "" : "s"} — retryable
          </strong>
          <div style={{ marginTop: 4 }}>
            {event.lastError ?? "No error message recorded."}
          </div>
          <div style={{ marginTop: 6, fontSize: 13 }}>
            The automatic retry budget is spent, but this event can still be
            re-triggered.
          </div>
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Details</h3>
        <dl className="detail-grid">
          <dt>Employee</dt>
          <dd>
            <Link
              to={`/events?employeeId=${encodeURIComponent(event.employeeId)}`}
              className="mono"
            >
              {event.employeeId}
            </Link>
          </dd>

          <dt>Event type</dt>
          <dd>{event.eventType}</dd>

          <dt>Effective date</dt>
          <dd>{formatCalendarDate(event.effectiveDate)}</dd>

          <dt>Status</dt>
          <dd>
            <StatusBadge status={event.status} />
          </dd>

          <dt>Attempts</dt>
          <dd>{event.attemptCount}</dd>

          <dt>Idempotency key</dt>
          <dd className="mono" style={{ wordBreak: "break-all" }}>
            {event.idempotencyKey}
          </dd>
        </dl>
      </div>

      <div className="card">
        <h3 className="card-title">Timestamps</h3>
        <dl className="detail-grid">
          <dt>Submitted</dt>
          <dd>{formatDateTime(event.createdAt)}</dd>

          <dt>Started processing</dt>
          <dd>
            {formatDateTime(event.startedProcessingAt)}
            {queueTime !== null && (
              <span className="muted"> · waited {formatDuration(queueTime)}</span>
            )}
          </dd>

          <dt>Completed</dt>
          <dd>
            {formatDateTime(event.completedAt)}
            {processingTime !== null && (
              <span className="muted">
                {" "}
                · took {formatDuration(processingTime)}
              </span>
            )}
          </dd>

          {event.nextAttemptAt && (
            <>
              <dt>Next attempt</dt>
              <dd>{formatDateTime(event.nextAttemptAt)}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="card">
        <h3 className="card-title">Payload</h3>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
      </div>

      <div className="card">
        <h3 className="card-title">
          Status timeline ({event.history.length})
        </h3>
        {event.history.length === 0 ? (
          <div className="muted">No transitions recorded yet.</div>
        ) : (
          <ul className="timeline">
            {event.history.map((entry) => (
              <li key={entry.id}>
                <span className="timeline-time">
                  {formatDateTime(entry.createdAt)}
                </span>
                <span className="row-gap" style={{ flexWrap: "wrap" }}>
                  {entry.previousStatus && (
                    <>
                      <span className="muted">{entry.previousStatus}</span>
                      <span className="muted">&rarr;</span>
                    </>
                  )}
                  <StatusBadge status={entry.newStatus} />
                  {entry.actor && (
                    <span className="muted" style={{ fontSize: 13 }}>
                      by {entry.actor}
                    </span>
                  )}
                  {entry.details && <TransitionDetails details={entry.details} />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <button type="button" className="secondary" onClick={refresh}>
          Refresh now
        </button>
      </div>
    </>
  );
}

/** Renders the provider's confirmation from a SUCCEEDED transition. */
function ResultDetails({ entry }: { entry: EventHistoryEntry }) {
  const details = entry.details ?? {};
  const confirmationId = details.confirmationId;
  const appliedAt = details.appliedAt;

  return (
    <div style={{ marginTop: 6, fontSize: 14 }}>
      {typeof confirmationId === "string" && (
        <div>
          Confirmation: <span className="mono">{confirmationId}</span>
        </div>
      )}
      {typeof appliedAt === "string" && (
        <div>Applied at {formatDateTime(appliedAt)}</div>
      )}
    </div>
  );
}

/**
 * Compact inline summary of a transition's `details` jsonb.
 *
 * Prefers the error message when present — on a failed attempt that is the one
 * thing worth reading — and falls back to raw JSON for anything unrecognised.
 */
function TransitionDetails({ details }: { details: Record<string, unknown> }) {
  const error = details.error;
  if (typeof error === "string") {
    return (
      <span style={{ fontSize: 13, color: "var(--danger)" }}>{error}</span>
    );
  }

  const confirmationId = details.confirmationId;
  if (typeof confirmationId === "string") {
    return (
      <span className="mono" style={{ fontSize: 13 }}>
        {confirmationId}
      </span>
    );
  }

  const keys = Object.keys(details);
  if (keys.length === 0) return null;

  return (
    <span className="muted mono" style={{ fontSize: 12 }}>
      {JSON.stringify(details)}
    </span>
  );
}
