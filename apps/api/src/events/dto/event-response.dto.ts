import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";

/**
 * Response DTOs. These are documentation/serialisation shapes only — they are
 * never validated as input, so they carry no class-validator decorators.
 */

export class EventSummaryDto {
  @ApiProperty({ format: "uuid", example: "9c3a4a1e-2b8d-4c1e-9f4a-3f6d0a2c5a70" })
  id!: string;

  @ApiProperty({ enum: PayrollEventType })
  eventType!: PayrollEventType;

  @ApiProperty({ format: "uuid", example: "3f6d0a2c-9c3a-4a1e-9f4a-2b8d6c1e5a70" })
  employeeId!: string;

  @ApiProperty({
    description: "Calendar date the change takes effect (YYYY-MM-DD).",
    example: "2026-09-01",
  })
  effectiveDate!: string;

  @ApiProperty({ enum: PayrollEventStatus })
  status!: PayrollEventStatus;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ format: "date-time" })
  updatedAt!: string;

  @ApiPropertyOptional({
    format: "date-time",
    nullable: true,
    description: "When a worker claimed the event; null while PENDING.",
  })
  startedProcessingAt!: string | null;

  @ApiPropertyOptional({
    format: "date-time",
    nullable: true,
    description: "When the event reached a terminal status.",
  })
  completedAt!: string | null;

  @ApiProperty({
    description: "How many processing attempts have been made.",
    example: 0,
  })
  attemptCount!: number;
}

export class EventHistoryEntryDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiPropertyOptional({
    enum: PayrollEventStatus,
    nullable: true,
    description: "Null on the creation entry (null -> PENDING).",
  })
  previousStatus!: PayrollEventStatus | null;

  @ApiProperty({ enum: PayrollEventStatus })
  newStatus!: PayrollEventStatus;

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    nullable: true,
    description:
      "Transition context — error details on failure, downstream response on success.",
  })
  details!: Record<string, unknown> | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'What caused the transition — "api", "worker:<id>".',
    example: "worker:1",
  })
  actor!: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;
}

export class EventDetailDto extends EventSummaryDto {
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "Type-specific fields; shape depends on eventType.",
    example: { iban: "DE89370400440532013000" },
  })
  payload!: Record<string, unknown>;

  @ApiProperty({
    description: "Idempotency key this event was recorded under.",
    example: "derived:3ce6d9c4b37ea9033570...",
  })
  idempotencyKey!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "Most recent error message, denormalised from the event row for quick triage.",
  })
  lastError!: string | null;

  @ApiPropertyOptional({
    format: "date-time",
    nullable: true,
    description: "When a FAILED_TEMPORARY event becomes eligible for retry.",
  })
  nextAttemptAt!: string | null;

  @ApiPropertyOptional({
    type: () => EventHistoryEntryDto,
    nullable: true,
    description:
      "Details of the most recent failure, or null if the event has never failed.",
  })
  failure!: EventHistoryEntryDto | null;

  @ApiPropertyOptional({
    type: () => EventHistoryEntryDto,
    nullable: true,
    description:
      "Details of the successful completion, or null if not yet succeeded.",
  })
  result!: EventHistoryEntryDto | null;

  @ApiProperty({
    type: () => [EventHistoryEntryDto],
    description: "Full status-transition timeline, oldest first.",
  })
  history!: EventHistoryEntryDto[];
}

export class PaginationMetaDto {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ description: "Total matching events.", example: 42 })
  total!: number;

  @ApiProperty({ description: "Total pages at this page size.", example: 3 })
  totalPages!: number;

  @ApiProperty({ example: true })
  hasNextPage!: boolean;

  @ApiProperty({ example: false })
  hasPreviousPage!: boolean;
}

export class PaginatedEventsDto {
  @ApiProperty({ type: () => [EventSummaryDto] })
  data!: EventSummaryDto[];

  @ApiProperty({ type: () => PaginationMetaDto })
  meta!: PaginationMetaDto;
}

/** Shape returned by the global validation pipe and 404 handler. */
export class ErrorResponseDto {
  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiProperty({ example: "Not Found" })
  error!: string;

  @ApiProperty({ example: "Event 9c3a4a1e-... not found" })
  message!: string;

  @ApiPropertyOptional({
    type: [String],
    description: "Field-level validation failures, present on 400 responses.",
    example: ["eventType: eventType must be one of: BANK_ACCOUNT_CHANGE, ..."],
  })
  details?: string[];
}
