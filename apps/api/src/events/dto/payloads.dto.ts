import { ApiProperty } from "@nestjs/swagger";
import {
  IsIBAN,
  IsISO31661Alpha2,
  IsISO4217CurrencyCode,
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  MaxLength,
} from "class-validator";

/**
 * One class per event type. Each is validated independently — the union is
 * resolved in CreateEventDto via a discriminator on `eventType`.
 *
 * These classes carry ONLY type-specific fields. `employeeId` and
 * `effectiveDate` are common to all three and live on the envelope, matching
 * the real columns on `payroll_events`.
 */

export class BankAccountChangePayloadDto {
  /**
   * Validated as a real IBAN rather than a loose string: a malformed account
   * number that reaches the payroll provider is a failed (or misdirected)
   * payment, and the checksum is cheap to verify here at the boundary.
   */
  @ApiProperty({
    description: "Destination account, validated with an IBAN checksum.",
    example: "DE89370400440532013000",
  })
  @IsString()
  @IsNotEmpty()
  @IsIBAN(undefined, { message: "iban must be a valid IBAN" })
  iban!: string;
}

export class AddressChangePayloadDto {
  @ApiProperty({ maxLength: 255, example: "Hauptstrasse 1" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  street!: string;

  @ApiProperty({ maxLength: 128, example: "Berlin" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  city!: string;

  @ApiProperty({ maxLength: 32, example: "10115" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  postalCode!: string;

  /**
   * ISO 3166-1 alpha-2, validated against the real code list so downstream
   * systems never have to guess between "DE", "Germany" and "GER".
   */
  @ApiProperty({
    description: "ISO 3166-1 alpha-2 country code.",
    minLength: 2,
    maxLength: 2,
    example: "DE",
  })
  @IsString()
  @IsISO31661Alpha2({
    message: "country must be an ISO 3166-1 alpha-2 code (e.g. DE)",
  })
  country!: string;
}

export class SalaryChangePayloadDto {
  /**
   * Integer minor units (cents), not a float. Binary floating point cannot
   * represent most decimal amounts exactly, and silent rounding in a payroll
   * system is a real-money defect.
   */
  @ApiProperty({
    description:
      "New salary in integer MINOR units (e.g. cents). 75000.00 EUR is 7500000. " +
      "Integer rather than decimal to avoid floating-point rounding on money.",
    minimum: 1,
    example: 7500000,
  })
  @IsInt({ message: "newSalary must be an integer amount in minor units (cents)" })
  @IsPositive()
  newSalary!: number;

  @ApiProperty({
    description: "ISO 4217 currency code.",
    example: "EUR",
  })
  @IsString()
  @IsISO4217CurrencyCode({ message: "currency must be an ISO 4217 code (e.g. EUR)" })
  currency!: string;
}
