import { PayrollEventType } from "@payroll/shared";
import { BusinessValidationError } from "../errors";
import {
  MAX_SALARY_MINOR_UNITS,
  assertValidPayload,
  isValidIbanChecksum,
  validateAddressChange,
  validateBankAccountChange,
  validatePayload,
  validateSalaryChange,
} from "../validation";

describe("isValidIbanChecksum", () => {
  // Real IBANs spanning the length range (Norway 15, Malta-style long) and
  // both numeric and alphanumeric BBANs.
  it.each([
    ["Germany", "DE89370400440532013000"],
    ["United Kingdom", "GB82WEST12345698765432"],
    ["France (alphanumeric)", "FR1420041010050500013M02606"],
    ["Netherlands", "NL91ABNA0417164300"],
    ["Spain", "ES9121000418450200051332"],
    ["Norway (15 chars, shortest)", "NO9386011117947"],
  ])("accepts a valid %s IBAN", (_label, iban) => {
    expect(isValidIbanChecksum(iban)).toBe(true);
  });

  // IBANs are case-insensitive per ISO 13616, so input is normalised to
  // uppercase before the checksum runs.
  it("accepts lowercase input", () => {
    expect(isValidIbanChecksum("de89370400440532013000")).toBe(true);
  });

  it("accepts mixed case in an alphanumeric BBAN", () => {
    expect(isValidIbanChecksum("GB82west12345698765432")).toBe(true);
  });

  it("accepts the conventional spaced format", () => {
    expect(isValidIbanChecksum("DE89 3704 0044 0532 0130 00")).toBe(true);
  });

  it.each([
    ["a single transposed check digit", "DE89370400440532013001"],
    ["a corrupted UK IBAN", "GB82WEST12345698765433"],
    ["free text", "NOT-AN-IBAN"],
    ["a truncated IBAN", "DE89"],
    ["an empty string", ""],
    ["a missing country code", "1289370400440532013000"],
    ["punctuation in the BBAN", "GB82WEST-1234-5698-7654-32"],
  ])("rejects %s", (_label, iban) => {
    expect(isValidIbanChecksum(iban)).toBe(false);
  });

  it("rejects an IBAN longer than the ISO 13616 maximum", () => {
    expect(isValidIbanChecksum(`DE89${"0".repeat(31)}`)).toBe(false);
  });
});

describe("validateBankAccountChange", () => {
  it("accepts a valid payload", () => {
    expect(
      validateBankAccountChange({ iban: "DE89370400440532013000" }),
    ).toEqual({ valid: true, violations: [] });
  });

  it("rejects a missing iban", () => {
    const result = validateBankAccountChange({});
    expect(result.valid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/iban is required/);
  });

  it("rejects a blank iban", () => {
    const result = validateBankAccountChange({ iban: "   " });
    expect(result.valid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/iban is required/);
  });

  it("rejects an iban that fails the checksum", () => {
    const result = validateBankAccountChange({
      iban: "DE89370400440532013001",
    });
    expect(result.valid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/checksum/);
  });

  it.each([
    ["null", null],
    ["a string", "DE89370400440532013000"],
    ["an array", []],
  ])("rejects a payload that is %s", (_label, payload) => {
    expect(validateBankAccountChange(payload).valid).toBe(false);
  });
});

describe("validateAddressChange", () => {
  const valid = {
    street: "Hauptstrasse 1",
    city: "Berlin",
    postalCode: "10115",
    country: "DE",
  };

  it("accepts a valid payload", () => {
    expect(validateAddressChange(valid)).toEqual({
      valid: true,
      violations: [],
    });
  });

  it.each(["street", "city", "postalCode"])(
    "rejects a missing %s",
    (field) => {
      const payload: Record<string, unknown> = { ...valid };
      delete payload[field];
      const result = validateAddressChange(payload);
      expect(result.valid).toBe(false);
      expect(result.violations.join(" ")).toMatch(new RegExp(field));
    },
  );

  it.each(["street", "city", "postalCode"])(
    "rejects a whitespace-only %s",
    (field) => {
      const result = validateAddressChange({ ...valid, [field]: "   " });
      expect(result.valid).toBe(false);
      expect(result.violations.join(" ")).toMatch(new RegExp(field));
    },
  );

  it("rejects an empty postal code specifically", () => {
    const result = validateAddressChange({ ...valid, postalCode: "" });
    expect(result.valid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/postalCode/);
  });

  it.each([
    ["a full country name", "Germany"],
    ["a three-letter code", "DEU"],
    ["lowercase", "de"],
    ["a number", 49],
  ])("rejects %s as country", (_label, country) => {
    const result = validateAddressChange({ ...valid, country });
    expect(result.valid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/country/);
  });

  it("reports every violation at once, not just the first", () => {
    const result = validateAddressChange({ country: "Germany" });
    expect(result.violations.length).toBeGreaterThanOrEqual(4);
  });
});

