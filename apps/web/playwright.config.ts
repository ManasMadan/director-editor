/**
 * End-to-end tests: a real browser against the whole stack (web, api, worker,
 * notifications, webhooks, the AI service, with Mailpit catching email).
 * `bun run test:e2e` at the root builds the stack, starts it fresh, runs this suite and
 * stops it (scripts/e2e.ts), locally and in CI. `bun run test:e2e` in apps/web runs the
 * suite against a stack that is already running, such as `bun dev`.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Each step crosses browser, Next, the API, Postgres, Redis and sometimes the email
  // queue; under parallel load 5s (the default) is too tight for that round trip.
  expect: { timeout: 10_000 },
  // Multi-device flows (invite by email, accept, switch) take several round trips.
  timeout: 60_000,
  fullyParallel: true,
  // Each worker drives up to two browsers against one machine running the whole stack;
  // more than this starves the services and measures the laptop, not the app.
  workers: process.env.CI ? 2 : 4,
  forbidOnly: Boolean(process.env.CI),
  // Retried in CI to tell a flaky test from a broken one, but a test that only passed on
  // a retry still fails the run: retries alone would hide it.
  retries: process.env.CI ? 2 : 0,
  failOnFlakyTests: Boolean(process.env.CI),
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    // The site's origin (the root .env's WEB_URL, or the e2e run's).
    baseURL: process.env.E2E_BASE_URL ?? process.env.WEB_URL,
    trace: "retain-on-failure",
    locale: "en-US",
    // Matches the server's default zone, so the first page load doesn't refresh to
    // record a different one (a test in platform.spec.ts covers that path).
    timezoneId: "UTC",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
