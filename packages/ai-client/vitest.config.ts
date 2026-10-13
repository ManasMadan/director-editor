import { coverage } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { coverage: coverage() } });
