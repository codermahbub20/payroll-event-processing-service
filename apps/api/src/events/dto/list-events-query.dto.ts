import { ApiPropertyOptional } from "@nestjs/swagger";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from "class-validator";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Query parameters for GET /events.
 *
 * Every filter is optional; omitting all of them lists the most recent events
 * across all employees.
 */
export class ListEventsQueryDto {
  @ApiPropertyOptional({
    description: "Only return events for this employee.",
    format: "uuid",
    example: "3f6d0a2c-9c3a-4a1e-9f4a-2b8d6c1e5a70",
  })
  @IsOptional()
  @IsUUID("4", { message: "employeeId must be a valid UUID" })
  employeeId?: string;

  @ApiPropertyOptional({
    description: "Only return events in this status.",
    enum: PayrollEventStatus,
    example: PayrollEventStatus.PENDING,
  })
  @IsOptional()
  @IsEnum(PayrollEventStatus, {
    message: `status must be one of: ${Object.values(PayrollEventStatus).join(", ")}`,
  })
  status?: PayrollEventStatus;

  @ApiPropertyOptional({
    description: "Only return events of this type.",
    enum: PayrollEventType,
    example: PayrollEventType.SALARY_CHANGE,
  })
  @IsOptional()
  @IsEnum(PayrollEventType, {
    message: `eventType must be one of: ${Object.values(PayrollEventType).join(", ")}`,
  })
  eventType?: PayrollEventType;

  @ApiPropertyOptional({
    description: "1-based page number.",
    minimum: 1,
    default: 1,
    example: 1,
  })
  @IsOptional()
  // Query strings arrive as strings; convert before the numeric rules run.
  @Type(() => Number)
  @IsInt({ message: "page must be an integer" })
  @Min(1, { message: "page must be at least 1" })
  page?: number = 1;

  @ApiPropertyOptional({
    description: `Items per page (max ${MAX_PAGE_SIZE}).`,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    example: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "pageSize must be an integer" })
  @Min(1, { message: "pageSize must be at least 1" })
  // Capped rather than silently clamped: an unbounded page size is a trivial
  // way to pull the whole table in one request.
  @Max(MAX_PAGE_SIZE, { message: `pageSize must be at most ${MAX_PAGE_SIZE}` })
  pageSize?: number = DEFAULT_PAGE_SIZE;
}
