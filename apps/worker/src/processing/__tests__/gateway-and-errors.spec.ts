import {
  BusinessValidationError,
  PermanentProcessingError,
  TemporaryProcessingError,
  errorCode,
  isRetryable,
} from "../errors";
import { SimulatedPayrollGateway } from "../payroll-gateway";

const noSleep = async (): Promise<void> => undefined;

const request = {
  eventId: "11111111-1111-4111-8111-111111111111",
  employeeId: "22222222-2222-4222-8222-222222222222",
  eventType: "SALARY_CHANGE",
  payload: { newSalary: 1000, currency: "EUR" },
};

describe("[unit] error classification", () => {
  it("marks temporary errors retryable", () => {
    const error = new TemporaryProcessingError("timeout", "DOWNSTREAM_TIMEOUT");
    expect(error.retryable).toBe(true);
    expect(isRetryable(error)).toBe(true);
    expect(errorCode(error)).toBe("DOWNSTREAM_TIMEOUT");
  });

  it("marks permanent errors non-retryable", () => {
    const error = new PermanentProcessingError(
      "employee not found",
      "EMPLOYEE_NOT_FOUND",
    );
    expect(error.retryable).toBe(false);
    expect(isRetryable(error)).toBe(false);
    expect(errorCode(error)).toBe("EMPLOYEE_NOT_FOUND");
  });

  it("treats business validation failures as permanent", () => {
    const error = new BusinessValidationError("bad", ["newSalary must be positive"]);
    expect(error.retryable).toBe(false);
    expect(error).toBeInstanceOf(PermanentProcessingError);
    expect(error.context.violations).toEqual(["newSalary must be positive"]);
  });

  it("treats unknown errors as retryable", () => {
    // An unrecognised crash is more likely transient infrastructure than bad
    // data; the retry budget bounds the cost of guessing wrong, whereas
    // failing permanently would discard recoverable work.
    expect(isRetryable(new Error("something exploded"))).toBe(true);
    expect(isRetryable("a string")).toBe(true);
    expect(errorCode(new Error("boom"))).toBe("UNKNOWN_ERROR");
  });

  it("survives instanceof through the class hierarchy", () => {
    const error = new BusinessValidationError("bad", []);
    expect(error).toBeInstanceOf(BusinessValidationError);
    expect(error).toBeInstanceOf(PermanentProcessingError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BusinessValidationError");
  });
});

describe("[unit] SimulatedPayrollGateway", () => {
  it("returns a result with confirmationId and appliedAt when healthy", async () => {
    const gateway = new SimulatedPayrollGateway({
      temporaryFailureRate: 0,
      permanentFailureRate: 0,
      sleep: noSleep,
    });

    const result = await gateway.apply(request);

    expect(result.confirmationId).toMatch(/^pay_[0-9a-f]{20}$/);
    expect(() => new Date(result.appliedAt).toISOString()).not.toThrow();
    expect(typeof result.latencyMs).toBe("number");
  });

  it("throws a retryable error at a 100% temporary rate", async () => {
    const gateway = new SimulatedPayrollGateway({
      temporaryFailureRate: 1,
      permanentFailureRate: 0,
      sleep: noSleep,
    });

    await expect(gateway.apply(request)).rejects.toBeInstanceOf(
      TemporaryProcessingError,
    );
  });

  it("throws a non-retryable error at a 100% permanent rate", async () => {
    const gateway = new SimulatedPayrollGateway({
      temporaryFailureRate: 0,
      permanentFailureRate: 1,
      sleep: noSleep,
    });

    await expect(gateway.apply(request)).rejects.toBeInstanceOf(
      PermanentProcessingError,
    );
  });

  it("prefers the permanent fault when both rates are 100%", async () => {
    // Permanent is rolled first so a forced permanent rate is unambiguous in
    // tests, rather than being masked by a forced temporary rate.
    const gateway = new SimulatedPayrollGateway({
      temporaryFailureRate: 1,
      permanentFailureRate: 1,
      sleep: noSleep,
    });

    await expect(gateway.apply(request)).rejects.toBeInstanceOf(
      PermanentProcessingError,
    );
  });

  it("keeps latency inside the configured window", async () => {
    const slept: number[] = [];
    const gateway = new SimulatedPayrollGateway({
      temporaryFailureRate: 0,
      permanentFailureRate: 0,
      minLatencyMs: 500,
      maxLatencyMs: 3000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    for (let i = 0; i < 50; i++) await gateway.apply(request);

    expect(Math.min(...slept)).toBeGreaterThanOrEqual(500);
    expect(Math.max(...slept)).toBeLessThan(3000);
  });

  it("incurs latency before failing, as a real timeout would", async () => {
    const slept: number[] = [];
    const gateway = new SimulatedPayrollGateway({
      temporaryFailureRate: 1,
      permanentFailureRate: 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await expect(gateway.apply(request)).rejects.toThrow();
    // A timeout costs the full wait; retry backoff has to account for it.
    expect(slept).toHaveLength(1);
  });

  it("is deterministic with an injected RNG", async () => {
    const gateway = new SimulatedPayrollGateway({
      temporaryFailureRate: 0.5,
      permanentFailureRate: 0.5,
      random: () => 0.99, // above both thresholds -> always succeeds
      sleep: noSleep,
    });

    await expect(gateway.apply(request)).resolves.toBeDefined();
  });

  it("attaches diagnostic context to failures", async () => {
    const gateway = new SimulatedPayrollGateway({
      temporaryFailureRate: 1,
      permanentFailureRate: 0,
      sleep: noSleep,
    });

    await expect(gateway.apply(request)).rejects.toMatchObject({
      context: expect.objectContaining({
        eventId: request.eventId,
        employeeId: request.employeeId,
      }),
    });
  });
});
