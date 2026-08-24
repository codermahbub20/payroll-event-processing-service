import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Intentionally empty for now. Seed data will land here once the event
 * ingestion API and worker pipeline are implemented.
 */
async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("[seed] nothing to seed yet");
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("[seed] failed", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
