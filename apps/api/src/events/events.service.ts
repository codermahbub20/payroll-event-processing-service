import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@payroll/database";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";
import { PrismaService } from "../prisma/prisma.service";
import {
  EVENT_QUEUE,
  EventQueueProducer,
} from "../queue/event-queue.constants";
import { CreateEventDto } from "./dto/create-event.dto";
import {
  EventDetailDto,
  EventHistoryEntryDto,
  EventSummaryDto,
  PaginatedEventsDto,
} from "./dto/event-response.dto";
import {
  DEFAULT_PAGE_SIZE,
  ListEventsQueryDto,
} from "./dto/list-events-query.dto";
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
 * __tests__/enum-parity.spec.ts), but are not mutually assignable, so the
 * boundary conversion happens here — keeping the Prisma type out of the
 * public API.
 */
function toSharedStatus(status: string): PayrollEventStatus {
  return status as PayrollEventStatus;
}

/**
 * `effective_date` is a Postgres `date`, which the driver hands back as a
 * Date at UTC midnight. Emitting a full ISO timestamp would let a client in a
 * negative-offset timezone render it as the previous day — reintroducing
 * exactly the drift the `date` column type was chosen to avoid. Only the
 * calendar part is serialised, read in UTC.
 */
function toCalendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

type PayrollEventRow = {
  id: string;
  eventType: string;
  employeeId: string;
  effectiveDate: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  startedProcessingAt: Date | null;
  completedAt: Date | null;
  attemptCount: number;
};

function toSummaryDto(row: PayrollEventRow): EventSummaryDto {
  return {
    id: row.id,
    eventType: row.eventType as PayrollEventType,
    employeeId: row.employeeId,
    effectiveDate: toCalendarDate(row.effectiveDate),
    status: toSharedStatus(row.status),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedProcessingAt: row.startedProcessingAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    attemptCount: row.attemptCount,
  };
}

function toHistoryEntryDto(row: {
  id: string;
  previousStatus: string | null;
  newStatus: string;
  details: unknown;
  actor: string | null;
  createdAt: Date;
}): EventHistoryEntryDto {
  return {
    id: row.id,
    previousStatus: row.previousStatus
      ? toSharedStatus(row.previousStatus)
      : null,
    newStatus: toSharedStatus(row.newStatus),
    details: (row.details as Record<string, unknown> | null) ?? null,
    actor: row.actor,
    createdAt: row.createdAt.toISOString(),
  };
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

  /**
   * Full detail for a single event, including its status-transition timeline.
   *
   * Throws NotFoundException for an unknown id — translated to a 404 body by
   * Nest's exception layer.
   */
  async findOne(id: string): Promise<EventDetailDto> {
    const event = await this.prisma.payrollEvent.findUnique({
      where: { id },
      include: {
        // Oldest first: the timeline reads naturally top-to-bottom, and the
        // (event_id, created_at) index serves this ordering directly.
        history: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!event) {
      throw new NotFoundException({
        statusCode: HttpStatus.NOT_FOUND,
        error: "Not Found",
        message: `Event ${id} not found`,
      });
    }

    const history = event.history.map(toHistoryEntryDto);

    // Failure/result are surfaced as dedicated fields so a client does not have
    // to scan the timeline itself. Both are derived from the LATEST matching
    // transition: an event that failed, retried and failed again should report
    // the most recent failure, not the first.
    const failure =
      [...history]
        .reverse()
        .find(
          (entry) =>
            entry.newStatus === PayrollEventStatus.FAILED_TEMPORARY ||
            entry.newStatus === PayrollEventStatus.FAILED_PERMANENT,
        ) ?? null;

    const result =
      [...history]
        .reverse()
        .find((entry) => entry.newStatus === PayrollEventStatus.SUCCEEDED) ??
      null;

    return {
      ...toSummaryDto(event),
      payload: event.payload as Record<string, unknown>,
      idempotencyKey: event.idempotencyKey,
      lastError: event.lastError,
      nextAttemptAt: event.nextAttemptAt?.toISOString() ?? null,
      failure,
      result,
      history,
    };
  }

  /** Paginated, filterable list of events for the submitted-events view. */
  async findMany(query: ListEventsQueryDto): Promise<PaginatedEventsDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    // Undefined keys are omitted by Prisma, so absent filters widen the query
    // rather than matching NULL.
    const where = {
      employeeId: query.employeeId,
      status: query.status,
      eventType: query.eventType,
    };

    // Count and page are issued in one round trip; they are independent reads
    // so there is no ordering requirement between them.
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payrollEvent.count({ where }),
      this.prisma.payrollEvent.findMany({
        where,
        // Newest first — the frontend list shows most-recent submissions at the
        // top. `id` breaks ties so pagination is stable when two events share a
        // created_at, which would otherwise let a row appear on two pages.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    return {
      data: rows.map(toSummaryDto),
      meta: {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1 && total > 0,
      },
    };
  }
}
