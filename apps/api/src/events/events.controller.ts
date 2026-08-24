import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from "@nestjs/common";
import { PayrollEventStatus } from "@payroll/shared";
import type { Response } from "express";
import { CreateEventDto } from "./dto/create-event.dto";
import { EventsService } from "./events.service";
import { MAX_IDEMPOTENCY_KEY_LENGTH } from "./idempotency";

/** Response body for POST /events. */
export interface SubmitEventResponse {
  id: string;
  status: PayrollEventStatus;
  duplicate: boolean;
}

@Controller("events")
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  /**
   * Submits a payroll event for asynchronous processing.
   *
   * 202 Accepted — new event persisted and queued.
   * 200 OK       — idempotency key already seen; the existing event is
   *                returned and no new job is enqueued.
   *
   * The status code is set imperatively because it depends on whether the
   * submission turned out to be a duplicate, which is only known after the
   * service runs.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
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

    res.status(result.duplicate ? HttpStatus.OK : HttpStatus.ACCEPTED);

    return {
      id: result.id,
      status: result.status,
      duplicate: result.duplicate,
    };
  }
}
