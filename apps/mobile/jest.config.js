/**
 * Unit and component tests (React Native Testing Library) on jest-expo's React Native
 * preset. The shared packages ship TypeScript source and are compiled like app code.
 */
module.exports = {
  preset: "jest-expo",
  // e2e/ is Playwright's (bun run test:e2e).
  roots: ["<rootDir>/src"],
  setupFiles: ["./jest.setup.ts"],
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1", "\\.css$": "<rootDir>/test/style.js" },
  // Several dependencies ship only ES modules as .mjs (oRPC); Babel compiles them too.
  transform: { "\\.mjs$": "babel-jest" },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "json"],
  // Compile every dependency: more and more ship only ES modules (oRPC, use-intl's
  // formatters), and an allowlist would break each time one does. Babel caches the result.
  transformIgnorePatterns: [],
  // Every source file, screens included, at 100%: only this suite runs the app's code, so
  // its own numbers are the whole story (scripts/coverage.ts checks them again, merged).
  collectCoverageFrom: ["src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"],
  coverageReporters: ["text-summary", "lcov"],
  coverageThreshold: { global: { branches: 100, functions: 100, lines: 100, statements: 100 } },
};
