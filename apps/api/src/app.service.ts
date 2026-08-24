import { Injectable } from "@nestjs/common";
import { EventStatus } from "@payroll/shared";

@Injectable()
export class AppService {
  getHello(): string {
    return `Hello World from Payroll API (default event status: ${EventStatus.PENDING})`;
  }
}
