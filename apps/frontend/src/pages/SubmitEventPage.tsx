import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PayrollEventType } from "@payroll/shared";
import { ApiError, submitEvent } from "../api/client";
import {
  EVENT_TYPE_FIELDS,
  EVENT_TYPE_LABELS,
  buildPayload,
} from "../api/event-forms";
import type { SubmitEventResponse } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";

const EVENT_TYPES = Object.values(PayrollEventType);

/** Today in YYYY-MM-DD, in LOCAL time — `toISOString` would shift the day. */
function todayLocal(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function SubmitEventPage() {
  const [eventType, setEventType] = useState<PayrollEventType>(
    PayrollEventType.BANK_ACCOUNT_CHANGE,
  );
  const [employeeId, setEmployeeId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayLocal());
  // Keyed by field name across ALL types, so switching type and switching back
  // does not lose what was typed.
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitEventResponse | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);

  const fields = useMemo(() => EVENT_TYPE_FIELDS[eventType], [eventType]);

  function setValue(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
    // Clear the error as soon as the user edits, rather than making them
    // resubmit to discover they fixed it.
    setErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};

    if (!employeeId.trim()) {
      found.employeeId = "Employee ID is required";
    } else if (!UUID_V4.test(employeeId.trim())) {
      found.employeeId = "Employee ID must be a UUID";
    }

    if (!effectiveDate) {
      found.effectiveDate = "Effective date is required";
    }

    for (const field of fields) {
      const message = field.validate(values[field.name] ?? "");
      if (message) found[field.name] = message;
    }

    return found;
  }

  async function handleSubmit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    setApiError(null);
    setResult(null);

    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      const response = await submitEvent({
        eventType,
        employeeId: employeeId.trim(),
        effectiveDate,
        payload: buildPayload(eventType, values),
      });
      setResult(response);
      // Clear only the type-specific fields; employeeId and date usually stay
      // the same when submitting several changes for one person.
      setValues({});
    } catch (cause) {
      setApiError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, {
              statusCode: 0,
              error: "Error",
              message: String(cause),
            }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function useExampleEmployee() {
    setEmployeeId("3f6d0a2c-9c3a-4a1e-9f4a-2b8d6c1e5a70");
  }

  return (
    <>
      <h2 className="page-title">Submit a payroll event</h2>
      <p className="page-subtitle">
        The API accepts the event and returns immediately; a worker processes it
        asynchronously.
      </p>

      {result && (
        <div className="alert alert-success" role="status">
          <strong>
            {result.duplicate
              ? "Duplicate detected — returned the existing event"
              : "Event accepted"}
          </strong>
          <div style={{ marginTop: 6 }}>
            <span className="mono">{result.id}</span>{" "}
            <StatusBadge status={result.status} />
          </div>
          {result.duplicate && (
            <div style={{ marginTop: 6 }}>
              An identical submission already existed, so no new work was
              queued.
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <Link to={`/events/${result.id}`}>
              Watch it process&nbsp;&rarr;
            </Link>
          </div>
        </div>
      )}

      {apiError && (
        <div className="alert alert-error" role="alert">
          <strong>{apiError.message}</strong>
          {apiError.details.length > 0 && (
            <ul>
              {apiError.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <form className="card" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="eventType">Event type</label>
          <select
            id="eventType"
            value={eventType}
            onChange={(e) => {
              setEventType(e.target.value as PayrollEventType);
              setErrors({});
            }}
          >
            {EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {EVENT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <div className="field-help">
            The fields below change to match the selected type.
          </div>
        </div>

        <div className="field">
          <label htmlFor="employeeId">Employee ID</label>
          <input
            id="employeeId"
            className="mono"
            value={employeeId}
            placeholder="3f6d0a2c-9c3a-4a1e-9f4a-2b8d6c1e5a70"
            aria-invalid={Boolean(errors.employeeId)}
            onChange={(e) => {
              setEmployeeId(e.target.value);
              setErrors((prev) => {
                const next = { ...prev };
                delete next.employeeId;
                return next;
              });
            }}
          />
          {errors.employeeId ? (
            <div className="field-error">{errors.employeeId}</div>
          ) : (
            <div className="field-help">
              A UUID.{" "}
              <button
                type="button"
                onClick={useExampleEmployee}
                style={{
                  padding: 0,
                  border: "none",
                  background: "none",
                  color: "var(--accent)",
                  cursor: "pointer",
                  font: "inherit",
                }}
              >
                Use the example ID
              </button>
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="effectiveDate">Effective date</label>
          <input
            id="effectiveDate"
            type="date"
            value={effectiveDate}
            aria-invalid={Boolean(errors.effectiveDate)}
            onChange={(e) => setEffectiveDate(e.target.value)}
          />
          {errors.effectiveDate && (
            <div className="field-error">{errors.effectiveDate}</div>
          )}
        </div>

        <hr
          style={{
            border: "none",
            borderTop: "1px solid var(--border)",
            margin: "20px 0",
          }}
        />

        {fields.map((field) => (
          <div className="field" key={field.name}>
            <label htmlFor={field.name}>{field.label}</label>
            <input
              id={field.name}
              type={field.type === "number" ? "number" : "text"}
              className={field.name === "iban" ? "mono" : undefined}
              value={values[field.name] ?? ""}
              placeholder={field.placeholder}
              aria-invalid={Boolean(errors[field.name])}
              onChange={(e) => setValue(field.name, e.target.value)}
            />
            {errors[field.name] ? (
              <div className="field-error">{errors[field.name]}</div>
            ) : field.help ? (
              <div className="field-help">{field.help}</div>
            ) : null}
          </div>
        ))}

        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? "Submitting…" : "Submit event"}
        </button>
      </form>
    </>
  );
}
