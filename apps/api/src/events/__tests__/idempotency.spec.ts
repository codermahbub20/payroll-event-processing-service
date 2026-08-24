import { PayrollEventType } from "@payroll/shared";
import { CreateEventDto } from "../dto/create-event.dto";
import { deriveIdempotencyKey, normalizeClientKey } from "../idempotency";

function dto(overrides: Partial<CreateEventDto> = {}): CreateEventDto {
  return {
    eventType: PayrollEventType.SALARY_CHANGE,
    employeeId: "3f6d0a2c-9c3a-4a1e-9f4a-2b8d6c1e5a70",
    effectiveDate: "2026-09-01",
    payload: { newSalary: 7500000, currency: "EUR" },
    ...overrides,
  } as CreateEventDto;
}

describe("[unit] deriveIdempotencyKey", () => {
  it("is deterministic for identical input", () => {
    expect(deriveIdempotencyKey(dto())).toBe(deriveIdempotencyKey(dto()));
  });

  it("ignores key ordering within the payload", () => {
    const a = dto({ payload: { newSalary: 7500000, currency: "EUR" } as never });
    const b = dto({ payload: { currency: "EUR", newSalary: 7500000 } as never });
    expect(deriveIdempotencyKey(a)).toBe(deriveIdempotencyKey(b));
  });

  it.each([
    ["employeeId", { employeeId: "11111111-2222-4333-8444-555555555555" }],
    ["eventType", { eventType: PayrollEventType.ADDRESS_CHANGE }],
    ["effectiveDate", { effectiveDate: "2026-10-01" }],
    ["payload", { payload: { newSalary: 1, currency: "EUR" } as never }],
  ])("changes when %s changes", (_label, overrides) => {
    expect(deriveIdempotencyKey(dto(overrides))).not.toBe(
      deriveIdempotencyKey(dto()),
    );
  });

  it("is prefixed so derived keys are distinguishable from client keys", () => {
    expect(deriveIdempotencyKey(dto())).toMatch(/^derived:[0-9a-f]{64}$/);
  });

  it("fits the varchar(255) column", () => {
    expect(deriveIdempotencyKey(dto()).length).toBeLessThanOrEqual(255);
  });
});

describe("[unit] normalizeClientKey", () => {
  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace only", "   "],
  ])("returns null for %s", (_label, value) => {
    expect(normalizeClientKey(value)).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeClientKey("  abc-123  ")).toBe("abc-123");
  });

  it("preserves a well-formed key", () => {
    expect(normalizeClientKey("client-key-1")).toBe("client-key-1");
  });
});
