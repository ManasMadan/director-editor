/**
 * Two projects: `unit` (src/, no services needed) and `integration` (test/, against
 * the docker compose Valkey).
 */
import { applyTestEnvironment } from "@repo/testing/environment";
import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

// .env.example's values (not the developer's .env), before global setup and the workers.
applyTestEnvironment();

export default defineConfig({
  test: {
    coverage: coverage(),
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"] } },
      { test: { name: "integration", include: ["test/**/*.test.ts"], testTimeout: 20_000 } },
    ],
  },
});
