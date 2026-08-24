import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@payroll/database";
import { PayrollEventStatus } from "@payroll/shared";
import { PrismaService } from "../prisma/prisma.service";
import {
  EVENT_QUEUE,
  EventQueueProducer,
} from "../queue/event-queue.constants";
import { CreateEventDto } from "./dto/create-event.dto";
import { deriveIdempotencyKey, normalizeClientKey } from "./idempotency";

export interface SubmitEventResult {
  id: string;
  status: PayrollEventStatus;
  /** True when an existing event was returned instead of a new one. */
  duplicate: boolean;
}

/**
 * Prisma generates its enums as string-literal unions while `@payroll/shared`
 * exports real TypeScript enums. They hold identical values (asserted in
 * events.service.spec.ts), but are not mutually assignable, so the boundary
 * conversion happens here — keeping the Prisma type out of the public API.
 */
function toSharedStatus(status: string): PayrollEventStatus {
  return status as PayrollEventStatus;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_QUEUE) private readonly queue: EventQueueProducer,
  ) {}

  async submit(
    dto: CreateEventDto,
    idempotencyKeyHeader?: string,
  ): Promise<SubmitEventResult> {
    const idempotencyKey =
      normalizeClientKey(idempotencyKeyHeader) ?? deriveIdempotencyKey(dto);

    // Fast path: an already-known key short-circuits before any write. This is
    // an optimisation only — the unique constraint below is what actually
    // guarantees correctness under concurrent retries.
    const existing = await this.prisma.payrollEvent.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true },
    });

    if (existing) {
      this.logger.log(`duplicate submission for key ${idempotencyKey}`);
      // Deliberately NOT re-enqueued: the original submission already created
      // a job, and the event row is the single source of truth for whether
      // work remains outstanding.
      return {
        id: existing.id,
        status: toSharedStatus(existing.status),
        duplicate: true,
      };
    }

    let created: { id: string; status: string };
    try {
      // The event row and its first audit entry must both exist or neither
      // does, so they share one transaction.
      created = await this.prisma.$transaction(async (tx) => {
        const event = await tx.payrollEvent.create({
          data: {
            eventType: dto.eventType,
            employeeId: dto.employeeId,
            effectiveDate: new Date(dto.effectiveDate),
            payload: dto.payload as unknown as Prisma.InputJsonValue,
            idempotencyKey,
            status: PayrollEventStatus.PENDING,
          },
          select: { id: true, status: true },
        });

        await tx.payrollEventHistory.create({
          data: {
            eventId: event.id,
            previousStatus: null,
            newStatus: PayrollEventStatus.PENDING,
            actor: "api",
          },
        });

        return event;
      });
    } catch (error) {
      // A concurrent request with the same key won the race between our
      // findUnique above and this insert. The unique index on
      // idempotency_key turns that race into a P2002 rather than a duplicate
      // row, so we resolve it by returning the winner's event.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const winner = await this.prisma.payrollEvent.findUniqueOrThrow({
          where: { idempotencyKey },
          select: { id: true, status: true },
        });
        this.logger.log(`lost idempotency race for key ${idempotencyKey}`);
        return {
          id: winner.id,
          status: toSharedStatus(winner.status),
          duplicate: true,
        };
      }
      throw error;
    }

    // Enqueue AFTER the transaction commits — never inside it.
    //
    // If the job were added while the transaction was still open, the worker
    // (a separate process, often faster than our commit) could pick it up and
    // query for an event id that is not yet visible to any other session, or
    // that never becomes visible because the transaction rolled back. That is
    // a lost or spuriously-failed event.
    //
    // Enqueueing after commit inverts the failure mode into a safe one: if
    // this call fails, the event is durably PENDING in Postgres and the
    // worker's sweep for stale PENDING rows will pick it up. At-least-once
    // delivery is recoverable; a dangling job pointing at a non-existent row
    // is not.
    try {
      await this.queue.enqueueEvent({ eventId: created.id });
    } catch (error) {
      this.logger.error(
        `event ${created.id} committed but enqueue failed; it will be recovered by the PENDING sweep`,
        error instanceof Error ? error.stack : String(error),
      );
      // Deliberately not rethrown: the event is safely persisted, so the
      // client should get its 202. Surfacing a 500 here would invite a retry
      // that the idempotency key would collapse anyway.
    }

    return {
      id: created.id,
      status: toSharedStatus(created.status),
      duplicate: false,
    };
  }
}
