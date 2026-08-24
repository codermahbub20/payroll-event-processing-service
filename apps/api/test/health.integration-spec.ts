import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { HealthController } from "../src/health/health.controller";
import { HealthService } from "../src/health/health.service";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  EVENT_QUEUE,
  EventQueueProducer,
  QueueHealth,
} from "../src/queue/event-queue.constants";

/** Queue stand-in whose health can be flipped per test. */
class FakeQueue implements EventQueueProducer {
  health: QueueHealth = {
    configured: true,
    redis: true,
    queue: true,
    counts: { waiting: 0, active: 0, completed: 5, failed: 0 },
  };
  /** When set, checkHealth rejects instead of resolving. */
  throwWith?: Error;
  /** When set, checkHealth hangs for this long — exercises the probe timeout. */
  hangMs?: number;
  /** Timers created by hanging probes, cleared in afterAll. */
  private readonly pendingTimers = new Set<NodeJS.Timeout>();

  async enqueueEvent(): Promise<void> {}

  async checkHealth(): Promise<QueueHealth> {
    if (this.hangMs) {
      await new Promise((resolve) => {
        // Tracked and unref'd: the probe abandons this promise on timeout, so
        // an untracked timer would keep the Jest process alive after the run.
        const timer = setTimeout(resolve, this.hangMs);
        timer.unref?.();
        this.pendingTimers.add(timer);
      });
    }
    if (this.throwWith) throw this.throwWith;
    return this.health;
  }

  clearPendingTimers(): void {
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }
}

describe("[integration] GET /health", () => {
  let app: INestApplication;
  let queue: FakeQueue;
  let prisma: PrismaService;

  beforeAll(async () => {
    queue = new FakeQueue();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        PrismaService,
        { provide: EVENT_QUEUE, useValue: queue },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    queue.clearPendingTimers();
    await app.close();
  });

  beforeEach(() => {
    queue.health = {
      configured: true,
      redis: true,
      queue: true,
      counts: { waiting: 0, active: 0, completed: 5, failed: 0 },
    };
    queue.throwWith = undefined;
    queue.hangMs = undefined;
  });

  describe("happy path", () => {
    it("returns 200 with every dependency up", async () => {
      const res = await request(app.getHttpServer()).get("/health").expect(200);

      expect(res.body.status).toBe("ok");
      expect(res.body.checks.postgres.status).toBe("up");
      expect(res.body.checks.redis.status).toBe("up");
      expect(res.body.checks.queue.status).toBe("up");
    });

    it("reports a per-dependency breakdown with latencies", async () => {
      const res = await request(app.getHttpServer()).get("/health").expect(200);

      for (const name of ["postgres", "redis", "queue"]) {
        expect(res.body.checks[name]).toBeDefined();
        expect(typeof res.body.checks[name].latencyMs).toBe("number");
        // A healthy dependency carries no error field.
        expect(res.body.checks[name].error).toBeUndefined();
      }
    });

    it("includes a timestamp and uptime", async () => {
      const res = await request(app.getHttpServer()).get("/health").expect(200);

      expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(typeof res.body.uptimeSeconds).toBe("number");
      expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it("surfaces queue job counts for backlog visibility", async () => {
      const res = await request(app.getHttpServer()).get("/health").expect(200);

      expect(res.body.checks.queue.details.counts).toMatchObject({
        waiting: 0,
        completed: 5,
      });
    });

    it("really probes Postgres — a failing query flips it to down", async () => {
      // Proves the check is not hard-coded: break the DB call and it reports.
      const spy = jest
        .spyOn(prisma, "$queryRaw")
        .mockRejectedValueOnce(new Error("connection refused"));

      const res = await request(app.getHttpServer()).get("/health").expect(503);

      expect(res.body.checks.postgres.status).toBe("down");
      expect(res.body.checks.postgres.error).toContain("connection refused");
      spy.mockRestore();
    });
  });

  describe("Redis down", () => {
    it("returns 503 when Redis is unreachable", async () => {
      queue.health = {
        configured: true,
        redis: false,
        queue: false,
        error: "connect ECONNREFUSED 127.0.0.1:6379",
      };

      const res = await request(app.getHttpServer()).get("/health").expect(503);

      expect(res.body.status).toBe("degraded");
      expect(res.body.checks.redis.status).toBe("down");
      expect(res.body.checks.redis.error).toContain("ECONNREFUSED");
    });

    it("still reports Postgres as up, so the breakdown localises the fault", async () => {
      queue.health = {
        configured: true,
        redis: false,
        queue: false,
        error: "connect ECONNREFUSED 127.0.0.1:6379",
      };

      const res = await request(app.getHttpServer()).get("/health").expect(503);

      // The point of a breakdown: an operator sees Redis is the problem
      // without having to check each dependency by hand.
      expect(res.body.checks.postgres.status).toBe("up");
      expect(res.body.checks.queue.status).toBe("down");
    });

    it("returns 503 when the queue probe throws outright", async () => {
      queue.throwWith = new Error("Stream isn't writeable");

      const res = await request(app.getHttpServer()).get("/health").expect(503);

      expect(res.body.checks.redis.status).toBe("down");
      expect(res.body.checks.queue.status).toBe("down");
      expect(res.body.checks.redis.error).toContain("Stream isn't writeable");
    });

    it("returns 503 when Redis is up but BullMQ is not usable", async () => {
      // Redis answering PING does not prove the queue works — wrong database,
      // evicted keys, or a Lua script that will not load all look like this.
      queue.health = {
        configured: true,
        redis: true,
        queue: false,
        error: "NOSCRIPT No matching script",
      };

      const res = await request(app.getHttpServer()).get("/health").expect(503);

      expect(res.body.checks.redis.status).toBe("up");
      expect(res.body.checks.queue.status).toBe("down");
    });

    it("returns 503 when no broker is configured at all", async () => {
      // A deploy missing REDIS_URL is broken, not healthy: events would be
      // accepted and then never processed.
      queue.health = {
        configured: false,
        redis: false,
        queue: false,
        error: "REDIS_URL is not configured",
      };

      const res = await request(app.getHttpServer()).get("/health").expect(503);
      expect(res.body.checks.queue.error).toContain("REDIS_URL");
    });

    it("does not hang when a probe never settles", async () => {
      // A health endpoint slower than the load balancer's timeout is worse
      // than useless: the probe is killed and the instance looks dead anyway.
      queue.hangMs = 10_000;

      const startedAt = Date.now();
      const res = await request(app.getHttpServer()).get("/health").expect(503);
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(6000);
      expect(res.body.checks.redis.status).toBe("down");
      expect(res.body.checks.redis.error).toMatch(/timed out/i);
    });
  });
});
