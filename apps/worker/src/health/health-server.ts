import { createServer, type Server } from "node:http";
import { PrismaClient } from "@payroll/database";
import type { Redis } from "@payroll/queue";
import { StructuredLogger } from "@payroll/shared";

export interface WorkerHealthOptions {
  port?: number;
  prisma: PrismaClient;
  redis: Redis;
  /** Reports whether the BullMQ worker is running and connected. */
  isWorkerRunning: () => boolean;
  logger?: StructuredLogger;
}

export interface WorkerHealthReport {
  status: "ok" | "degraded";
  timestamp: string;
  uptimeSeconds: number;
  checks: Record<
    string,
    { status: "up" | "down"; latencyMs: number; error?: string }
  >;
}

const PROBE_TIMEOUT_MS = 3000;

/**
 * Minimal HTTP health endpoint for the worker.
 *
 * ## Why HTTP rather than a heartbeat file
 *
 * The worker has no HTTP surface of its own, so a file-based heartbeat
 * (touch a file each loop, have a probe check its mtime) is tempting and
 * cheaper. HTTP was chosen anyway because:
 *
 *   - **It matches how the worker is actually run.** Under docker-compose or
 *     Kubernetes, `healthcheck`/`livenessProbe` speak HTTP natively. A file
 *     check needs `exec` into the container, which is slower, needs a shell in
 *     a distroless-ish image, and reports less.
 *   - **A heartbeat file proves the wrong thing.** It says the process loop is
 *     running. It cannot say Postgres is reachable or Redis is connected — a
 *     worker happily looping while unable to reach its database is exactly the
 *     failure an operator needs to see, and a heartbeat would report it green.
 *   - **Files lie across restarts.** A stale file from a previous process
 *     survives a crash; the probe then reads a recent-enough mtime and
 *     declares health while nothing is running. Getting that right needs
 *     PID-liveness checks that HTTP gets for free — if nothing is listening,
 *     the probe fails.
 *
 * The cost is a listening socket in the worker. It binds a health-only port
 * serving one route, so the added surface is negligible.
 */
export class WorkerHealthServer {
  private server?: Server;
  private readonly startedAt = Date.now();
  private readonly port: number;
  private readonly logger: StructuredLogger;

  constructor(private readonly options: WorkerHealthOptions) {
    this.port = options.port ?? 3001;
    this.logger =
      options.logger ??
      new StructuredLogger({
        service: "payroll-worker",
        context: "WorkerHealthServer",
      });
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      if (req.url !== "/health" && req.url !== "/healthz") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ statusCode: 404, error: "Not Found" }));
        return;
      }

      void this.check().then((report) => {
        res.writeHead(report.status === "ok" ? 200 : 503, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify(report));
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => resolve());
    });

    this.logger.info({
      event: "worker_health_started",
      message: `worker health endpoint listening on port ${this.port}`,
      port: this.port,
    });
  }

  async check(): Promise<WorkerHealthReport> {
    const [postgres, redis] = await Promise.all([
      probe(() => this.options.prisma.$queryRaw`SELECT 1`),
      probe(async () => {
        const pong = await this.options.redis.ping();
        if (pong !== "PONG") throw new Error(`unexpected PING reply: ${pong}`);
      }),
    ]);

    const running = this.options.isWorkerRunning();
    const worker = {
      status: (running ? "up" : "down") as "up" | "down",
      latencyMs: 0,
      ...(running ? {} : { error: "BullMQ worker is not running" }),
    };

    const checks = { postgres, redis, worker };
    const degraded = Object.values(checks).some((c) => c.status === "down");

    return {
      status: degraded ? "degraded" : "ok",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = undefined;
  }
}

/** Runs a probe with a timeout, never throwing. */
async function probe(
  fn: () => Promise<unknown>,
): Promise<{ status: "up" | "down"; latencyMs: number; error?: string }> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("probe timed out")),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return { status: "up", latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: "down",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
