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
  // Redis startup plus ordering assertions need headroom.
  testTimeout: 120000,

  collectCoverageFrom: [
    "src/**/*.ts",
    // Composition roots and type-only modules: exercised indirectly by every
    // integration test, but asserting on them directly tests the framework
    // rather than our logic.
    "!src/main.ts",
    "!src/worker.module.ts",
    "!src/**/*.d.ts",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text-summary", "lcov", "json-summary"],
  coverageThreshold: {
    /**
     * The bar is set on the modules that carry real decision-making, not on
     * the package average — an average lets thin, well-covered files mask a
     * gap in the code that actually decides whether money moves.
     */
    "./src/processing/validation.ts": {
      statements: 95,
      branches: 90,
      functions: 95,
      lines: 95,
    },
    // Branches sit at 70% because the remainder are constructor default
    // parameters (`context = {}`, optional `code`) that every real call site
    // supplies explicitly. Covering them would mean asserting that a default
    // is a default — the boilerplate chasing this threshold is meant to avoid.
    "./src/processing/errors.ts": {
      statements: 90,
      branches: 70,
      functions: 85,
      lines: 90,
    },
    "./src/processor/event-processor.ts": {
      statements: 85,
      branches: 70,
      functions: 85,
      lines: 85,
    },
    "./src/processor/recovery-sweep.ts": {
      statements: 80,
      branches: 65,
      functions: 80,
      lines: 80,
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
