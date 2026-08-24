import { RedisMemoryServer } from "redis-memory-server";

/**
 * Provides a Redis URL for integration tests.
 *
 * In CI, `REDIS_URL` points at a GitHub Actions service container — using it
 * avoids downloading and booting a Redis binary once per suite, which is both
 * slow and redundant when a real server is already running.
 *
 * Locally, where no broker is expected to be running, an embedded server is
 * started instead so `pnpm test` works on a clean checkout with no setup.
 *
 * Either way the tests talk to a REAL Redis: BullMQ depends on Lua scripting,
 * blocking commands and atomic transactions that an in-memory JS fake does not
 * implement, so a fake would prove nothing about the ordering or retry logic.
 */
export interface RedisFixture {
  url: string;
  stop: () => Promise<void>;
}

export async function startRedis(): Promise<RedisFixture> {
  const external = process.env.REDIS_URL;

  if (external) {
    return {
      url: external,
      // Not ours to shut down — the CI runner owns the service container.
      stop: async () => undefined,
    };
  }

  const server = new RedisMemoryServer({});
  const host = await server.getHost();
  const port = await server.getPort();

  return {
    url: `redis://${host}:${port}`,
    stop: async () => {
      await server.stop();
    },
  };
}
