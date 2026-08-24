import { PrismaClient } from "@prisma/client";

/**
 * Single PrismaClient per process. Re-instantiating on every import would
 * exhaust the Postgres connection pool, which bites hardest under the
 * worker's tight polling loop.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
