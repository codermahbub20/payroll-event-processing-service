import {
  PayrollEventStatus as DbStatus,
  PayrollEventType as DbType,
} from "@payroll/database";
import {
  PayrollEventStatus as SharedStatus,
  PayrollEventType as SharedType,
} from "@payroll/shared";

/**
 * EventsService casts between the Prisma-generated enums (string-literal
 * unions) and the shared TypeScript enums. That cast is only sound while both
 * sides hold exactly the same values, and TypeScript cannot check it — so it
 * is asserted here. If a value is added to schema.prisma without mirroring it
 * in packages/shared (or vice versa), this fails instead of the mismatch
 * surfacing as a runtime bug on the write path.
 */
describe("[unit] enum parity between @payroll/database and @payroll/shared", () => {
  it("PayrollEventStatus has identical values", () => {
    expect(Object.values(SharedStatus).sort()).toEqual(
      Object.values(DbStatus).sort(),
    );
  });

  it("PayrollEventType has identical values", () => {
    expect(Object.values(SharedType).sort()).toEqual(
      Object.values(DbType).sort(),
    );
  });
});
