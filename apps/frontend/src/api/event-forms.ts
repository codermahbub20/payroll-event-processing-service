import { PayrollEventType } from "@payroll/shared";

/**
 * Field definitions per event type.
 *
 * One declarative source drives the dynamic form, the client-side validation
 * and the placeholder text. Hand-writing three separate forms would let them
 * drift from each other and from the API's own rules.
 *
 * These rules deliberately MIRROR the server's — they do not replace it. The
 * API and worker validate independently; this exists to give immediate
 * feedback rather than a round trip for an obvious typo.
 */

export type FieldType = "text" | "number";

export interface FieldSpec {
  name: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  help?: string;
  /** Returns an error message, or null when the value is acceptable. */
  validate: (raw: string) => string | null;
}

function required(label: string) {
  return (raw: string): string | null =>
    raw.trim().length === 0 ? `${label} is required` : null;
}

/**
 * ISO 7064 MOD-97-10 — the same algorithm the worker runs. Catching a
 * mistyped IBAN here saves a round trip AND a permanently-failed event, since
 * a bad checksum fails business validation server-side.
 */
export function isValidIban(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) return false;

  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (ch) =>
    String(ch.charCodeAt(0) - 55),
  );

  let remainder = 0;
  for (const digit of digits) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const BANK_ACCOUNT_FIELDS: FieldSpec[] = [
  {
    name: "iban",
    label: "IBAN",
    type: "text",
    placeholder: "DE89370400440532013000",
    help: "Checked with a real IBAN checksum before submitting.",
    validate: (raw) => {
      const err = required("IBAN")(raw);
      if (err) return err;
      return isValidIban(raw) ? null : "That IBAN fails its checksum";
    },
  },
];

const ADDRESS_FIELDS: FieldSpec[] = [
  {
    name: "street",
    label: "Street",
    type: "text",
    placeholder: "Hauptstrasse 1",
    validate: required("Street"),
  },
  {
    name: "city",
    label: "City",
    type: "text",
    placeholder: "Berlin",
    validate: required("City"),
  },
  {
    name: "postalCode",
    label: "Postal code",
    type: "text",
    placeholder: "10115",
    validate: required("Postal code"),
  },
  {
    name: "country",
    label: "Country",
    type: "text",
    placeholder: "DE",
    help: "ISO 3166-1 alpha-2, e.g. DE, FR, GB.",
    validate: (raw) => {
      const err = required("Country")(raw);
      if (err) return err;
      return /^[A-Z]{2}$/.test(raw.trim().toUpperCase())
        ? null
        : "Use a two-letter country code, e.g. DE";
    },
  },
];

const SALARY_FIELDS: FieldSpec[] = [
  {
    name: "newSalary",
    label: "New salary (minor units)",
    type: "number",
    placeholder: "7500000",
    help: "Integer cents. 75,000.00 EUR is 7500000 — decimals are rejected.",
    validate: (raw) => {
      const err = required("New salary")(raw);
      if (err) return err;

      const value = Number(raw);
      if (!Number.isFinite(value)) return "New salary must be a number";
      // Mirrors the server: money is integer minor units, never a float.
      if (!Number.isInteger(value)) {
        return "Must be a whole number of minor units (cents)";
      }
      if (value <= 0) return "New salary must be positive";
      return null;
    },
  },
  {
    name: "currency",
    label: "Currency",
    type: "text",
    placeholder: "EUR",
    help: "ISO 4217, e.g. EUR, USD, GBP.",
    validate: (raw) => {
      const err = required("Currency")(raw);
      if (err) return err;
      return /^[A-Z]{3}$/.test(raw.trim().toUpperCase())
        ? null
        : "Use a three-letter currency code, e.g. EUR";
    },
  },
];

export const EVENT_TYPE_FIELDS: Record<PayrollEventType, FieldSpec[]> = {
  [PayrollEventType.BANK_ACCOUNT_CHANGE]: BANK_ACCOUNT_FIELDS,
  [PayrollEventType.ADDRESS_CHANGE]: ADDRESS_FIELDS,
  [PayrollEventType.SALARY_CHANGE]: SALARY_FIELDS,
};

export const EVENT_TYPE_LABELS: Record<PayrollEventType, string> = {
  [PayrollEventType.BANK_ACCOUNT_CHANGE]: "Bank account change",
  [PayrollEventType.ADDRESS_CHANGE]: "Address change",
  [PayrollEventType.SALARY_CHANGE]: "Salary change",
};

/** Coerces raw form strings into the JSON types the API expects. */
export function buildPayload(
  eventType: PayrollEventType,
  values: Record<string, string>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const field of EVENT_TYPE_FIELDS[eventType]) {
    const raw = values[field.name] ?? "";

    if (field.type === "number") {
      payload[field.name] = Number(raw);
      continue;
    }

    // Country and currency codes are uppercased so a lowercase entry is not
    // rejected by the server for a purely cosmetic reason.
    payload[field.name] =
      field.name === "country" || field.name === "currency"
        ? raw.trim().toUpperCase()
        : raw.trim();
  }

  return payload;
}
