/**
 * Three projects:
 * - `unit`: `src/**\/*.test.{ts,tsx}` in Node, no services (helpers, the proxy, route
 *   files and server components);
 * - `browser` and `browser (features off)`: `test/**\/*.test.tsx`, pages and components
 *   rendered in Chromium against the real API (test/global-setup.ts), one with every
 *   optional feature on and one with them off (`*.features-off.test.tsx`).
 * The browser reaches the API on its own origin (`/rpc`, `/api`), proxied here the way the
 * gateway routes it when deployed.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyTestEnvironment } from "@repo/testing/environment";
import { coverage, tags } from "@repo/vitest-config";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";
import { commands } from "./test/commands";
import { API, SITE } from "./test/services";

// .env.example's values (not the developer's .env): next.config.ts and the API read them.
applyTestEnvironment();

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

const browserProject = (
  name: string,
  services: "full" | "bare",
  include: string[],
  exclude: string[] = [],
) => ({
  resolve: { alias },
  // React's automatic runtime (Next compiles JSX the same way).
  oxc: { jsx: { runtime: "automatic" as const } },
  server: {
    proxy: { "/rpc": API[services].url, "/api": API[services].url },
  },
  // Every dependency the app uses, bundled before the first test: one found later makes
  // Vite reload the page mid-run.
  // (Not the server-only files: the root layout's fonts exist only in Next's compiler.)
  optimizeDeps: {
    entries: ["src/**/*.tsx", "test/**/*.tsx", "!src/app/layout.tsx", "!src/**/*.test.tsx"],
  },
  test: {
    name,
    include,
    exclude: [...configDefaults.exclude, ...exclude],
    tags,
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/process.ts", "./test/setup.ts"],
    testTimeout: 30_000,
    // Real requests (captcha checks) can take a few seconds.
    expect: { poll: { timeout: 10_000 } },
    // The test pages' server, on the site's origin as the API knows it (test/services.ts).
    api: { port: SITE[services].port, strictPort: true },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" as const }],
      commands,
    },
  },
});

export default defineConfig({
  test: {
    coverage: coverage(),
    projects: [
      {
        resolve: {
          alias: {
            ...alias,
            // What next-intl's Next.js plugin sets up: the request config, and the server
            // build of its functions (Next renders server components with react-server).
            "next-intl/config": fileURLToPath(new URL("./src/i18n/request.ts", import.meta.url)),
            "next-intl/server": join(
              dirname(createRequire(import.meta.url).resolve("next-intl/config")),
              "server.react-server.js",
            ),
          },
        },
        oxc: { jsx: { runtime: "automatic" as const } },
        test: {
          name: "unit",
          include: ["src/**/*.test.{ts,tsx}", "*.test.ts"],
          setupFiles: ["./test/next-server.ts"],
          // Bundled like Next does, so the aliases above and next/font's stand-in
          // (test/next-server.ts) apply inside these packages too.
          server: { deps: { inline: ["next-intl", "geist"] } },
          // e2e/ is Playwright's (bun run test:e2e).
          exclude: [...configDefaults.exclude, "e2e/**"],
        },
      },
      browserProject(
        "browser",
        "full",
        ["test/**/*.test.tsx"],
        ["test/**/*.features-off.test.tsx"],
      ),
      browserProject("browser (features off)", "bare", ["test/**/*.features-off.test.tsx"]),
    ],
  },
});
