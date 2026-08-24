import { createHash } from "node:crypto";
import { CreateEventDto } from "./dto/create-event.dto";

/**
 * Canonical JSON: object keys sorted recursively so that two semantically
 * identical bodies that differ only in key order hash to the same value.
 * Without this, `{a:1,b:2}` and `{b:2,a:1}` would produce different keys and
 * a retry could be treated as a new event.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Derives a deterministic idempotency key from the request body.
 *
 * Used only when the client does not supply an `Idempotency-Key` header.
 * See docs/decisions.md for why content-hashing was chosen over a random key.
 *
 * The hash covers employeeId + eventType + effectiveDate + payload — i.e. the
 * full business identity of the change. `derived:` prefixes the value so
 * server-derived keys are distinguishable from client-supplied ones in the
 * database, which matters when debugging duplicate submissions.
 */
export function deriveIdempotencyKey(dto: CreateEventDto): string {
  const canonical = JSON.stringify(
    canonicalize({
      employeeId: dto.employeeId,
      eventType: dto.eventType,
      effectiveDate: dto.effectiveDate,
      payload: dto.payload,
    }),
  );

  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `derived:${digest}`;
}

/** Normalises a client-supplied header value; returns null when absent/blank. */
export function normalizeClientKey(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Matches the `varchar(255)` column on payroll_events. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
