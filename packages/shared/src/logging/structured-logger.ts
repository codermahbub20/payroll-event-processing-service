/**
 * Structured JSON logging, shared by the API and the worker.
 *
 * One line per record, machine-parseable, so a log aggregator can answer
 * "which events failed permanently today, and why?" without regex-scraping
 * prose. Both services emit the same field names, so a single query works
 * across the whole pipeline — the reason this lives in @payroll/shared rather
 * than being reimplemented on each side.
 *
 * Written straight to stdout rather than through Nest's Logger, whose default
 * formatter wraps output in ANSI colour codes and a prefix, which would make
 * the JSON unparseable.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Fields every record carries. */
export interface BaseLogFields {
  /** Emitting component — "EventsService", "EventProcessor", "HealthService". */
  context?: string;
  /** Human-readable summary. */
  message?: string;
  /** Correlates every line about one payroll event. */
  eventId?: string;
  /** Correlates lines about one employee across events. */
  employeeId?: string;
  /** Machine-readable discriminator, e.g. "processing_succeeded". */
  event?: string;
  [key: string]: unknown;
}

export interface StructuredLoggerOptions {
  /** Injectable sink so tests can capture lines instead of writing stdout. */
  write?: (line: string) => void;
  /** Emitting service — "payroll-api" or "payroll-worker". */
  service?: string;
  /** Default context applied when a record does not set its own. */
  context?: string;
  /** Records below this level are dropped. */
  minLevel?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class StructuredLogger {
  private readonly writeLine: (line: string) => void;
  private readonly service: string;
  private readonly defaultContext?: string;
  private readonly minLevel: LogLevel;

  constructor(options: StructuredLoggerOptions = {}) {
    this.writeLine = options.write ?? defaultWrite;
    this.service = options.service ?? "payroll";
    this.defaultContext = options.context;
    this.minLevel = options.minLevel ?? envLogLevel() ?? "info";
  }

  /**
   * Returns a logger that stamps `context` (and any other fields) onto every
   * record, so callers do not repeat them at each site.
   */
  child(context: string, bindings: BaseLogFields = {}): StructuredLogger {
    const parent = this;
    const child = new StructuredLogger({
      write: (line) => parent.writeLine(line),
      service: this.service,
      context,
      minLevel: this.minLevel,
    });
    // Merge parent bindings into every emitted record.
    const originalEmit = child.emit.bind(child);
    child.emit = (level: LogLevel, fields: BaseLogFields) =>
      originalEmit(level, { ...bindings, ...fields });
    return child;
  }

  debug(fields: BaseLogFields | string): void {
    this.emit("debug", normalize(fields));
  }

  info(fields: BaseLogFields | string): void {
    this.emit("info", normalize(fields));
  }

  warn(fields: BaseLogFields | string): void {
    this.emit("warn", normalize(fields));
  }

  error(fields: BaseLogFields | string): void {
    this.emit("error", normalize(fields));
  }

  /**
   * Emits at a level derived from the record's `event` name, preserving the
   * worker's original call style.
   */
  log(fields: BaseLogFields): void {
    this.emit(levelForEvent(fields.event), fields);
  }

  protected emit(level: LogLevel, fields: BaseLogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const { context, ...rest } = fields;

    this.writeLine(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        service: this.service,
        context: context ?? this.defaultContext,
        ...rest,
      }),
    );
  }
}

function normalize(fields: BaseLogFields | string): BaseLogFields {
  return typeof fields === "string" ? { message: fields } : fields;
}

/**
 * `console` and `process` are reached through globalThis because this package
 * is environment-agnostic and deliberately carries no @types/node — adding it
 * would let Node-only APIs leak into code the frontend may one day import.
 */
function defaultWrite(line: string): void {
  const globalConsole = (globalThis as { console?: { log?: (v: string) => void } })
    .console;
  globalConsole?.log?.(line);
}

function envLogLevel(): LogLevel | undefined {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  const raw = env?.LOG_LEVEL;
  return raw && raw in LEVEL_ORDER ? (raw as LogLevel) : undefined;
}

/** Failure events log louder, so a log level filter still surfaces them. */
function levelForEvent(event?: string): LogLevel {
  if (!event) return "info";
  if (event.endsWith("_failed_permanent")) return "error";
  if (event.endsWith("_failed_temporary")) return "warn";
  if (event === "processing_deferred") return "debug";
  return "info";
}
