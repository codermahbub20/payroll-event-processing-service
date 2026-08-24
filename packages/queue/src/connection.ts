import IORedis, { type Redis, type RedisOptions } from "ioredis";

/**
 * Creates a Redis connection configured for BullMQ.
 *
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ: its blocking commands
 * (BRPOPLPUSH and friends) sit open far longer than ioredis's default retry
 * budget, and the default would abort them mid-wait.
 */
export function createRedisConnection(
  url: string,
  options: RedisOptions = {},
): Redis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...options,
  });
}

export type { Redis, RedisOptions };
