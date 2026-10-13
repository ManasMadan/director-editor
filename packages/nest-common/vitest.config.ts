/**
 * Two projects: `unit` (src/, no services needed) and `integration` (test/, against
 * the docker compose Postgres, Redis and RustFS).
 */
import { applyTestEnvironment } from "@repo/testing/environment";
import { coverage, decoratorMetadata, tags } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

// .env.example's values (not the developer's .env), before global setup and the workers.
applyTestEnvironment();

export default defineConfig({
  plugins: [decoratorMetadata()],
  test: {
    coverage: coverage(),
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"] } },
      {
        test: {
          name: "integration",
          include: ["test/**/*.test.ts"],
          tags,
          // A file that needs a database clones its own from the migrated template.
          globalSetup: ["./test/global-setup.ts"],
          hookTimeout: 60_000,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
