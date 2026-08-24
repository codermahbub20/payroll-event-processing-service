import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiExtraModels,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { PayrollEventStatus, PayrollEventType } from "@payroll/shared";
import type { Response } from "express";
import { CreateEventDto } from "./dto/create-event.dto";
import {
  ErrorResponseDto,
  EventDetailDto,
  PaginatedEventsDto,
} from "./dto/event-response.dto";
import { ListEventsQueryDto } from "./dto/list-events-query.dto";
import {
  AddressChangePayloadDto,
  BankAccountChangePayloadDto,
  SalaryChangePayloadDto,
} from "./dto/payloads.dto";
import { EventsService } from "./events.service";
import { MAX_IDEMPOTENCY_KEY_LENGTH } from "./idempotency";

/** Stable employee id used across every documented example. */
const EXAMPLE_EMPLOYEE_ID = "3f6d0a2c-9c3a-4a1e-9f4a-2b8d6c1e5a70";

/** Response body for POST /events. */
export class SubmitEventResponse {
  @ApiProperty({
    format: "uuid",
    description: "Id of the created (or existing) event.",
    example: "9c3a4a1e-2b8d-4c1e-9f4a-3f6d0a2c5a70",
  })
  id!: string;

  @ApiProperty({ enum: PayrollEventStatus, example: PayrollEventStatus.PENDING })
  status!: PayrollEventStatus;

  @ApiProperty({
    description:
      "True when the idempotency key was already known, meaning this request " +
      "returned an existing event and enqueued no new work.",
    example: false,
  })
  duplicate!: boolean;
}

