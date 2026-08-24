import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config for the whole workspace.
 *
 * Deliberately scoped to rules that catch *defects* rather than style. The
 * project has no formatter-driven style debate to settle, and a CI job that
 * fails on quote marks trains people to ignore it. Type-aware linting is off:
 * it requires a full type-check per package and `tsc --noEmit` already does
 * that in the same CI job, so enabling it would double the slowest step to
 * re-report the same errors.
 */
export default tseslint.config(
  {
    // Build output, dependencies, and generated artefacts.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.prisma/**",
      "packages/database/prisma/migrations/**",
      "apps/frontend/dist/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---- Node services (api, worker, shared packages) ----
  {
    files: ["apps/api/**/*.ts", "apps/worker/**/*.ts", "packages/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    rules: {
      // `_`-prefixed args are an intentional "unused on purpose" marker.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Warn, not error: a handful of deliberate `as never` casts exist at the
      // Prisma jsonb boundary where the generated types are stricter than the
      // runtime contract.
      "@typescript-eslint/no-explicit-any": "warn",
      // A floating promise in a worker silently swallows failures.
      "no-console": "off",
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },

  // ---- Frontend (browser globals, React) ----
  {
    files: ["apps/frontend/**/*.ts", "apps/frontend/**/*.tsx"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // ---- Tests ----
  {
    files: ["**/*.spec.ts", "**/*.integration-spec.ts", "**/*.e2e-spec.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      // Test doubles legitimately need casts the production types forbid.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },

  // ---- Config files ----
  {
    files: ["**/*.config.js", "**/*.config.mjs", "**/jest.config.js"],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
