import {
  BadRequestException,
  ValidationError,
  ValidationPipe,
} from "@nestjs/common";

/** Flattens nested class-validator errors into `field: message` strings. */
export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = "",
): string[] {
  return errors.flatMap((error) => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map(
      (message) => `${path}: ${message}`,
    );
    const nested = error.children?.length
      ? flattenValidationErrors(error.children, path)
      : [];
    return [...own, ...nested];
  });
}

/**
 * Global validation pipe.
 *
 * `whitelist` strips unknown properties and `forbidNonWhitelisted` turns them
 * into an error, so a typo'd field is reported rather than silently ignored —
 * on a payroll write path a dropped field is worse than a rejected request.
 */
export function buildValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    stopAtFirstError: false,
    exceptionFactory: (errors: ValidationError[]) =>
      new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
        details: flattenValidationErrors(errors),
      }),
  });
}
