import { PrismaClient } from "@payroll/database";
import { createRedisConnection } from "@payroll/queue";
import type { Redis } from "@payroll/queue";
import { StructuredLogger } from "@payroll/shared";
import { startRedis, type RedisFixture } from "./redis-fixture";
import { WorkerHealthServer } from "../src/health/health-server";

/**
 * The worker's HTTP health endpoint, against a real Redis and real Postgres.
 *
 * Probing is the whole feature, so stubbing the dependencies would test
 * nothing: the point is that a genuinely unreachable database or a closed
 * BullMQ consumer is reported as down rather than silently passing.
 */
describe("[integration] worker health server", () => {
  let redisFixture: RedisFixture;
  let redis: Redis;
  let prisma: PrismaClient;
  let server: WorkerHealthServer;
  let running = true;

  // A port unlikely to collide with the API or another suite.
  const PORT = 3199;
  const BASE = `http://127.0.0.1:${PORT}`;

  beforeAll(async () => {
    redisFixture = await startRedis();
    redis = createRedisConnection(redisFixture.url);

    prisma = new PrismaClient({
      datasources: {
        db: {
          url:
            process.env.DATABASE_URL ??
            "postgresql://payroll:payroll@localhost:55432/payroll",
        },
      },
    });
    await prisma.$connect();

    server = new WorkerHealthServer({
      port: PORT,
      prisma,
      redis,
      isWorkerRunning: () => running,
      logger: new StructuredLogger({ write: () => {} }),
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    await redis.quit();
    await prisma.$disconnect();
    await redisFixture.stop();
  });

  beforeEach(() => {
    running = true;
  });

  it("returns 200 with every dependency up", async () => {
    const res = await fetch(`${BASE}/health`);
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, { status: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks.postgres.status).toBe("up");
    expect(body.checks.redis.status).toBe("up");
    expect(body.checks.worker.status).toBe("up");
  });

  it("reports latency and uptime for observability", async () => {
    const res = await fetch(`${BASE}/health`);
    const body = (await res.json()) as {
      uptimeSeconds: number;
      timestamp: string;
      checks: Record<string, { latencyMs: number }>;
    };

    expect(typeof body.uptimeSeconds).toBe("number");
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(typeof body.checks.postgres.latencyMs).toBe("number");
  });

  it("returns 503 when the BullMQ consumer has stopped", async () => {
    // A live process whose consumer has closed is doing no work, so it must
    // not report healthy — this is the case a heartbeat file would miss.
    running = false;

    const res = await fetch(`${BASE}/health`);
    const body = (await res.json()) as {
      status: string;
      checks: Record<string, { status: string; error?: string }>;
    };

    expect(res.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.worker.status).toBe("down");
    expect(body.checks.worker.error).toContain("not running");
    // Postgres and Redis are still fine, so the breakdown localises the fault.
    expect(body.checks.postgres.status).toBe("up");
  });

  it("serves /healthz as an alias", async () => {
    // Kubernetes convention; both spellings answer so a probe config that
    // assumes either one works.
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
  });

  it("returns 404 for any other path", async () => {
    const res = await fetch(`${BASE}/not-a-route`);
    const body = (await res.json()) as { statusCode: number };

    expect(res.status).toBe(404);
    expect(body.statusCode).toBe(404);
  });

  it("reports Postgres as down when the database is unreachable", async () => {
    // Points at a closed port, so the probe fails for real rather than via a
    // stub — proving the check actually exercises the connection.
    const brokenPrisma = new PrismaClient({
      datasources: {
        db: { url: "postgresql://nobody:nobody@127.0.0.1:1/none" },
      },
    });

    const brokenServer = new WorkerHealthServer({
      port: PORT + 1,
      prisma: brokenPrisma,
      redis,
      isWorkerRunning: () => true,
      logger: new StructuredLogger({ write: () => {} }),
    });
    await brokenServer.start();

    try {
      const report = await brokenServer.check();
      expect(report.status).toBe("degraded");
      expect(report.checks.postgres.status).toBe("down");
      expect(report.checks.postgres.error).toBeTruthy();
      // Redis is shared and still healthy.
      expect(report.checks.redis.status).toBe("up");
    } finally {
      await brokenServer.stop();
      await brokenPrisma.$disconnect().catch(() => undefined);
    }
  });

  it("stops listening after stop()", async () => {
    const temp = new WorkerHealthServer({
      port: PORT + 2,
      prisma,
      redis,
      isWorkerRunning: () => true,
      logger: new StructuredLogger({ write: () => {} }),
    });
    await temp.start();
    expect((await fetch(`http://127.0.0.1:${PORT + 2}/health`)).status).toBe(200);

    await temp.stop();
    // A stopped server must refuse connections, so a probe against a drained
    // worker fails rather than reporting stale health.
    await expect(fetch(`http://127.0.0.1:${PORT + 2}/health`)).rejects.toThrow();
  });
});
