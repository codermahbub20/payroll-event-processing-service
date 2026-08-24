import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  EVENT_QUEUE,
  EventQueueProducer,
} from "../queue/event-queue.constants";

export type DependencyStatus = "up" | "down";

export interface DependencyCheck {
  status: DependencyStatus;
  /** Round-trip time of the probe. */
  latencyMs: number;
  /** Present when the dependency is down. */
  error?: string;
  /** Probe-specific extras, e.g. queue job counts. */
  details?: Record<string, unknown>;
}

export interface HealthReport {
  status: "ok" | "degraded";
  timestamp: string;
  uptimeSeconds: number;
  checks: Record<string, DependencyCheck>;
}

/** Probe timeout. Without one a hung TCP connect would hang the whole check. */
const PROBE_TIMEOUT_MS = 3000;

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_QUEUE) private readonly queue: EventQueueProducer,
  ) {}

  /**
   * Probes every dependency and reports a per-dependency breakdown.
   *
   * All probes run concurrently: a serial check would take as long as the sum
   * of the timeouts, and a health endpoint that is itself slow gets killed by
   * the very load balancer it is meant to inform.
   */
  async check(): Promise<HealthReport> {
    const [postgres, queue] = await Promise.all([
      this.checkPostgres(),
      this.checkQueue(),
    ]);

    const checks: Record<string, DependencyCheck> = {
      postgres,
      redis: {
        status: queue.redis.status,
        latencyMs: queue.redis.latencyMs,
        ...(queue.redis.error ? { error: queue.redis.error } : {}),
      },
      queue: queue.bull,
    };

    // Every dependency here is critical: without Postgres the API cannot
    // accept events at all, and without Redis/BullMQ accepted events would
    // never be processed. Reporting "ok" while either is down would let a
    // load balancer keep routing traffic into a service that silently drops
    // work.
    const degraded = Object.values(checks).some((c) => c.status === "down");

    return {
      status: degraded ? "degraded" : "ok",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }

  /**
   * `SELECT 1` rather than a table read: it proves the connection and the
   * driver work without depending on any schema object, so a migration in
   * flight cannot make health flap.
   */
  private async checkPostgres(): Promise<DependencyCheck> {
    const startedAt = Date.now();
    try {
      await withTimeout(
        this.prisma.$queryRaw`SELECT 1`,
        PROBE_TIMEOUT_MS,
        "postgres probe timed out",
      );
      return { status: "up", latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: "down",
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Splits the queue probe into its Redis and BullMQ halves. */
  private async checkQueue(): Promise<{
    redis: DependencyCheck;
    bull: DependencyCheck;
  }> {
    const startedAt = Date.now();

    try {
      const health = await withTimeout(
        this.queue.checkHealth(),
        PROBE_TIMEOUT_MS,
        "queue probe timed out",
      );
      const latencyMs = Date.now() - startedAt;

      return {
        redis: {
          status: health.redis ? "up" : "down",
          latencyMs,
          ...(health.redis
            ? {}
            : { error: health.error ?? "redis is not reachable" }),
        },
        bull: {
          status: health.queue ? "up" : "down",
          latencyMs,
          ...(health.queue
            ? { details: { counts: health.counts ?? {} } }
            : { error: health.error ?? "queue is not reachable" }),
        },
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      return {
        redis: { status: "down", latencyMs, error: message },
        bull: { status: "down", latencyMs, error: message },
      };
    }
  }
}

/** Rejects if `promise` has not settled within `ms`. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
