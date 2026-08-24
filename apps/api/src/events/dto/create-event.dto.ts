import { ApiProperty, getSchemaPath } from "@nestjs/swagger";
import { PayrollEventType } from "@payroll/shared";
import { plainToInstance } from "class-transformer";
import {
  IsDateString,
  IsDefined,
  IsEnum,
  IsObject,
  IsUUID,
  ValidateBy,
  ValidationArguments,
  ValidationOptions,
  validateSync,
} from "class-validator";
import {
  AddressChangePayloadDto,
  BankAccountChangePayloadDto,
  SalaryChangePayloadDto,
} from "./payloads.dto";

/** Maps each discriminator value to the DTO class that validates its payload. */
export const PAYLOAD_DTO_BY_EVENT_TYPE = {
  [PayrollEventType.BANK_ACCOUNT_CHANGE]: BankAccountChangePayloadDto,
  [PayrollEventType.ADDRESS_CHANGE]: AddressChangePayloadDto,
  [PayrollEventType.SALARY_CHANGE]: SalaryChangePayloadDto,
} as const;

export type AnyPayloadDto =
  | BankAccountChangePayloadDto
  | AddressChangePayloadDto
  | SalaryChangePayloadDto;

/**
 * Validates `payload` against the DTO class selected by the sibling
 * `eventType` field.
 *
 * Why not class-transformer's `@Type({ discriminator })`: that mechanism reads
 * the discriminator from a property INSIDE the nested object, whereas ours
 * lives on the parent envelope. Verified empirically — with the discriminator
 * on the parent, class-transformer leaves `payload` as a plain Object and
 * every nested rule is silently skipped. The same silent pass-through happens
 * for an unrecognised discriminator value. Both are exactly the
 * fail-open behaviour you cannot have on a payroll write path, so the
 * dispatch is done explicitly here instead.
 */
/**
 * Nested payload errors, keyed by the envelope being validated. A WeakMap is
 * used rather than stashing them on the object itself so the validated DTO
 * never carries scratch fields into the persistence layer.
 */
const nestedPayloadErrors = new WeakMap<object, string[]>();

function IsValidPayloadForEventType(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: "isValidPayloadForEventType",
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const eventType = (args.object as CreateEventDto).eventType;
          // Widened to a plain constructor: the map's union of specific
          // classes does not narrow to a single ClassConstructor overload.
          const PayloadClass = PAYLOAD_DTO_BY_EVENT_TYPE[
            eventType as keyof typeof PAYLOAD_DTO_BY_EVENT_TYPE
          ] as (new () => object) | undefined;

          // Unknown/missing eventType is reported by @IsEnum on that field;
          // returning true here avoids a confusing duplicate error.
          if (!PayloadClass) return true;

          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return false;
          }

          const instance = plainToInstance(PayloadClass, value);
          const errors = validateSync(instance as object, {
            whitelist: true,
            // Reject fields that belong to a different event type, so a
            // SALARY_CHANGE carrying an `iban` is a 400 rather than a
            // silently-dropped field.
            forbidNonWhitelisted: true,
          });

          nestedPayloadErrors.set(
            args.object,
            errors.map((e) => {
              const constraints = e.constraints ?? {};
              // A wholly missing field trips every constraint on it at once
              // ("must be a string", "should not be empty", "max length"...).
              // Reporting all of them buries the actual problem, so collapse
              // to a single message in that case.
              const isMissing =
                (value as Record<string, unknown>)[e.property] === undefined;
              if (isMissing) return `${e.property} is required`;
              return Object.values(constraints).join("; ");
            }),
          );

          return errors.length === 0;
        },
        defaultMessage(args: ValidationArguments): string {
          const eventType = (args.object as CreateEventDto).eventType;
          const nested = nestedPayloadErrors.get(args.object) ?? [];
          const detail = nested.length ? `: ${nested.join("; ")}` : "";
          return `payload is invalid for eventType ${eventType}${detail}`;
        },
      },
    },
    options,
  );
}

/**
 * Request body for POST /events.
 *
 * Polymorphic validation: `eventType` selects which payload DTO the nested
 * `payload` object is validated against, so each event type enforces exactly
 * its own required fields and rejects fields belonging to other types.
 */
export class CreateEventDto {
  @ApiProperty({
    enum: PayrollEventType,
    description:
      "Determines which schema `payload` is validated against.",
    example: PayrollEventType.BANK_ACCOUNT_CHANGE,
  })
  @IsEnum(PayrollEventType, {
    message: `eventType must be one of: ${Object.values(PayrollEventType).join(", ")}`,
  })
  eventType!: PayrollEventType;

  @ApiProperty({
    format: "uuid",
    description: "Employee the change applies to.",
    example: "3f6d0a2c-9c3a-4a1e-9f4a-2b8d6c1e5a70",
  })
  @IsUUID("4", { message: "employeeId must be a valid UUID" })
  employeeId!: string;

  /**
   * Calendar date (YYYY-MM-DD) the change takes effect. `strict` rejects
   * impossible dates such as 2026-02-30 that a lenient parser would roll over.
   */
  @ApiProperty({
    description:
      "Calendar date the change takes effect (YYYY-MM-DD). Impossible dates " +
      "such as 2026-02-30 are rejected.",
    example: "2026-09-01",
  })
  @IsDateString(
    { strict: true, strictSeparator: true },
    { message: "effectiveDate must be an ISO-8601 date (YYYY-MM-DD)" },
  )
  effectiveDate!: string;

  /**
   * Documented as a `oneOf` union: the concrete schema is selected at runtime
   * by `eventType`, which Swagger cannot infer from the custom validator.
   */
  @ApiProperty({
    description:
      "Type-specific fields. Which schema applies is determined by `eventType`: " +
      "BANK_ACCOUNT_CHANGE -> { iban }, " +
      "ADDRESS_CHANGE -> { street, city, postalCode, country }, " +
      "SALARY_CHANGE -> { newSalary, currency }. " +
      "Fields belonging to another event type are rejected.",
    oneOf: [
      { $ref: getSchemaPath(BankAccountChangePayloadDto) },
      { $ref: getSchemaPath(AddressChangePayloadDto) },
      { $ref: getSchemaPath(SalaryChangePayloadDto) },
    ],
    example: { iban: "DE89370400440532013000" },
  })
  @IsDefined({ message: "payload is required" })
  @IsObject({ message: "payload must be an object" })
  @IsValidPayloadForEventType()
  payload!: AnyPayloadDto;
}
