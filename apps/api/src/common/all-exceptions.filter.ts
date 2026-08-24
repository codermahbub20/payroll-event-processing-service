import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { StructuredLogger } from "@payroll/shared";
import type { Request, Response } from "express";

/** Consistent error body for every failure the API returns. */
export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string;
  timestamp: string;
  path: string;
  /** Field-level validation failures, when the pipe produced them. */
  details?: string[];
}

/**
 * Converts every unhandled exception into one JSON shape.
 *
 * Without this, Nest renders an unhandled error as a bare 500 whose body
 * varies by error type, and in some configurations includes the stack. A
 * stack trace on a payroll API is an information leak: it exposes file paths,
 * dependency versions and sometimes query fragments containing real data.
 *
 * The stack is logged (where operators can see it) but never returned.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger = new StructuredLogger({
      service: "payroll-api",
      context: "AllExceptionsFilter",
    }),
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, error, message, details } = this.describe(exception);

    const body: ErrorResponseBody = {
      statusCode,
      error,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(details ? { details } : {}),
    };

    // 5xx means we broke; 4xx means the caller did. Only the former is worth
    // waking someone for, so they log at different levels.
    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({
        event: "request_failed",
        message,
        method: request.method,
        path: request.url,
        statusCode,
        // Logged, never returned to the caller.
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    } else {
      this.logger.warn({
        event: "request_rejected",
        message,
        method: request.method,
        path: request.url,
        statusCode,
      });
    }

    response.status(statusCode).json(body);
  }

  /** Normalises any thrown value into the response fields. */
  private describe(exception: unknown): {
    statusCode: number;
    error: string;
    message: string;
    details?: string[];
  } {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === "string") {
        return { statusCode, error: httpErrorName(statusCode), message: payload };
      }

      const record = payload as Record<string, unknown>;

      // Preserve bodies already in our shape — notably the validation pipe's,
      // which carries a `details` array worth keeping.
      return {
        statusCode,
        error:
          typeof record.error === "string"
            ? record.error
            : httpErrorName(statusCode),
        message: normalizeMessage(record.message) ?? exception.message,
        details: Array.isArray(record.details)
          ? (record.details as string[])
          : undefined,
      };
    }

    // Anything else is a bug on our side. The real message is deliberately
    // withheld: it can contain connection strings, SQL, or payload fragments.
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    };
  }
}

/** Nest sometimes puts an array in `message`; flatten it to one string. */
function normalizeMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join("; ");
  return undefined;
}

function httpErrorName(statusCode: number): string {
  const names: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    503: "Service Unavailable",
  };
  return names[statusCode] ?? "Error";
}