describe("validateSalaryChange", () => {
  const valid = { newSalary: 7500000, currency: "EUR" };

  it("accepts a valid payload", () => {
    expect(validateSalaryChange(valid)).toEqual({
      valid: true,
      violations: [],
    });
  });

  it.each([
    ["zero", 0],
    ["a negative amount", -1],
    ["a large negative amount", -7500000],
  ])("rejects %s as newSalary", (_label, newSalary) => {
    const result = validateSalaryChange({ ...valid, newSalary });
    expect(result.valid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/positive/);
  });

  it("rejects a fractional amount", () => {
    const result = validateSalaryChange({ ...valid, newSalary: 7500.55 });
    expect(result.valid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/integer/);
  });

  it("rejects a non-numeric amount", () => {
    const result = validateSalaryChange({ ...valid, newSalary: "7500000" });
    expect(result.valid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/number/);
  });

  it("rejects NaN", () => {
    const result = validateSalaryChange({ ...valid, newSalary: Number.NaN });
    expect(result.valid).toBe(false);
  });

  it("accepts the maximum permitted salary", () => {
    expect(
      validateSalaryChange({ ...valid, newSalary: MAX_SALARY_MINOR_UNITS })
        .valid,
    ).toBe(true);
  });

  it("rejects a salary above the sanity ceiling", () => {
    // Guards the common unit error: major units sent where minor are expected.
    const result = validateSalaryChange({
      ...valid,
      newSalary: MAX_SALARY_MINOR_UNITS + 1,
    });
    expect(result.valid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/maximum/);
  });

  it.each([
    ["a two-letter code", "EU"],
    ["a four-letter code", "EURO"],
    ["lowercase", "eur"],
    ["a number", 978],
  ])("rejects %s as currency", (_label, currency) => {
    const result = validateSalaryChange({ ...valid, currency });
    expect(result.valid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/currency/);
  });
});

describe("validatePayload dispatch", () => {
  it.each([
    [
      PayrollEventType.BANK_ACCOUNT_CHANGE,
      { iban: "DE89370400440532013000" },
    ],
    [
      PayrollEventType.ADDRESS_CHANGE,
      { street: "A", city: "B", postalCode: "1", country: "DE" },
    ],
    [PayrollEventType.SALARY_CHANGE, { newSalary: 1, currency: "EUR" }],
  ])("routes %s to its validator", (eventType, payload) => {
    expect(validatePayload(eventType, payload).valid).toBe(true);
  });

  it("rejects an unknown eventType rather than passing it through", () => {
    const result = validatePayload("PROMOTION", { anything: true });
    expect(result.valid).toBe(false);
    expect(result.violations.join(" ")).toMatch(/unknown eventType/);
  });

  it("validates against the payload for the DECLARED type", () => {
    // A salary payload submitted as a bank-account change must not pass.
    const result = validatePayload(PayrollEventType.BANK_ACCOUNT_CHANGE, {
      newSalary: 100,
      currency: "EUR",
    });
    expect(result.valid).toBe(false);
  });
});

describe("assertValidPayload", () => {
  it("returns silently for a valid payload", () => {
    expect(() =>
      assertValidPayload(PayrollEventType.SALARY_CHANGE, {
        newSalary: 1000,
        currency: "EUR",
      }),
    ).not.toThrow();
  });

  it("throws a BusinessValidationError carrying every violation", () => {
    expect.assertions(4);
    try {
      assertValidPayload(PayrollEventType.SALARY_CHANGE, {
        newSalary: -1,
        currency: "nope",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessValidationError);
      const err = error as BusinessValidationError;
      // Validation failures can never be fixed by retrying.
      expect(err.retryable).toBe(false);
      expect(err.code).toBe("BUSINESS_VALIDATION_FAILED");
      expect(err.violations.length).toBe(2);
    }
  });
});
