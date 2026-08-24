/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/src", "<rootDir>/test"],
  testRegex: ".*\\.(spec|e2e-spec)\\.ts$",
  moduleFileExtensions: ["ts", "js", "json"],
  setupFiles: ["<rootDir>/test/setup.ts"],
  moduleNameMapper: {
    "^@payroll/shared$": "<rootDir>/../../packages/shared/src/index.ts",
    "^@payroll/database$": "<rootDir>/../../packages/database/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.spec.json" }],
  },
  testTimeout: 30000,
};
