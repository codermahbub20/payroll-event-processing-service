import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import {
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { HealthReport, HealthService } from "./health.service";

class DependencyCheckDto {
  @ApiProperty({ enum: ["up", "down"], example: "up" })
  status!: "up" | "down";

  @ApiProperty({ description: "Probe round-trip time.", example: 3 })
  latencyMs!: number;

  @ApiProperty({ required: false, description: "Present when down." })
  error?: string;

  @ApiProperty({
    required: false,
    type: "object",
    additionalProperties: true,
    description: "Probe extras, e.g. queue job counts.",
  })
  details?: Record<string, unknown>;
}

class HealthReportDto {
  @ApiProperty({
    enum: ["ok", "degraded"],
    description: "`degraded` when any dependency is down.",
    example: "ok",
  })
  status!: "ok" | "degraded";

  @ApiProperty({ format: "date-time" })
  timestamp!: string;

  @ApiProperty({ example: 1234 })
  uptimeSeconds!: number;

  @ApiProperty({
    type: "object",
    additionalProperties: { $ref: "#/components/schemas/DependencyCheckDto" },
    description: "Per-dependency breakdown: postgres, redis, queue.",
  })
  checks!: Record<string, DependencyCheckDto>;
}

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Liveness/readiness probe.
   *
   * 200 when every dependency is reachable, 503 when any is down — so a load
   * balancer or Kubernetes readiness probe can drain this instance. The body
   * is identical in both cases, because an operator debugging a 503 needs the
   * same breakdown as one confirming a 200.
   */
  @Get()
  @ApiOperation({
    summary: "Service health",
    description:
      "Checks Postgres connectivity, Redis connectivity and BullMQ queue " +
      "reachability. Returns **200** when all are up and **503** when any is " +
      "down, with a per-dependency breakdown in both cases.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "All dependencies reachable.",
    type: HealthReportDto,
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: "At least one dependency is down.",
    type: HealthReportDto,
  })
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthReport> {
    const report = await this.healthService.check();

    res.status(
      report.status === "ok"
        ? HttpStatus.OK
        : HttpStatus.SERVICE_UNAVAILABLE,
    );

    return report;
  }
}
