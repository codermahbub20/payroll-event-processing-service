import { useCallback, useEffect, useRef, useState } from "react";
import { PayrollEventStatus } from "@payroll/shared";
import { ApiError, getEvent } from "../api/client";
import type { EventDetail } from "../api/types";

/** Statuses from which the event can still change on its own. */
const NON_TERMINAL: readonly PayrollEventStatus[] = [
  PayrollEventStatus.PENDING,
  PayrollEventStatus.PROCESSING,
];

export const POLL_INTERVAL_MS = 2000;

export interface PolledEvent {
  event: EventDetail | null;
  error: ApiError | null;
  /** True only for the first load, so refreshes do not blank the page. */
  loading: boolean;
  /** True while a poll timer is active. */
  polling: boolean;
  refresh: () => void;
}

/**
 * Fetches an event and re-polls while its status is non-terminal.
 *
 * Polling stops as soon as the event reaches SUCCEEDED / FAILED_PERMANENT /
 * FAILED_TEMPORARY, so a finished event does not generate traffic forever.
 * FAILED_TEMPORARY counts as terminal here: the worker has exhausted its retry
 * budget, and any further attempt needs an operator, so there is nothing to
 * watch for.
 */
export function usePolledEvent(id: string | undefined): PolledEvent {
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);

  // Guards against a late response from a previous id overwriting the current
  // one when the user navigates between events quickly.
  const activeId = useRef(id);
  activeId.current = id;

  const fetchOnce = useCallback(
    async (requestedId: string, isFirst: boolean) => {
      try {
        const next = await getEvent(requestedId);
        if (activeId.current !== requestedId) return null;

        setEvent(next);
        setError(null);
        return next;
      } catch (cause) {
        if (activeId.current !== requestedId) return null;
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError(0, {
                statusCode: 0,
                error: "Error",
                message: String(cause),
              }),
        );
        return null;
      } finally {
        if (isFirst && activeId.current === requestedId) setLoading(false);
      }
    },
    [],
  );

  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  useEffect(() => {
    if (!id) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    setLoading(true);
    setPolling(false);

    const tick = async (isFirst: boolean) => {
      const next = await fetchOnce(id, isFirst);
      if (cancelled) return;

      const shouldContinue =
        next !== null && NON_TERMINAL.includes(next.status);

      setPolling(shouldContinue);

      if (shouldContinue) {
        // setTimeout rather than setInterval: chaining after each response
        // means a slow request cannot stack overlapping polls.
        timer = setTimeout(() => void tick(false), POLL_INTERVAL_MS);
      }
    };

    void tick(true);

    return () => {
      cancelled = true;
      setPolling(false);
      if (timer) clearTimeout(timer);
    };
  }, [id, fetchOnce, refreshToken]);

  return { event, error, loading, polling, refresh };
}
