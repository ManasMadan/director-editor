import { applyTestEnvironment } from "@repo/testing/environment";
import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

// .env.example's values (not the developer's .env), before global setup and the workers.
applyTestEnvironment();

export default defineConfig({
  test: {
    coverage: coverage(),
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    // Cloning the template waits while another package's run prepares it.
    hookTimeout: 60_000,
  },
});
