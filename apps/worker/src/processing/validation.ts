import { PayrollEventType } from "@payroll/shared";
import { BusinessValidationError } from "./errors";

/**
 * Business validation, run by the worker immediately before the downstream
 * call.
 *
 * This is deliberately a SECOND validation pass — the API already validated
 * the payload at submission. It exists because:
 *   - events can sit in the queue for a long time, and the rules that matter
 *     are the ones in force when the change is actually applied;
 *   - rows can be written by paths other than the HTTP API (backfills,
 *     migrations, manual repair), which never passed through the DTO layer;
 *   - the checks here are *business* rules (salary ceilings, IBAN checksums),
 *     not request-shape rules, and belong next to the code that acts on them.
 *
 * Every failure here is PERMANENT: the payload is immutable once stored, so a
 * validation failure is deterministic and no retry can change it.
 */

/** Upper bound on a single salary change, in minor units (1,000,000.00). */
export const MAX_SALARY_MINOR_UNITS = 100_000_000;

/** ISO 7064 MOD-97-10 checksum, the real IBAN validation algorithm. */
export function isValidIbanChecksum(iban: string): boolean {
  const normalized = iban.replace(/\s+/g, "").toUpperCase();

  // 15 (Norway) to 34 (Malta and friends) is the full ISO 13616 range.
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) return false;

  // Move the first four characters to the end, then map letters to numbers
  // (A=10 ... Z=35) and take the whole thing mod 97. A valid IBAN yields 1.
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (ch) =>
    String(ch.charCodeAt(0) - 55),
  );

  // The number is far beyond Number.MAX_SAFE_INTEGER, so fold it in chunks
  // rather than parsing it whole.
  let remainder = 0;
  for (const digit of digits) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export interface ValidationOutcome {
  valid: boolean;
  violations: string[];
}

function ok(): ValidationOutcome {
  return { valid: true, violations: [] };
}

function fail(violations: string[]): ValidationOutcome {
  return { valid: false, violations };
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

export function validateBankAccountChange(payload: unknown): ValidationOutcome {
  const data = asRecord(payload);
  if (!data) return fail(["payload must be an object"]);

  const violations: string[] = [];
  const iban = data.iban;

  if (typeof iban !== "string" || iban.trim().length === 0) {
    violations.push("iban is required");
  } else if (!isValidIbanChecksum(iban)) {
    violations.push("iban failed checksum validation");
  }

  return violations.length ? fail(violations) : ok();
}

export function validateAddressChange(payload: unknown): ValidationOutcome {
  const data = asRecord(payload);
  if (!data) return fail(["payload must be an object"]);

  const violations: string[] = [];

  for (const field of ["street", "city", "postalCode"] as const) {
    const value = data[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      violations.push(`${field} must be a non-empty string`);
    }
  }

  const country = data.country;
  if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)) {
    violations.push("country must be an ISO 3166-1 alpha-2 code");
  }

  return violations.length ? fail(violations) : ok();
}

export function validateSalaryChange(payload: unknown): ValidationOutcome {
  const data = asRecord(payload);
  if (!data) return fail(["payload must be an object"]);

  const violations: string[] = [];
  const salary = data.newSalary;

  if (typeof salary !== "number" || Number.isNaN(salary)) {
    violations.push("newSalary must be a number");
  } else if (!Number.isInteger(salary)) {
    // Minor units only. A fractional cent means the caller is using a
    // different unit convention, which would silently mis-scale the payment.
    violations.push("newSalary must be an integer in minor units (cents)");
  } else if (salary <= 0) {
    violations.push("newSalary must be positive");
  } else if (salary > MAX_SALARY_MINOR_UNITS) {
    // A sanity ceiling. A salary above this is far more likely a unit error
    // (major units sent as minor) than a genuine change, and applying it
    // would be an expensive mistake to unwind.
    violations.push(
      `newSalary exceeds the maximum of ${MAX_SALARY_MINOR_UNITS} minor units`,
    );
  }

  const currency = data.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    violations.push("currency must be a three-letter ISO 4217 code");
  }

  return violations.length ? fail(violations) : ok();
}

const VALIDATORS: Record<string, (payload: unknown) => ValidationOutcome> = {
  [PayrollEventType.BANK_ACCOUNT_CHANGE]: validateBankAccountChange,
  [PayrollEventType.ADDRESS_CHANGE]: validateAddressChange,
  [PayrollEventType.SALARY_CHANGE]: validateSalaryChange,
};

/** Dispatches to the validator for `eventType`. */
export function validatePayload(
  eventType: string,
  payload: unknown,
): ValidationOutcome {
  const validator = VALIDATORS[eventType];
  if (!validator) {
    // An unknown type cannot be validated, so it cannot be safely applied.
    return fail([`unknown eventType: ${eventType}`]);
  }
  return validator(payload);
}

/** Validates, throwing a permanent error when the payload is unusable. */
export function assertValidPayload(eventType: string, payload: unknown): void {
  const outcome = validatePayload(eventType, payload);
  if (!outcome.valid) {
    throw new BusinessValidationError(
      `business validation failed for ${eventType}: ${outcome.violations.join("; ")}`,
      outcome.violations,
      { eventType },
    );
  }
}
