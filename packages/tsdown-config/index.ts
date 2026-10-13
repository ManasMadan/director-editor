/**
 * Build preset for every Node service.
 *
 * Output is one ESM bundle per service (`dist/main.mjs`, plus `dist/telemetry.mjs`) that inlines our own
 * `@repo/*` workspace packages (they ship TypeScript source) and leaves every npm
 * dependency external, resolved from node_modules at runtime. Keeping npm packages
 * external matters: several load files relative to themselves at runtime (BullMQ's
 * Lua scripts, pino transports, Prisma's query compiler WASM) and break when bundled.
 *
 * Decorator metadata comes from the service's tsconfig (`emitDecoratorMetadata`),
 * which Oxc honours; Nest's dependency injection depends on it.
 */
import { defineConfig, type UserConfig } from "tsdown";

export function nodeService(overrides: UserConfig = {}): UserConfig {
  return defineConfig({
    // The service, and its telemetry bootstrap (loaded first: `node --import dist/telemetry.mjs`).
    entry: ["src/main.ts", "src/telemetry.ts"],
    platform: "node",
    target: "node24",
    format: "esm",
    outDir: "dist",
    clean: true,
    sourcemap: true,
    deps: {
      // Every npm import stays a runtime import (including dependencies of workspace
      // packages), and only our own @repo/* packages are compiled into the bundle.
      neverBundle: true,
      alwaysBundle: [/^@repo\//],
    },
    ...overrides,
  });
}
