/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/src", "<rootDir>/test"],
  // Three suffixes, matching the three tiers: *.spec (unit),
  // *.integration-spec, *.e2e-spec. See docs/testing-strategy.md.
  testRegex: ".*\\.(spec|integration-spec|e2e-spec)\\.ts$",
  moduleFileExtensions: ["ts", "js", "json"],
  setupFiles: ["<rootDir>/test/setup.ts"],
  moduleNameMapper: {
    "^@payroll/shared$": "<rootDir>/../../packages/shared/src/index.ts",
    "^@payroll/database$": "<rootDir>/../../packages/database/src/index.ts",
    "^@payroll/queue$": "<rootDir>/../../packages/queue/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.spec.json" }],
  },
  testTimeout: 30000,

  collectCoverageFrom: [
    "src/**/*.ts",
    // Bootstrap and DI wiring: running them proves Nest works, not that our
    // logic does. The integration suites already exercise them end to end.
    "!src/main.ts",
    "!src/app.module.ts",
    "!src/**/*.module.ts",
    "!src/common/swagger.ts",
    "!src/**/*.d.ts",
    // Response DTOs are declarations with @ApiProperty decorators and no
    // behaviour; their correctness is asserted against the generated OpenAPI
    // document instead, which is the thing that can actually be wrong.
    "!src/events/dto/event-response.dto.ts",
    // Thin adapter onto Nest's LoggerService: runs on every app boot but has
    // no branching worth asserting — testing it would test Nest's interface.
    "!src/common/nest-json-logger.ts",
    // The REAL BullMQ producer. API tests inject a fake (they must not need a
    // broker), so its genuine behaviour is proven by the worker's e2e suite
    // instead, which drives it against a real Redis.
    "!src/queue/bull-event-queue.ts",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text-summary", "lcov", "json-summary"],
  coverageThreshold: {
    /**
     * Per-file bars on the modules that carry real decision-making. A package
     * average would let well-covered thin files hide a gap in the code that
     * decides whether an event is accepted.
     */
    "./src/events/events.service.ts": {
      statements: 85,
      branches: 70,
      functions: 85,
      lines: 85,
    },
    // 94.4% — the single uncovered line is a defensive branch in the
    // canonicaliser for a shape the DTO layer already rejects.
    "./src/events/idempotency.ts": {
      statements: 90,
      branches: 90,
      functions: 95,
      lines: 90,
    },
    "./src/events/dto/create-event.dto.ts": {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90,
    },
    "./src/common/all-exceptions.filter.ts": {
      statements: 85,
      branches: 75,
      functions: 85,
      lines: 85,
    },
    // Floor for everything else.
    global: {
      statements: 75,
      branches: 65,
      functions: 75,
      lines: 75,
    },
  },
};
