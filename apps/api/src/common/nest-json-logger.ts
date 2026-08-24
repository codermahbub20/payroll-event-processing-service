import type { LoggerService, LogLevel as NestLogLevel } from "@nestjs/common";
import { StructuredLogger } from "@payroll/shared";

/**
 * Adapts Nest's LoggerService onto the shared StructuredLogger, so framework
 * output (route mapping, bootstrap, lifecycle errors) lands in the same JSON
 * format as application logs.
 *
 * Without this a log aggregator sees two formats from one process, and the
 * framework half — which carries the startup failures worth alerting on — is
 * the half that stays unparseable.
 */
export class NestJsonLogger implements LoggerService {
  constructor(
    private readonly logger = new StructuredLogger({ service: "payroll-api" }),
  ) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context: context ?? "Nest", message: stringify(message) });
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.logger.error({
      context: context ?? "Nest",
      message: stringify(message),
      stack,
    });
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context: context ?? "Nest", message: stringify(message) });
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context: context ?? "Nest", message: stringify(message) });
  }

  verbose(message: unknown, context?: string): void {
    this.logger.debug({ context: context ?? "Nest", message: stringify(message) });
  }

  setLogLevels?(_levels: NestLogLevel[]): void {
    // Level filtering is handled by StructuredLogger via LOG_LEVEL.
  }
}

function stringify(message: unknown): string {
  if (typeof message === "string") return message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}
