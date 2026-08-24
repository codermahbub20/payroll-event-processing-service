import { PayrollEventType } from "@payroll/shared";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { flattenValidationErrors } from "../../common/validation";
import { CreateEventDto } from "../dto/create-event.dto";

const EMPLOYEE_ID = "3f6d0a2c-9c3a-4a1e-9f4a-2b8d6c1e5a70";
const VALID_IBAN = "DE89370400440532013000";

function validate(body: unknown): string[] {
  const dto = plainToInstance(CreateEventDto, body);
  const errors = validateSync(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return flattenValidationErrors(errors);
}

const base = {
  employeeId: EMPLOYEE_ID,
  effectiveDate: "2026-09-01",
};

describe("[unit] CreateEventDto validation", () => {
  describe("BANK_ACCOUNT_CHANGE", () => {
    const eventType = PayrollEventType.BANK_ACCOUNT_CHANGE;

    it("accepts a valid payload", () => {
      expect(
        validate({ ...base, eventType, payload: { iban: VALID_IBAN } }),
      ).toEqual([]);
    });

    it("rejects a missing iban", () => {
      const errors = validate({ ...base, eventType, payload: {} });
      expect(errors.join(" ")).toMatch(/iban/i);
    });

    it("rejects a malformed iban", () => {
      const errors = validate({
        ...base,
        eventType,
        payload: { iban: "NOT-AN-IBAN" },
      });
      expect(errors.join(" ")).toMatch(/iban/i);
    });

    it("rejects fields belonging to another event type", () => {
      const errors = validate({
        ...base,
        eventType,
        payload: { iban: VALID_IBAN, newSalary: 5000 },
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("ADDRESS_CHANGE", () => {
    const eventType = PayrollEventType.ADDRESS_CHANGE;
    const validPayload = {
      street: "Hauptstrasse 1",
      city: "Berlin",
      postalCode: "10115",
      country: "DE",
    };

    it("accepts a valid payload", () => {
      expect(validate({ ...base, eventType, payload: validPayload })).toEqual([]);
    });

    it.each(["street", "city", "postalCode", "country"])(
      "rejects a missing %s",
      (field) => {
        const payload: Record<string, unknown> = { ...validPayload };
        delete payload[field];
        const errors = validate({ ...base, eventType, payload });
        expect(errors.join(" ")).toMatch(new RegExp(field, "i"));
      },
    );

    it("rejects a non alpha-2 country code", () => {
      const errors = validate({
        ...base,
        eventType,
        payload: { ...validPayload, country: "Germany" },
      });
      expect(errors.join(" ")).toMatch(/country/i);
    });

    it("rejects an empty string field", () => {
      const errors = validate({
        ...base,
        eventType,
        payload: { ...validPayload, city: "" },
      });
      expect(errors.join(" ")).toMatch(/city/i);
    });
  });

  describe("SALARY_CHANGE", () => {
    const eventType = PayrollEventType.SALARY_CHANGE;
    const validPayload = { newSalary: 7500000, currency: "EUR" };

    it("accepts a valid payload", () => {
      expect(validate({ ...base, eventType, payload: validPayload })).toEqual([]);
    });

    it("rejects a missing newSalary", () => {
      const errors = validate({
        ...base,
        eventType,
        payload: { currency: "EUR" },
      });
      expect(errors.join(" ")).toMatch(/newSalary/i);
    });

    it("rejects a non-integer newSalary", () => {
      const errors = validate({
        ...base,
        eventType,
        payload: { ...validPayload, newSalary: 7500.55 },
      });
      expect(errors.join(" ")).toMatch(/newSalary/i);
    });

    it("rejects a negative newSalary", () => {
      const errors = validate({
        ...base,
        eventType,
        payload: { ...validPayload, newSalary: -1 },
      });
      expect(errors.join(" ")).toMatch(/newSalary/i);
    });

    it("rejects an invalid currency code", () => {
      const errors = validate({
        ...base,
        eventType,
        payload: { ...validPayload, currency: "XYZ" },
      });
      expect(errors.join(" ")).toMatch(/currency/i);
    });
  });

  describe("envelope", () => {
    const payload = { iban: VALID_IBAN };
    const eventType = PayrollEventType.BANK_ACCOUNT_CHANGE;

    it("rejects an unknown eventType", () => {
      const errors = validate({ ...base, eventType: "PROMOTION", payload });
      expect(errors.join(" ")).toMatch(/eventType/i);
    });

    it("rejects a missing eventType", () => {
      const errors = validate({ ...base, payload });
      expect(errors.join(" ")).toMatch(/eventType/i);
    });

    it("rejects a non-UUID employeeId", () => {
      const errors = validate({
        ...base,
        employeeId: "employee-1",
        eventType,
        payload,
      });
      expect(errors.join(" ")).toMatch(/employeeId/i);
    });

    it("rejects a malformed effectiveDate", () => {
      const errors = validate({
        ...base,
        effectiveDate: "01/09/2026",
        eventType,
        payload,
      });
      expect(errors.join(" ")).toMatch(/effectiveDate/i);
    });

    it("rejects an impossible calendar date", () => {
      const errors = validate({
        ...base,
        effectiveDate: "2026-02-30",
        eventType,
        payload,
      });
      expect(errors.join(" ")).toMatch(/effectiveDate/i);
    });

    it("rejects a missing payload", () => {
      const errors = validate({ ...base, eventType });
      expect(errors.join(" ")).toMatch(/payload/i);
    });

    it.each([
      ["null", null],
      ["a string", "not-an-object"],
      ["an array", []],
    ])("rejects a payload that is %s", (_label, value) => {
      const errors = validate({ ...base, eventType, payload: value });
      expect(errors.join(" ")).toMatch(/payload/i);
    });

    it("rejects unknown top-level fields", () => {
      const errors = validate({
        ...base,
        eventType,
        payload,
        submittedBy: "admin",
      });
      expect(errors.join(" ")).toMatch(/submittedBy/i);
    });

    it("does not carry scratch fields onto the validated instance", () => {
      const dto = plainToInstance(CreateEventDto, {
        ...base,
        eventType,
        payload: { iban: "bad" },
      });
      validateSync(dto as object);
      expect(Object.keys(dto)).not.toContain("__payloadErrors");
    });
  });
});
