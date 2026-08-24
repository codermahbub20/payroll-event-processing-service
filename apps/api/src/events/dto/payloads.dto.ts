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
  @IsString()
  @IsNotEmpty()
  @IsIBAN(undefined, { message: "iban must be a valid IBAN" })
  iban!: string;
}

export class AddressChangePayloadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  street!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  city!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  postalCode!: string;

  /**
   * ISO 3166-1 alpha-2, validated against the real code list so downstream
   * systems never have to guess between "DE", "Germany" and "GER".
   */
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
  @IsInt({ message: "newSalary must be an integer amount in minor units (cents)" })
  @IsPositive()
  newSalary!: number;

  @IsString()
  @IsISO4217CurrencyCode({ message: "currency must be an ISO 4217 code (e.g. EUR)" })
  currency!: string;
}