@ApiTags("events")
// The payload DTOs are referenced only via `oneOf`/`$ref` from CreateEventDto,
// so they are not reachable by Swagger's normal type scanning and must be
// registered explicitly or their schemas resolve to dangling refs.
@ApiExtraModels(
  BankAccountChangePayloadDto,
  AddressChangePayloadDto,
  SalaryChangePayloadDto,
)
@Controller("events")
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Submit a payroll event",
    description:
      "Validates the event against the schema for its `eventType`, persists it " +
      "with status PENDING, and enqueues it for asynchronous processing.\n\n" +
      "Idempotency: supply an `Idempotency-Key` header to make retries safe. " +
      "If omitted, a key is derived deterministically from the request body " +
      "(employeeId + eventType + effectiveDate + payload), so an identical " +
      "resubmission is recognised as a duplicate rather than creating a second " +
      "event.\n\n" +
      "Returns **202** when a new event was created, or **200** when the " +
      "idempotency key was already known — in which case the existing event is " +
      "returned and no new job is enqueued.\n\n" +
      "Note on **422**: this endpoint does not use it. Unknown `eventType` and " +
      "payload/type mismatches are reported as **400**, so clients handle one " +
      "status code for every request-shape problem, with the specific failure " +
      "in `details`.",
  })
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description:
      `Client-supplied dedup key (max ${MAX_IDEMPOTENCY_KEY_LENGTH} chars). ` +
      "Reuse the same value when retrying a request.",
    schema: { type: "string", maxLength: MAX_IDEMPOTENCY_KEY_LENGTH },
  })
  // Generic @ApiResponse, not @ApiCreatedResponse: the latter hardcodes 201
  // and ignores a `status` override, which would document a code this
  // endpoint never returns.
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description: "Event accepted, persisted as PENDING and queued.",
    type: SubmitEventResponse,
  })
  @ApiOkResponse({
    description:
      "Idempotency key already seen. The existing event is returned and no " +
      "new job was enqueued.",
    type: SubmitEventResponse,
  })
  // Named examples, one per event type. Without these Swagger UI prefills the
  // single `example` from the payload schema, so "Try it out" only ever
  // demonstrates one event type and a reviewer has to guess the other two.
  @ApiBody({
    type: CreateEventDto,
    examples: {
      bankAccountChange: {
        summary: "BANK_ACCOUNT_CHANGE",
        description: "Update an employee's payment account. IBAN is checksum-validated.",
        value: {
          eventType: PayrollEventType.BANK_ACCOUNT_CHANGE,
          employeeId: EXAMPLE_EMPLOYEE_ID,
          effectiveDate: "2026-09-01",
          payload: { iban: "DE89370400440532013000" },
        },
      },
      addressChange: {
        summary: "ADDRESS_CHANGE",
        description: "Update an employee's registered address.",
        value: {
          eventType: PayrollEventType.ADDRESS_CHANGE,
          employeeId: EXAMPLE_EMPLOYEE_ID,
          effectiveDate: "2026-09-01",
          payload: {
            street: "Hauptstrasse 1",
            city: "Berlin",
            postalCode: "10115",
            country: "DE",
          },
        },
      },
      salaryChange: {
        summary: "SALARY_CHANGE",
        description:
          "Update an employee's salary. `newSalary` is in integer MINOR units " +
          "(cents): 75,000.00 EUR is 7500000.",
        value: {
          eventType: PayrollEventType.SALARY_CHANGE,
          employeeId: EXAMPLE_EMPLOYEE_ID,
          effectiveDate: "2026-10-01",
          payload: { newSalary: 7500000, currency: "EUR" },
        },
      },
      invalidSalary: {
        summary: "Invalid — negative salary (returns 400)",
        description:
          "Demonstrates the error shape. A negative salary fails business " +
          "validation, so this would also fail permanently in the worker.",
        value: {
          eventType: PayrollEventType.SALARY_CHANGE,
          employeeId: EXAMPLE_EMPLOYEE_ID,
          effectiveDate: "2026-10-01",
          payload: { newSalary: -1, currency: "EUR" },
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      "Validation failed — malformed body, unknown eventType, or a payload " +
      "that does not match its eventType. Field-level failures are listed in " +
      "`details`.",
    type: ErrorResponseDto,
  })
  async create(
    @Body() dto: CreateEventDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmitEventResponse> {
    if (
      typeof idempotencyKey === "string" &&
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      throw new BadRequestException(
        `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      );
    }

    const result = await this.eventsService.submit(dto, idempotencyKey);

    // Set imperatively: whether this was a duplicate is only known after the
    // service runs, and it changes the status code.
    res.status(result.duplicate ? HttpStatus.OK : HttpStatus.ACCEPTED);

    return {
      id: result.id,
      status: result.status,
      duplicate: result.duplicate,
    };
  }

  @Get()
  @ApiOperation({
    summary: "List payroll events",
    description:
      "Paginated list of submitted events, newest first. All filters are " +
      "optional and combine with AND.",
  })
  @ApiOkResponse({
    description: "A page of matching events.",
    type: PaginatedEventsDto,
  })
  @ApiBadRequestResponse({
    description: "Invalid query parameters (bad UUID, unknown status, etc).",
    type: ErrorResponseDto,
  })
  async list(@Query() query: ListEventsQueryDto): Promise<PaginatedEventsDto> {
    return this.eventsService.findMany(query);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get a payroll event",
    description:
      "Full detail for one event, including its payload and complete " +
      "status-transition timeline.\n\n" +
      "`failure` and `result` surface the most recent failing and succeeding " +
      "transitions respectively, so callers do not have to scan `history` " +
      "themselves.",
  })
  @ApiParam({
    name: "id",
    format: "uuid",
    description: "Event id returned by POST /events.",
  })
  @ApiOkResponse({ description: "The event.", type: EventDetailDto })
  @ApiNotFoundResponse({
    description: "No event exists with that id.",
    type: ErrorResponseDto,
  })
  @ApiBadRequestResponse({
    description: "The id is not a valid UUID.",
    type: ErrorResponseDto,
  })
  async findOne(
    // Rejects a malformed id as 400 before it reaches the database, so a
    // garbage path segment cannot surface as a driver-level error. The
    // exception factory matches the global pipe's body shape, so clients see
    // one error format across every 400 this API returns.
    @Param(
      "id",
      new ParseUUIDPipe({
        version: "4",
        exceptionFactory: () =>
          new BadRequestException({
            statusCode: HttpStatus.BAD_REQUEST,
            error: "Bad Request",
            message: "Validation failed",
            details: ["id: id must be a valid UUID"],
          }),
      }),
    )
    id: string,
  ): Promise<EventDetailDto> {
    return this.eventsService.findOne(id);
  }
}
