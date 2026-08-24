import { randomUUID } from "node:crypto";
import { PermanentProcessingError, TemporaryProcessingError } from "./errors";

/**
 * Stand-in for the external payroll provider.
 *
 * Failure rates and latency are injectable so tests can pin them (0% for
 * deterministic runs, 100% to exercise the retry path) while the default
 * configuration models a realistically flaky downstream.
 */
export interface PayrollGatewayOptions {
  /** Probability [0,1] of a retryable failure (timeout / 503). */
  temporaryFailureRate?: number;
  /** Probability [0,1] of a non-retryable failure (employee not found). */
  permanentFailureRate?: number;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  /** Injectable RNG, so tests are deterministic without stubbing globals. */
  random?: () => number;
  /** Injectable sleep, so tests do not actually wait seconds. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PayrollGatewayRequest {
  eventId: string;
  employeeId: string;
  eventType: string;
  payload: unknown;
}

export interface PayrollGatewayResult {
  appliedAt: string;
  confirmationId: string;
  /** Observed latency, useful for downstream-performance dashboards. */
  latencyMs: number;
}

const DEFAULTS = {
  temporaryFailureRate: 0.2,
  permanentFailureRate: 0.05,
  minLatencyMs: 500,
  maxLatencyMs: 3000,
};

/** Retryable failures the simulated provider can raise. */
const TEMPORARY_FAULTS: ReadonlyArray<{ code: string; message: string }> = [
  { code: "DOWNSTREAM_TIMEOUT", message: "payroll provider timed out after 30s" },
  {
    code: "DOWNSTREAM_UNAVAILABLE",
    message: "payroll provider returned 503 Service Unavailable",
  },
  {
    code: "DOWNSTREAM_RATE_LIMITED",
    message: "payroll provider returned 429 Too Many Requests",
  },
];

/** Non-retryable failures — the provider rejecting the request outright. */
const PERMANENT_FAULTS: ReadonlyArray<{ code: string; message: string }> = [
  {
    code: "EMPLOYEE_NOT_FOUND",
    message: "employee not found in payroll system",
  },
  {
    code: "ACCOUNT_CLOSED",
    message: "payroll account is closed and cannot be modified",
  },
];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SimulatedPayrollGateway {
  private readonly temporaryFailureRate: number;
  private readonly permanentFailureRate: number;
  private readonly minLatencyMs: number;
  private readonly maxLatencyMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: PayrollGatewayOptions = {}) {
    this.temporaryFailureRate =
      options.temporaryFailureRate ?? DEFAULTS.temporaryFailureRate;
    this.permanentFailureRate =
      options.permanentFailureRate ?? DEFAULTS.permanentFailureRate;
    this.minLatencyMs = options.minLatencyMs ?? DEFAULTS.minLatencyMs;
    this.maxLatencyMs = options.maxLatencyMs ?? DEFAULTS.maxLatencyMs;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Simulates the provider call.
   *
   * Latency is incurred BEFORE the failure roll, mirroring reality: a timeout
   * costs the full wait, so retry backoff has to account for it.
   */
  async apply(request: PayrollGatewayRequest): Promise<PayrollGatewayResult> {
    const latencyMs = Math.floor(
      this.minLatencyMs +
        this.random() * Math.max(0, this.maxLatencyMs - this.minLatencyMs),
    );
    await this.sleep(latencyMs);

    // Permanent is rolled first so a 100% permanent rate is unambiguous;
    // otherwise a 100% temporary rate would mask it.
    if (this.random() < this.permanentFailureRate) {
      const fault = this.pick(PERMANENT_FAULTS);
      throw new PermanentProcessingError(fault.message, fault.code, {
        eventId: request.eventId,
        employeeId: request.employeeId,
        provider: "simulated-payroll",
      });
    }

    if (this.random() < this.temporaryFailureRate) {
      const fault = this.pick(TEMPORARY_FAULTS);
      throw new TemporaryProcessingError(fault.message, fault.code, {
        eventId: request.eventId,
        employeeId: request.employeeId,
        provider: "simulated-payroll",
        latencyMs,
      });
    }

    return {
      appliedAt: new Date().toISOString(),
      confirmationId: `pay_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      latencyMs,
    };
  }

  private pick<T>(items: ReadonlyArray<T>): T {
    const index = Math.min(
      items.length - 1,
      Math.floor(this.random() * items.length),
    );
    return items[index];
  }
}
