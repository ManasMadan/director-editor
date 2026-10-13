import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["test/setup.ts"], coverage: coverage() },
});
